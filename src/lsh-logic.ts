/**
 * @file This is the main entry point for the LSH Logic node in Node-RED.
 * It defines the `LshLogicNode` class, which acts as a thin adapter layer,
 * connecting the Node-RED runtime to the core `LshLogicService`. This class
 * is responsible for all interactions with the Node-RED environment.
 */
import { Node, NodeMessage, NodeAPI } from "node-red";
import * as fs from "fs/promises";
import * as chokidar from "chokidar";
import * as path from "path";
import { ValidateFunction } from "ajv";

import { LshLogicService } from "./LshLogicService";
import { createAppValidators } from "./schemas";
import { LshLogicNodeDef, SystemConfig, Output, OutputMessages, ServiceResult } from "./types";
import { sleep } from "./utils";

/**
 * The adapter class that bridges the Node-RED environment and the LshLogicService.
 * It handles all I/O with the Node-RED runtime (receiving/sending messages,
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
  private initialVerificationTimer: NodeJS.Timeout | null = null;
  private finalVerificationTimer: NodeJS.Timeout | null = null;
  private isWarmingUp: boolean = false;

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

    const validators = createAppValidators();

    // Instantiate the core logic service, injecting its dependencies.
    this.service = new LshLogicService(
      {
        lshBasePath: this.config.lshBasePath,
        homieBasePath: this.config.homieBasePath,
        serviceTopic: this.config.serviceTopic,
        otherDevicesPrefix: this.config.otherDevicesPrefix,
        clickTimeout: this.config.clickTimeout,
        interrogateThreshold: this.config.interrogateThreshold,
        pingTimeout: this.config.pingTimeout,
      },
      this.getContext(this.config.otherActorsContext),
      validators
    );

    void this.initialize(validators.validateSystemConfig);
    this.setupTimers();
    this.registerNodeEventHandlers();
  }

  private async initialize(validateSystemConfig: ValidateFunction): Promise<void> {
    this.node.status({ fill: "blue", shape: "dot", text: "Initializing..." });
    try {
      const userDir = this.RED.settings.userDir || process.cwd();
      const configPath = path.resolve(userDir, this.config.systemConfigPath);

      await this.loadSystemConfig(configPath, validateSystemConfig);
      this.setupFileWatcher(configPath, validateSystemConfig);

      const startupResult = this.service.getStartupCommands();
      await this.processServiceResult(startupResult);

      this.node.status({ fill: "green", shape: "dot", text: "Ready" });
      this.node.log("Node initialized and configuration loaded.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.node.error(`Critical error during initialization: ${msg}`);
      this.node.status({ fill: "red", shape: "ring", text: "Config Error" });
    }
  }

  /**
   * Sets up all periodic timers for the node (watchdog and cleanup).
   */
  private setupTimers(): void {
    const cleanupIntervalMs = this.config.clickCleanupInterval * 1000;
    this.cleanupInterval = setInterval(() => {
      const log = this.service.cleanupPendingClicks();
      if (log) this.node.log(log);
    }, cleanupIntervalMs);

    const watchdogIntervalMs = this.config.watchdogInterval * 1000;
    this.watchdogInterval = setInterval(() => {
      // Create an async IIFE and void it to satisfy the no-misused-promises rule for setInterval.
      void (async () => {
        const result = this.service.runWatchdogCheck();
        await this.processServiceResult(result);
      })();
    }, watchdogIntervalMs);
  }

  /**
   * Registers handlers for Node-RED lifecycle events ('input' and 'close').
   */
  private registerNodeEventHandlers(): void {
    this.node.on("input", (msg, _send, done) => {
      void this.handleInput(msg, done);
    });

    this.node.on("close", (done: () => void) => {
      // Event handlers should not return promises. Use void on an async IIFE to prevent this.
      void (async () => {
        try {
          await this.handleClose();
        } catch (err) {
          this.node.error(`Error during node close: ${String(err)}`);
        } finally {
          done();
        }
      })();
    });
  }

  /**
   * The main handler for all incoming messages from Node-RED.
   * It delegates processing to the service and handles the result.
   * @param msg The incoming Node-RED message.
   * @param done The callback to signal completion to the Node-RED runtime.
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

    // Forward the original message to the debug output.
    this.send({ [Output.Debug]: msg });
    done();
  }

  /**
   * Takes a result from the service layer and performs the required Node-RED actions
   * (logging, sending messages, updating state).
   * @param result The ServiceResult object from a service method call.
   */
  public async processServiceResult(result: ServiceResult): Promise<void> {
    result.logs.forEach((log) => this.node.log(log));
    result.warnings.forEach((warn) => this.node.warn(warn));
    result.errors.forEach((err) => this.node.error(err));

    if (result.stateChanged) {
      this.updateExposedState();
    }

    if (this.isWarmingUp && result.messages[Output.Alerts]) {
      const alertMsg = result.messages[Output.Alerts] as NodeMessage;

      if (typeof alertMsg.payload === 'string' && alertMsg.payload.startsWith('✅')) {
        this.node.log("Suppressing 'device recovered' alert during warm-up period.");
        delete result.messages[Output.Alerts];
      }
    }

    if (Object.keys(result.messages).length > 0) {
      const lshMessages = result.messages[Output.Lsh];
      // A message array indicates a request for staggered sending.
      // The service layer requests this for bulk actions like pings to avoid overwhelming the network.
      if (Array.isArray(lshMessages) && lshMessages.length > 1) {
        this.node.log(`Sending ${lshMessages.length} messages in a staggered sequence.`);
        for (const msg of lshMessages) {
          this.send({ [Output.Lsh]: msg });
          // Sleep for a short, random interval to avoid a "thundering herd."
          await sleep(Math.random() * 200 + 50);
        }
        // The staggered messages have been sent, so remove them from the result object.
        delete result.messages[Output.Lsh];
      }

      // Send any remaining messages (or all if no staggering was needed).
      this.send(result.messages);
    }
  }

  /**
   * Loads, parses, and validates the `system-config.json` file.
   * This now also triggers the initial state verification sequence.
   * @param filePath The absolute path to the configuration file.
   * @param validateFn The pre-compiled validation function for the config.
   */
  private async loadSystemConfig(filePath: string, validateFn: ValidateFunction): Promise<void> {
    // Clear any pending verification timers from a previous load.
    if (this.initialVerificationTimer) clearTimeout(this.initialVerificationTimer);
    if (this.finalVerificationTimer) clearTimeout(this.finalVerificationTimer);
    this.initialVerificationTimer = null;
    this.finalVerificationTimer = null;

    try {
      this.node.log(`Loading config from: ${filePath}`);
      const fileContent = await fs.readFile(filePath, "utf-8");
      const parsedConfig = JSON.parse(fileContent);

      if (!validateFn(parsedConfig)) {
        const errorText = validateFn.errors?.map(e => e.message).join(', ') || 'unknown validation error';
        throw new Error(`Invalid system-config.json: ${errorText}`);
      }
      const logMessage = this.service.updateSystemConfig(parsedConfig as SystemConfig);
      this.node.log(logMessage);

      this.scheduleInitialVerification();
    } catch (error) {
      this.service.clearSystemConfig();
      throw error;
    } finally {
      this.updateExposedState();
      this.updateExposedConfig();
      this.updateExportedTopics();
    }
  }

  /**
   * Schedules the two-stage active verification process and manages the warm-up state.
   * This smart startup sequence prevents false "device offline" alerts on deployment.
   * 1. A "warm-up" period is started, during which "device recovered" alerts are suppressed.
   * 2. After an initial delay (`initialStateTimeout`), it pings any devices that have not yet reported their Homie 'ready' state.
   * 3. After another delay (`pingTimeout`), it runs a final check on the pinged devices and raises alerts for any that are still unresponsive.
   */
  private scheduleInitialVerification(): void {
    const initialStateTimeoutMs = this.config.initialStateTimeout * 1000;
    const pingTimeoutMs = this.config.pingTimeout * 1000;
    const totalWarmupTimeMs = initialStateTimeoutMs + pingTimeoutMs;

    this.node.log(`Starting warm-up period for ${totalWarmupTimeMs / 1000}s.`);
    this.isWarmingUp = true;

    setTimeout(() => {
      this.isWarmingUp = false;
      this.node.log("Warm-up period finished. Node is now fully operational.");
    }, totalWarmupTimeMs);

    // This pattern avoids a 'no-misused-promises' error for async setTimeout callbacks.
    const initialVerification = async () => {
      this.node.log("Running initial device state verification: pinging silent devices...");
      const result = this.service.verifyInitialDeviceStates();
      await this.processServiceResult(result);

      const pingedDevices = result.messages[Output.Lsh]
        ? (result.messages[Output.Lsh] as NodeMessage[])
          .filter((msg): msg is NodeMessage & { topic: string } => typeof msg.topic === 'string')
          .map(msg => msg.topic.split('/')[1])
        : [];

      if (pingedDevices.length > 0) {
        this.node.log(`Scheduling final check for ${pingedDevices.length} pinged devices in ${this.config.pingTimeout}s.`);

        const finalVerification = async () => {
          this.node.log("Running final check on pinged devices...");
          const finalResult = this.service.runFinalVerification(pingedDevices);
          await this.processServiceResult(finalResult);
          this.finalVerificationTimer = null;
        };

        this.finalVerificationTimer = setTimeout(() => {
          void finalVerification();
        }, pingTimeoutMs);
      }
      this.initialVerificationTimer = null;
    };
    this.initialVerificationTimer = setTimeout(() => {
      void initialVerification();
    }, initialStateTimeoutMs);
  }


  /**
   * Sets up a file watcher to enable hot-reloading of the configuration.
   * @param filePath The absolute path to the configuration file to watch.
   * @param validateFn The pre-compiled validation function.
   */
  private setupFileWatcher(filePath: string, validateFn: ValidateFunction): void {
    if (this.watcher) this.watcher.close();
    this.watcher = chokidar.watch(filePath);
    this.watcher.on("change", (path) => {
      // Use fire-and-forget on an async function to satisfy no-misused-promises.
      void this.handleConfigFileChange(path, validateFn);
    });
  }

  /**
   * Handles the logic for reloading the configuration file.
   * This is a separate public method to be easily testable.
   * @param path The path to the file that changed.
   * @param validateFn The validation function to use.
   */
  public async handleConfigFileChange(path: string, validateFn: ValidateFunction): Promise<void> {
    this.node.log(`Configuration file changed: ${path}. Reloading...`);
    this.node.status({ fill: "yellow", shape: "dot", text: "Reloading config..." });
    try {
      await this.loadSystemConfig(path, validateFn);
      this.node.log(`Configuration successfully reloaded from ${path}.`);
      this.node.status({ fill: "green", shape: "dot", text: "Ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.node.error(`Error reloading ${path}: ${message}`);
      this.node.status({ fill: "red", shape: "ring", text: `Config reload failed` });
    }
  }

  /**
   * Sends messages to the appropriate node outputs.
   * @param messages An object mapping an Output enum member to the message(s) to be sent.
   */
  private send(messages: OutputMessages): void {
    // The number of outputs is now correctly determined from the enum's size.
    const numOutputs = Object.keys(Output).filter(k => !isNaN(Number(k))).length;
    const outputArray: (NodeMessage | NodeMessage[] | null)[] = new Array(numOutputs).fill(null);

    // Directly map the messages to their corresponding output index.
    for (const key in messages) {
      const outputIndex = Number(key);
      if (!isNaN(outputIndex) && outputIndex >= 0 && outputIndex < numOutputs) {
        outputArray[outputIndex] = messages[outputIndex as Output] || null;
      }
    }

    // Send only if at least one message is not null to avoid empty sends.
    if (outputArray.some(msg => msg !== null)) {
      this.node.send(outputArray);
    }
  }

  /**
   * Cleans up all resources.
   */
  public async _cleanupResources(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.initialVerificationTimer) clearTimeout(this.initialVerificationTimer);
    if (this.finalVerificationTimer) clearTimeout(this.finalVerificationTimer);
    if (this.watcher) {
      await this.watcher.close();
    }
    this.node.log("Cleaned up timers and file watcher.");
  }

  /**
     * The handler for the Node-RED 'close' event.
     */
  private async handleClose(): Promise<void> {
    this.node.log("Closing LSH Logic node.");
    await this._cleanupResources();
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
    const deviceNames = this.service.getConfiguredDeviceNames(); // Get the names
    const exposedData = {
      nodeConfig: this.config,
      systemConfig: deviceNames ? { devices: deviceNames.map(name => ({ name })) } : null,
      lastUpdated: Date.now(),
    };
    this.getContext(exposeConfigContext).set(exposeConfigKey, exposedData);
  }

  private updateExportedTopics(): void {
    const { exportTopics, exportTopicsKey, lshBasePath, homieBasePath } = this.config;

    const deviceNames = this.service.getConfiguredDeviceNames() || [];
    const lshTopics = deviceNames.map((name) => `${lshBasePath}${name}/+`);
    const homieTopics = deviceNames.map((name) => `${homieBasePath}${name}/$state`);
    const newTopics = [...lshTopics, ...homieTopics];

    // Create the message to unsubscribe from ALL current topics.
    // The `mqtt-in` node accepts `topic: true` for this action.
    // We disable the lint rule because this structure is specific to the `mqtt-in` node
    // and intentionally not a standard Node-RED message type.
    
    const unsubscribeAllMessage: NodeMessage = {
      action: "unsubscribe",
      topic: true,
      payload: {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const outputMessages: NodeMessage[] = [unsubscribeAllMessage];
    this.node.log("Generated 'unsubscribe all' message.");

    // If there are new topics to subscribe to, create the subscribe message.
    if (newTopics.length > 0) {
      const subscribeMessage: NodeMessage = {
        action: "subscribe",
        topic: newTopics,
        payload: {}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      outputMessages.push(subscribeMessage);
      this.node.log(`Generated 'subscribe' message for ${newTopics.length} topic(s).`);
    }

    // Send the sequence of messages on the Configuration output.
    this.send({ [Output.Configuration]: outputMessages });

    // Update the context variable for passive inspection.
    if (exportTopics !== "none" && exportTopicsKey) {
      const topicsToExport = {
        lsh: lshTopics,
        homie: homieTopics,
        all: newTopics,
        lastUpdated: Date.now(),
      };
      this.getContext(exportTopics).set(exportTopicsKey, topicsToExport);
      this.node.log(`Exported ${newTopics.length} MQTT topics to context key '${exportTopicsKey}'.`);
    }
  }
}

/**
 * The main module definition for Node-RED, which registers the node.
 */
const nodeRedModule = function (RED: NodeAPI) {
  function LshLogicNodeWrapper(this: Node, config: LshLogicNodeDef) {
    RED.nodes.createNode(this, config);
    // Instantiate our class to manage the node's lifecycle.
    new LshLogicNode(this, config, RED);
  }
  RED.nodes.registerType("lsh-logic", LshLogicNodeWrapper);
};

module.exports = Object.assign(nodeRedModule, { LshLogicNode, Output });