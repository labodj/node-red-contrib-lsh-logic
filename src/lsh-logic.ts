/**
 * @file This is the main entry point for the LSH Logic node in Node-RED.
 * It defines the `LshLogicNode` class, which acts as a thin adapter layer,
 * connecting the Node-RED runtime to the core `LshLogicService`.
 */
import { Node, NodeMessage, NodeAPI } from "node-red";
import * as fs from "fs/promises";
import * as chokidar from "chokidar";
import * as path from "path";
import { ValidateFunction } from "ajv";

import { LshLogicService } from "./LshLogicService";
import { createAppValidators } from "./schemas";
import { LshLogicNodeDef, LongClickConfig, Output, OutputMessages, ServiceResult } from "./types";
import { sleep } from "./utils";

/**
 * The adapter class that bridges the Node-RED environment and the LshLogicService.
 * It handles all I/O with the Node-RED runtime (receiving messages, sending messages,
 * logging, setting status) and delegates all business logic to the service.
 */
export class LshLogicNode {
  private readonly node: Node;
  private readonly config: LshLogicNodeDef;
  private readonly RED: NodeAPI;
  private readonly service: LshLogicService;

  // --- Mutable Node-RED specific state ---
  private watcher: chokidar.FSWatcher | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;

  /**
   * Creates an instance of the LshLogicNode.
   * @param node - The Node-RED node instance this class is managing.
   * @param config - The user-defined configuration for this node instance.
   * @param RED - The Node-RED runtime API object.
   */
  constructor(node: Node, config: LshLogicNodeDef, RED: NodeAPI) {
    this.node = node;
    this.config = config;
    this.RED = RED;

    // Create all validators in one go using the factory function
    const validators = createAppValidators();

    // Instantiate the core logic service, passing it dependencies
    this.service = new LshLogicService(
      {
        lshBasePath: this.config.lshBasePath,
        serviceTopic: this.config.serviceTopic,
        otherDevicesPrefix: this.config.otherDevicesPrefix,
        clickTimeout: this.config.clickTimeout,
        interrogateThreshold: this.config.interrogateThreshold,
        pingTimeout: this.config.pingTimeout,
      },
      this.getContext(this.config.otherActorsContext),
      validators // Pass the whole validators object
    );

    this.initialize(validators.validateLongClickConfig);

    // Start a timer to periodically clean up expired click transactions.
    const cleanupIntervalMs = this.config.clickCleanupInterval * 1000;
    this.cleanupInterval = setInterval(() => {
      const log = this.service.cleanupPendingClicks();
      if (log) this.node.log(log);
    }, cleanupIntervalMs);

    // Start the watchdog timer to monitor device health.
    const watchdogIntervalMs = this.config.watchdogInterval * 1000;
    this.watchdogInterval = setInterval(async () => {
      const result = this.service.runWatchdogCheck();
      await this.processServiceResult(result);
    }, watchdogIntervalMs);

    // Register handlers for Node-RED events
    this.node.on("input", (msg, _send, done) => {
      this.handleInput(msg, done);
    });

    this.node.on("close", (done: () => void) => {
      this.handleClose(done);
    });
  }

  /**
   * Initializes the node, loads the configuration file, and sets up the file watcher.
   * @param validateLongClickConfig The pre-compiled validation function for the main config.
   */
  private async initialize(validateLongClickConfig: ValidateFunction): Promise<void> {
    this.node.status({ fill: "blue", shape: "dot", text: "Initializing..." });
    try {
      const userDir = this.RED.settings.userDir || process.cwd();
      const configPath = path.resolve(userDir, this.config.longClickConfigPath);
      await this.loadLongClickConfig(configPath, validateLongClickConfig);
      this.setupFileWatcher(configPath, validateLongClickConfig);
      this.node.status({ fill: "green", shape: "dot", text: "Ready" });
      this.node.log("Node initialized and configuration loaded.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.node.error(`Critical error during initialization: ${msg}`);
      this.node.status({ fill: "red", shape: "ring", text: "Config Error" });
    }
  }

  /**
   * The main handler for all incoming messages from Node-RED.
   * It delegates processing to the service and handles the result.
   * @param msg The incoming Node-RED message.
   * @param done The callback to signal completion.
   */
  private async handleInput(msg: NodeMessage, done: (err?: Error) => void): Promise<void> {
    try {
      const result = this.service.processMessage(msg.topic || "", msg.payload);
      await this.processServiceResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.node.error(`Error processing message: ${errorMessage}`);
      done(error instanceof Error ? error : new Error(errorMessage));
      return;
    }

    this.send({ [Output.Debug]: msg });
    done();
  }

  /**
   * Takes a result from the service layer and performs the required Node-RED actions.
   * This includes logging, sending messages, and handling special cases like staggered sends.
   * @param result The ServiceResult object from a service method call.
   */
  private async processServiceResult(result: ServiceResult): Promise<void> {
    result.logs.forEach((log) => this.node.log(log));
    result.warnings.forEach((warn) => this.node.warn(warn));
    result.errors.forEach((err) => this.node.error(err));

    if (result.stateChanged) {
      this.updateExposedState();
    }

    if (Object.keys(result.messages).length > 0) {
      const lshMessages = result.messages[Output.Lsh];
      // Check if the LSH output contains an array, which indicates staggered messages
      if (Array.isArray(lshMessages) && lshMessages.length > 1) {
        this.node.log(`Sending ${lshMessages.length} messages in a staggered sequence.`);
        // Handle staggered sending here by iterating and sleeping
        for (const msg of lshMessages) {
          this.send({ [Output.Lsh]: msg });
          await sleep(Math.random() * 200 + 50);
        }
        // Remove the staggered messages from the result object so they aren't sent again by the final send call
        delete result.messages[Output.Lsh];
      }

      // Send any remaining messages (or all if no staggering was needed)
      this.send(result.messages);
    }
  }

  /**
   * Loads, parses, and validates the long-click configuration JSON file.
   * @param filePath The absolute path to the configuration file.
   * @param validateLongClickConfig The pre-compiled validation function for the main config.
   */
  private async loadLongClickConfig(filePath: string, validateLongClickConfig: ValidateFunction): Promise<void> {
    try {
      this.node.log(`Loading config from: ${filePath}`);
      const fileContent = await fs.readFile(filePath, "utf-8");
      const parsedConfig = JSON.parse(fileContent);

      if (!validateLongClickConfig(parsedConfig)) {
        const errorText = validateLongClickConfig.errors?.map(e => e.message).join(', ') || 'unknown error';
        throw new Error(`Invalid longClickConfig.json: ${errorText}`);
      }

      const logMessage = this.service.updateLongClickConfig(parsedConfig as LongClickConfig);
      this.node.log(logMessage);

    } catch (error) {
      this.service.clearLongClickConfig();
      throw error;
    } finally {
      this.updateExposedState();
      this.updateExposedConfig();
      this.updateExportedTopics();
    }
  }

  /**
   * Sets up a file watcher to hot-reload the configuration.
   * @param filePath The absolute path to the configuration file to watch.
   * @param validateLongClickConfig The pre-compiled validation function for the main config.
   */
  private setupFileWatcher(filePath: string, validateLongClickConfig: ValidateFunction): void {
    if (this.watcher) this.watcher.close();
    this.watcher = chokidar.watch(filePath);
    this.watcher.on("change", (path) => {
      this.node.log(`Configuration file changed: ${path}. Reloading...`);
      this.node.status({ fill: "yellow", shape: "dot", text: "Reloading config..." });
      this.loadLongClickConfig(path, validateLongClickConfig)
        .then(() => {
          this.node.log(`Configuration successfully reloaded from ${path}.`);
          this.node.status({ fill: "green", shape: "dot", text: "Ready" });
        })
        .catch((err) => {
          this.node.error(`Error reloading ${path}: ${err.message}`);
          this.node.status({ fill: "red", shape: "ring", text: `Config reload failed` });
        });
    });
  }

  /**
   * Sends messages to one or more node outputs.
   * @param messages An object mapping an Output enum member to the message(s) to be sent.
   */
  private send(messages: OutputMessages): void {
    const numOutputs = Object.keys(Output).length / 2;
    const outputArray: (NodeMessage | NodeMessage[] | null)[] = new Array(numOutputs).fill(null);

    // Directly map the messages to their output index
    for (const key in messages) {
      const outputIndex = Number(key);
      if (!isNaN(outputIndex) && outputIndex >= 0 && outputIndex < numOutputs) {
        outputArray[outputIndex] = messages[outputIndex as Output] || null;
      }
    }

    // Send only if at least one message is not null
    if (outputArray.some(msg => msg !== null)) {
      this.node.send(outputArray);
    }
  }

  /**
   * Cleans up resources when the node is closed or re-deployed.
   */
  private _cleanupResources(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.watcher) (this.watcher as any)?.close();
  }

  public testCleanup(): void {
    this._cleanupResources();
  }

  private async handleClose(done: () => void): Promise<void> {
    this.node.log("Closing LSH Logic node.");
    this._cleanupResources();
    done();
  }

  // --- Context Management Methods ---

  private getContext(type: "flow" | "global") {
    return type === "flow" ? this.node.context().flow : this.node.context().global;
  }

  private updateExposedState(): void {
    const { exposeStateContext, exposeStateKey } = this.config;
    if (exposeStateContext === "none" || !exposeStateKey) return;
    const exposedData = {
      devices: this.service.getDeviceRegistry(),
      lastUpdated: Date.now(),
    };
    this.getContext(exposeStateContext).set(exposeStateKey, exposedData);
  }

  private updateExposedConfig(): void {
    const { exposeConfigContext, exposeConfigKey } = this.config;
    if (exposeConfigContext === "none" || !exposeConfigKey) return;
    const exposedData = {
      nodeConfig: this.config,
      longClickConfig: this.service.getConfiguredDeviceNames() ? { devices: this.service.getConfiguredDeviceNames() } : null,
      lastUpdated: Date.now(),
    };
    this.getContext(exposeConfigContext).set(exposeConfigKey, exposedData);
  }

  private updateExportedTopics(): void {
    const { exportTopics, exportTopicsKey, lshBasePath, homieBasePath } = this.config;
    if (exportTopics === "none" || !exportTopicsKey) return;

    const deviceNames = this.service.getConfiguredDeviceNames();
    if (!deviceNames) {
      this.node.warn("Cannot generate topics: longClickConfig is not loaded.");
      return;
    }

    const lshTopics = deviceNames.map((name) => `${lshBasePath}${name}/+`);
    const homieTopics = deviceNames.map((name) => `${homieBasePath}${name}/$state`);
    const topicsToExport = {
      lsh: lshTopics,
      homie: homieTopics,
      all: [...lshTopics, ...homieTopics],
      lastUpdated: Date.now(),
    };
    this.getContext(exportTopics).set(exportTopicsKey, topicsToExport);
    this.node.log(`Exported ${topicsToExport.all.length} MQTT topics to context key '${exportTopicsKey}'.`);
  }
}

/**
 * The main module definition for Node-RED.
 */
const nodeRedModule = function (RED: NodeAPI) {
  function LshLogicNodeWrapper(this: Node, config: LshLogicNodeDef) {
    RED.nodes.createNode(this, config);
    new LshLogicNode(this, config, RED);
  }
  RED.nodes.registerType("lsh-logic", LshLogicNodeWrapper);
};

module.exports = Object.assign(nodeRedModule, { LshLogicNode, Output });