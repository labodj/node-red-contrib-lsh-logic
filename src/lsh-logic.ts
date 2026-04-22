/**
 * @file This is the main entry point for the LSH Logic node in Node-RED.
 * It defines the `LshLogicNode` class, which acts as a thin adapter layer,
 * connecting the Node-RED runtime to the core `LshLogicService`. This class
 * is responsible for all interactions with the Node-RED environment.
 */
import * as fs from "fs/promises";
import * as chokidar from "chokidar";
import * as path from "path";
import type { ValidateFunction } from "ajv";
import type { Node, NodeAPI, NodeMessage } from "node-red";

import { LshLogicService } from "./LshLogicService";
import { LshCodec } from "./LshCodec";
import { createAppValidators } from "./schemas";
import { Output } from "./types";
import type {
  LshLogicNodeDef,
  MqttSubscribeMsg,
  MqttUnsubscribeMsg,
  OutputMessages,
  ServiceResult,
  SystemConfig,
} from "./types";
import { sleep } from "./utils";

type NumericConfigKey =
  | "clickTimeout"
  | "clickCleanupInterval"
  | "watchdogInterval"
  | "interrogateThreshold"
  | "pingTimeout"
  | "initialStateTimeout";

type ConfigLoadOutcome = "applied" | "skipped";

const CONFIG_RELOAD_DEBOUNCE_MS = 200;
const STARTUP_BOOT_DELAY_MS = 500;

const normalizeRequiredString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return normalized;
};

const validateTopicBase = (value: string, fieldName: string): string => {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!normalized.endsWith("/")) {
    throw new Error(`${fieldName} must end with '/'.`);
  }
  return normalized;
};

const normalizePositiveNumber = (value: number, fieldName: string): number => {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return normalized;
};

const normalizeNodeConfig = (config: LshLogicNodeDef): LshLogicNodeDef => {
  const normalizedConfig = {
    ...config,
    homieBasePath: validateTopicBase(config.homieBasePath, "Homie Base Path"),
    lshBasePath: validateTopicBase(config.lshBasePath, "LSH Base Path"),
    serviceTopic: normalizeRequiredString(config.serviceTopic, "Service Topic"),
    otherDevicesPrefix: normalizeRequiredString(config.otherDevicesPrefix, "External State Prefix"),
    systemConfigPath: normalizeRequiredString(config.systemConfigPath, "System Config"),
    exposeStateKey: config.exposeStateKey.trim(),
    exportTopicsKey: config.exportTopicsKey.trim(),
    exposeConfigKey: config.exposeConfigKey.trim(),
    haDiscoveryPrefix: config.haDiscovery
      ? normalizeRequiredString(config.haDiscoveryPrefix, "Discovery Prefix")
      : config.haDiscoveryPrefix.trim(),
  };

  const numericFields: Record<NumericConfigKey, string> = {
    clickTimeout: "Click Confirm Timeout",
    clickCleanupInterval: "Click Cleanup",
    watchdogInterval: "Watchdog Interval",
    interrogateThreshold: "Ping Threshold",
    pingTimeout: "Ping Timeout",
    initialStateTimeout: "Initial Replay Window",
  };

  for (const [key, label] of Object.entries(numericFields) as Array<[NumericConfigKey, string]>) {
    normalizedConfig[key] = normalizePositiveNumber(normalizedConfig[key], label);
  }

  return normalizedConfig;
};

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
  private readonly codec: LshCodec;

  // --- Mutable Node-RED specific state ---
  private watcher: chokidar.FSWatcher | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private warmupTimer: NodeJS.Timeout | null = null;
  private startupBootTimer: NodeJS.Timeout | null = null;
  private initialVerificationTimer: NodeJS.Timeout | null = null;
  private configReloadTimer: NodeJS.Timeout | null = null;
  private configLoadQueue: Promise<void> = Promise.resolve();
  private latestConfigLoadVersion: number = 0;
  private isWarmingUp: boolean = false;
  private isClosing: boolean = false;
  private watchdogCycleQueued: boolean = false;
  private watchdogCyclePromise: Promise<void> | null = null;

  /**
   * Creates an instance of the LshLogicNode.
   * @param node - The Node-RED node instance this class is managing.
   * @param config - The user-defined configuration for this node instance.
   * @param RED - The Node-RED runtime API object.
   */
  constructor(node: Node, config: LshLogicNodeDef, RED: NodeAPI) {
    this.node = node;
    this.config = normalizeNodeConfig(config);
    this.RED = RED;
    this.codec = new LshCodec();

    const validators = createAppValidators();

    // Instantiate the core logic service, injecting its dependencies.
    this.service = new LshLogicService(
      {
        lshBasePath: this.config.lshBasePath,
        homieBasePath: this.config.homieBasePath,
        serviceTopic: this.config.serviceTopic,
        protocol: this.config.protocol,
        otherDevicesPrefix: this.config.otherDevicesPrefix,
        clickTimeout: this.config.clickTimeout,
        interrogateThreshold: this.config.interrogateThreshold,
        pingTimeout: this.config.pingTimeout,

        haDiscovery: this.config.haDiscovery,
        haDiscoveryPrefix: this.config.haDiscoveryPrefix,
      },
      this.getContext(this.config.otherActorsContext),
      validators,
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

      await this.enqueueConfigLoad(configPath, validateSystemConfig, true);
      this.setupFileWatcher(configPath, validateSystemConfig);

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
      void this.runWatchdogCycle();
    }, watchdogIntervalMs);
  }

  private async runWatchdogCycle(): Promise<void> {
    if (this.isWarmingUp || this.isClosing) {
      return;
    }

    if (this.watchdogCyclePromise) {
      this.watchdogCycleQueued = true;
      await this.watchdogCyclePromise;
      return;
    }

    let cyclePromise: Promise<void> | null = null;
    cyclePromise = (async () => {
      try {
        do {
          this.watchdogCycleQueued = false;
          if (this.isWarmingUp || this.isClosing) {
            break;
          }

          const result = this.service.runWatchdogCheck();
          await this.processServiceResult(result);
        } while (this.watchdogCycleQueued && !this.isClosing);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.node.error(`Error during watchdog cycle: ${errorMessage}`);
      } finally {
        this.watchdogCycleQueued = false;
        if (this.watchdogCyclePromise === cyclePromise) {
          this.watchdogCyclePromise = null;
        }
      }
    })();

    this.watchdogCyclePromise = cyclePromise;
    await cyclePromise;
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
   * It decodes the payload according to the configured topic protocol before
   * delegating processing to the service.
   * @param msg The incoming Node-RED message.
   * @param done The callback to signal completion to the Node-RED runtime.
   */
  private async handleInput(msg: NodeMessage, done: (err?: Error) => void): Promise<void> {
    if (this.isClosing) {
      done();
      return;
    }

    const topic = msg.topic || "";
    let processedPayload: unknown;

    try {
      const payloadProtocol = this.getPayloadProtocol(topic);
      processedPayload = this.codec.decode(msg.payload, payloadProtocol);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.node.error(`Failed to decode payload on topic ${topic || "unknown"}: ${errorMessage}`);
      done(error instanceof Error ? error : new Error(errorMessage));
      return;
    }

    if (this.isClosing) {
      done();
      return;
    }

    try {
      // The service always receives a standard JavaScript object, regardless of original format.
      const result = this.service.processMessage(topic, processedPayload, {
        retained: (msg as { retain?: unknown }).retain === true,
      });
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

  private getPayloadProtocol(topic: string): "json" | "msgpack" | "text" {
    return topic.startsWith(this.config.lshBasePath) ? this.config.protocol : "text";
  }

  /**
   * Takes a result from the service layer and performs the required Node-RED actions
   * (logging, sending messages, updating state).
   * @param result The ServiceResult object from a service method call.
   */
  public async processServiceResult(result: ServiceResult): Promise<void> {
    if (this.isClosing) {
      return;
    }

    result.logs.forEach((log) => this.node.log(log));
    result.warnings.forEach((warn) => this.node.warn(warn));
    result.errors.forEach((err) => this.node.error(err));

    if (result.stateChanged || result.registryChanged) {
      this.updateExposedState();
    }

    if (this.isWarmingUp && result.messages[Output.Alerts]) {
      const alertMessages = Array.isArray(result.messages[Output.Alerts])
        ? result.messages[Output.Alerts]
        : [result.messages[Output.Alerts]];
      const filteredAlerts = alertMessages.filter((alertMsg) => !this.isRecoveryAlert(alertMsg));

      if (filteredAlerts.length !== alertMessages.length) {
        this.node.log("Suppressing 'device recovered' alert during warm-up period.");
        if (filteredAlerts.length === 0) {
          delete result.messages[Output.Alerts];
        } else {
          result.messages[Output.Alerts] =
            filteredAlerts.length === 1 ? filteredAlerts[0] : filteredAlerts;
        }
      }
    }

    if (Object.keys(result.messages).length > 0) {
      const lshMessages = result.messages[Output.Lsh];
      // A message array indicates a request for staggered sending.
      // The service layer requests this for bulk actions like pings to avoid overwhelming the network.
      if (result.staggerLshMessages && Array.isArray(lshMessages) && lshMessages.length > 1) {
        this.node.log(
          `Sending ${lshMessages.length} messages in a staggered sequence to prevent a thundering herd.`,
        );
        for (const msg of lshMessages) {
          if (this.isClosing) {
            return;
          }
          this.send({ [Output.Lsh]: msg });
          // Sleep for a short, random interval to avoid a "thundering herd."
          await sleep(Math.random() * 200 + 50);
          if (this.isClosing) {
            return;
          }
        }
        // The staggered messages have been sent, so remove them from the result object.
        delete result.messages[Output.Lsh];
      }

      // Send any remaining messages (or all if no staggering was needed).
      if (this.isClosing) {
        return;
      }
      this.send(result.messages);
    }
  }

  private isRecoveryAlert(msg: NodeMessage): boolean {
    const { payload } = msg;
    if (typeof payload === "string") {
      return payload.startsWith("✅");
    }
    if (payload && typeof payload === "object") {
      const alertPayload = payload as { status?: unknown; message?: unknown };
      return (
        alertPayload.status === "healthy" ||
        (typeof alertPayload.message === "string" && alertPayload.message.startsWith("✅"))
      );
    }
    return false;
  }

  /**
   * Loads, parses, and validates the `system-config.json` file.
   * Startup verification is only scheduled during bootstrap; runtime reloads stay
   * intentionally best-effort and do not restart the full warm-up cycle.
   * @param filePath The absolute path to the configuration file.
   * @param validateFn The pre-compiled validation function for the config.
   * @param scheduleStartupVerification Whether to start the bootstrap verification timers.
   */
  private async loadSystemConfig(
    filePath: string,
    validateFn: ValidateFunction,
    scheduleStartupVerification: boolean,
    loadVersion: number,
  ): Promise<ConfigLoadOutcome> {
    try {
      this.node.log(`Loading config from: ${filePath}`);
      const fileContent = await fs.readFile(filePath, "utf-8");
      const parsedConfig: unknown = JSON.parse(fileContent);

      if (!validateFn(parsedConfig)) {
        const errorText =
          validateFn.errors?.map((e) => e.message).join(", ") || "unknown validation error";
        throw new Error(`Invalid system-config.json: ${errorText}`);
      }

      if (this.isConfigLoadStale(loadVersion)) {
        return "skipped";
      }

      // Clear any pending startup timers only when this load is still current.
      this.clearStartupTimers();
      const logMessage = this.service.updateSystemConfig(parsedConfig as SystemConfig);
      this.node.log(logMessage);
      await this.processServiceResult(this.service.syncDiscoveryConfig());

      if (scheduleStartupVerification) {
        this.scheduleInitialVerification();
      }
      return "applied";
    } catch (error) {
      if (this.isConfigLoadStale(loadVersion)) {
        return "skipped";
      }

      await this.processServiceResult(this.service.clearSystemConfig());
      throw error;
    } finally {
      if (!this.isConfigLoadStale(loadVersion)) {
        this.updateExposedState();
        this.updateExposedConfig();
        this.updateExportedTopics();
      }
    }
  }

  private enqueueConfigLoad(
    filePath: string,
    validateFn: ValidateFunction,
    scheduleStartupVerification: boolean,
  ): Promise<ConfigLoadOutcome> {
    const loadVersion = ++this.latestConfigLoadVersion;
    const runLoad = async (): Promise<ConfigLoadOutcome> => {
      if (this.isClosing) {
        return "skipped";
      }

      return this.loadSystemConfig(filePath, validateFn, scheduleStartupVerification, loadVersion);
    };

    const queuedLoad = this.configLoadQueue.then(runLoad, runLoad);
    this.configLoadQueue = queuedLoad.then(
      () => undefined,
      () => undefined,
    );
    return queuedLoad;
  }

  private isConfigLoadStale(loadVersion: number): boolean {
    return this.isClosing || loadVersion !== this.latestConfigLoadVersion;
  }

  /**
   * Schedules the startup warm-up and the startup recovery sequence.
   * This startup path deliberately separates three concerns:
   * 1. A short MQTT subscription settle window.
   * 2. If any configured device is still missing an authoritative `details + state`
   *    snapshot after that window, request one bridge-local BOOT replay.
   * 3. After the optional replay window, run a best-effort verification pass that
   *    repairs incomplete snapshots and pings only the devices that are still unreachable.
   */
  private scheduleInitialVerification(): void {
    const initialStateTimeoutMs = this.config.initialStateTimeout * 1000;
    const pingTimeoutMs = this.config.pingTimeout * 1000;
    const totalWarmupTimeMs = STARTUP_BOOT_DELAY_MS + initialStateTimeoutMs + pingTimeoutMs;

    this.node.log(
      `Starting warm-up period for up to ${this.formatDurationSeconds(totalWarmupTimeMs)}s (subscription settle ${this.formatDurationSeconds(STARTUP_BOOT_DELAY_MS)}s + optional replay window ${this.formatDurationSeconds(initialStateTimeoutMs)}s + ping timeout ${this.formatDurationSeconds(pingTimeoutMs)}s).`,
    );
    this.startWarmup(totalWarmupTimeMs);

    this.startupBootTimer = setTimeout(() => {
      void this.runStartupSequence(initialStateTimeoutMs, pingTimeoutMs);
    }, STARTUP_BOOT_DELAY_MS);
  }

  private formatDurationSeconds(durationMs: number): string {
    const seconds = durationMs / 1000;
    return Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1);
  }

  private clearStartupTimers(): void {
    if (this.startupBootTimer) {
      clearTimeout(this.startupBootTimer);
      this.startupBootTimer = null;
    }
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    if (this.initialVerificationTimer) {
      clearTimeout(this.initialVerificationTimer);
      this.initialVerificationTimer = null;
    }
    this.isWarmingUp = false;
  }

  private startWarmup(durationMs: number): void {
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
    }

    this.isWarmingUp = true;
    this.warmupTimer = setTimeout(() => {
      this.isWarmingUp = false;
      this.node.log("Warm-up period finished. Node is now fully operational.");
      this.warmupTimer = null;
    }, durationMs);
  }

  private async runStartupSequence(
    initialStateTimeoutMs: number,
    pingTimeoutMs: number,
  ): Promise<void> {
    if (this.startupBootTimer) {
      clearTimeout(this.startupBootTimer);
      this.startupBootTimer = null;
    }

    if (!this.service.needsStartupBootReplay()) {
      this.node.log(
        "Skipping startup bridge-local BOOT resync because all configured devices already have authoritative details and state snapshots.",
      );
      this.startWarmup(pingTimeoutMs);
      await this.runInitialVerification();
      return;
    }

    this.node.log(
      "Requesting startup bridge-local BOOT resync after MQTT subscription settle because one or more configured devices are missing authoritative snapshots.",
    );
    await this.processServiceResult(this.service.getStartupCommands());

    if (this.initialVerificationTimer) {
      clearTimeout(this.initialVerificationTimer);
    }
    this.initialVerificationTimer = setTimeout(() => {
      void this.runInitialVerification();
    }, initialStateTimeoutMs);
  }

  private async runInitialVerification(): Promise<void> {
    this.initialVerificationTimer = null;
    this.node.log(
      "Running initial device state verification: repairing incomplete snapshots and pinging unreachable devices...",
    );
    const result = this.service.verifyInitialDeviceStates();
    await this.processServiceResult(result);
  }

  /**
   * Sets up a file watcher to enable hot-reloading of the configuration.
   * @param filePath The absolute path to the configuration file to watch.
   * @param validateFn The pre-compiled validation function.
   */
  private setupFileWatcher(filePath: string, validateFn: ValidateFunction): void {
    if (this.watcher) {
      void this.watcher.close();
    }
    this.watcher = chokidar.watch(filePath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: CONFIG_RELOAD_DEBOUNCE_MS,
        pollInterval: 100,
      },
    });
    const scheduleReload = (changedPath: string) => {
      if (this.configReloadTimer) {
        clearTimeout(this.configReloadTimer);
      }
      this.configReloadTimer = setTimeout(() => {
        this.configReloadTimer = null;
        // Use fire-and-forget on an async function to satisfy no-misused-promises.
        void this.handleConfigFileChange(changedPath, validateFn);
      }, CONFIG_RELOAD_DEBOUNCE_MS);
    };

    this.watcher.on("add", scheduleReload);
    this.watcher.on("change", scheduleReload);
    this.watcher.on("unlink", scheduleReload);
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
      const outcome = await this.enqueueConfigLoad(path, validateFn, false);
      if (outcome === "skipped") {
        return;
      }
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
    if (this.isClosing) {
      return;
    }

    // Derive the output count from the enum itself so the mapping stays correct
    // if a future change adds or removes outputs.
    const numOutputs = Object.keys(Output).filter((k) => !isNaN(Number(k))).length;
    const outputArray = Array<
      | NodeMessage
      | NodeMessage[]
      | MqttSubscribeMsg
      | MqttUnsubscribeMsg
      | Array<MqttSubscribeMsg | MqttUnsubscribeMsg>
      | null
    >(numOutputs).fill(null);

    const mappedOutputs: Array<[Output, OutputMessages[Output] | undefined]> = [
      [Output.Lsh, messages[Output.Lsh]],
      [Output.OtherActors, messages[Output.OtherActors]],
      [Output.Alerts, messages[Output.Alerts]],
      [Output.Configuration, messages[Output.Configuration]],
      [Output.Debug, messages[Output.Debug]],
    ];

    for (const [outputIndex, outputMessage] of mappedOutputs) {
      outputArray[outputIndex] = outputMessage || null;
    }

    // Send only if at least one message is not null to avoid empty sends.
    if (outputArray.some((msg) => msg !== null)) {
      this.node.send(outputArray as unknown as NodeMessage[]);
    }
  }

  /**
   * Cleans up all resources.
   */
  public async _cleanupResources(): Promise<void> {
    this.isClosing = true;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    this.watchdogCycleQueued = false;
    this.clearStartupTimers();
    if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
    if (this.watcher) {
      await this.watcher.close();
    }
    await this.configLoadQueue;
    if (this.watchdogCyclePromise) {
      await this.watchdogCyclePromise;
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
    if (this.isClosing || exposeStateContext === "none" || !exposeStateKey) return;
    const exposedData = {
      devices: this.service.getDeviceRegistry(),
      lastUpdated: Date.now(),
    };
    this.getContext(exposeStateContext).set(exposeStateKey, exposedData);
  }

  private updateExposedConfig(): void {
    const { exposeConfigContext, exposeConfigKey } = this.config;
    if (this.isClosing || exposeConfigContext === "none" || !exposeConfigKey) return;

    // Get the full system config from the service layer
    const fullSystemConfig = this.service.getSystemConfig();

    const exposedData = {
      nodeConfig: structuredClone(this.config),
      // Use the complete systemConfig object obtained from the service
      systemConfig: fullSystemConfig,
      lastUpdated: Date.now(),
    };
    this.getContext(exposeConfigContext).set(exposeConfigKey, exposedData);
  }

  private updateExportedTopics(): void {
    const { exportTopics, exportTopicsKey, lshBasePath, homieBasePath } = this.config;
    if (this.isClosing) {
      return;
    }

    const deviceNames = this.service.getConfiguredDeviceNames() || [];

    // Explicitly define the sub-topics to subscribe to for each LSH device, excluding '/IN'.
    const lshSubTopics = ["conf", "state", "events", "bridge"];
    const lshTopics = deviceNames.flatMap((name) =>
      lshSubTopics.map((subTopic) => `${lshBasePath}${name}/${subTopic}`),
    ); // These require QoS 2.

    const homieTopics = deviceNames.map((name) => `${homieBasePath}${name}/$state`); // These require QoS 1
    const discoveryTopics = this.config.haDiscovery
      ? [`${homieBasePath}+/$nodes`, `${homieBasePath}+/$mac`, `${homieBasePath}+/$fw/version`]
      : [];

    // Create the message to unsubscribe from ALL current topics.
    // The `mqtt-in` node accepts `topic: true` for this action.
    // We disable the lint rule because this structure is specific to the `mqtt-in` node
    // and intentionally not a standard Node-RED message type.

    const unsubscribeAllMessage: MqttUnsubscribeMsg = {
      action: "unsubscribe",
      topic: true,
    };

    const outputMessages: Array<MqttSubscribeMsg | MqttUnsubscribeMsg> = [unsubscribeAllMessage];
    this.node.log("Generated 'unsubscribe all' message.");

    // If there are Homie topics, create a specific subscribe message with QoS 1.
    if (homieTopics.length > 0) {
      const subscribeQos1Message: MqttSubscribeMsg = {
        action: "subscribe",
        topic: homieTopics,
        qos: 1, // Set QoS to 1 for Homie topics
      };
      outputMessages.push(subscribeQos1Message);
      this.node.log(`Generated 'subscribe' message for ${homieTopics.length} topic(s) with QoS 1.`);
    }

    // If there are LSH topics, create a specific subscribe message with QoS 2.
    if (lshTopics.length > 0) {
      const subscribeQos2Message: MqttSubscribeMsg = {
        action: "subscribe",
        topic: lshTopics,
        qos: 2, // Set QoS to 2 for LSH topics
      };
      outputMessages.push(subscribeQos2Message);
      this.node.log(`Generated 'subscribe' message for ${lshTopics.length} topic(s) with QoS 2.`);
    }

    if (discoveryTopics.length > 0) {
      const subscribeDiscoveryMessage: MqttSubscribeMsg = {
        action: "subscribe",
        topic: discoveryTopics,
        qos: 1,
      };
      outputMessages.push(subscribeDiscoveryMessage);
      this.node.log(`Generated 'subscribe' message for HA Discovery topics.`);
    }

    // Send the sequence of messages on the Configuration output.
    this.send({ [Output.Configuration]: outputMessages });

    // Update the context variable for passive inspection.
    if (exportTopics !== "none" && exportTopicsKey) {
      const allTopics = [...homieTopics, ...discoveryTopics, ...lshTopics];
      const topicsToExport = {
        lsh: lshTopics,
        homie: homieTopics,
        discovery: discoveryTopics,
        all: allTopics,
        lastUpdated: Date.now(),
      };
      this.getContext(exportTopics).set(exportTopicsKey, topicsToExport);
      this.node.log(
        `Exported ${allTopics.length} MQTT topics to context key '${exportTopicsKey}'.`,
      );
    }
  }
}

/**
 * The main module definition for Node-RED, which registers the node.
 */
const nodeRedModule = function (RED: NodeAPI) {
  function LshLogicNodeWrapper(this: Node, config: LshLogicNodeDef) {
    RED.nodes.createNode(this, config);
    try {
      // Instantiate our class to manage the node's lifecycle.
      new LshLogicNode(this, config, RED);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(`Invalid node configuration: ${message}`);
      this.status({ fill: "red", shape: "ring", text: "Node Config Error" });
    }
  }
  RED.nodes.registerType("lsh-logic", LshLogicNodeWrapper);
};

module.exports = Object.assign(nodeRedModule, { LshLogicNode, Output });
