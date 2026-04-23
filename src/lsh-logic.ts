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
import { normalizeNodeConfig } from "./lsh-logic.config";
import {
  buildTopicSetSignature,
  getHomieDiscoveryTopics,
  normalizeInboundTopic,
} from "./lsh-logic.helpers";
import { createAppValidators } from "./schemas";
import { LshProtocol, Output } from "./types";
import type {
  LshLogicNodeDef,
  MqttSubscribeMsg,
  MqttUnsubscribeMsg,
  OutputMessages,
  ServiceResult,
  SystemConfig,
} from "./types";
import { sleep } from "./utils";

type ConfigLoadOutcome = "applied" | "skipped";

const CONFIG_RELOAD_DEBOUNCE_MS = 200;
const STARTUP_BOOT_DELAY_MS = 500;

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
  private runtimeRecoveryTimer: NodeJS.Timeout | null = null;
  private configReloadTimer: NodeJS.Timeout | null = null;
  private discoveryFlushTimer: NodeJS.Timeout | null = null;
  private configLoadQueue: Promise<void> = Promise.resolve();
  private sendQueue: Promise<void> = Promise.resolve();
  private lowPriorityLshDrainPromise: Promise<void> | null = null;
  private pendingLowPriorityLshMessages: Array<{
    generation: number;
    message: NodeMessage;
    controllerPingDeviceName: string | null;
    bridgeProbe: boolean;
    snapshotRecoveryDeviceName: string | null;
    startupVerificationDeviceCommand: boolean;
  }> = [];
  private lowPriorityLshGeneration: number = 0;
  private lastConfigurationOutputSignature: string | null = null;
  private latestConfigLoadVersion: number = 0;
  private isWarmingUp: boolean = false;
  private isClosing: boolean = false;
  private warmupDeadlineAt: number | null = null;
  private timersStarted: boolean = false;
  private watchdogCycleQueued: boolean = false;
  private watchdogCyclePromise: Promise<void> | null = null;
  private runtimeRecoveryQueuedAfterStartup: boolean = false;
  private tracksStartupVerificationRecoveryWindow = false;

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
    this.registerNodeEventHandlers();
  }

  private async initialize(validateSystemConfig: ValidateFunction): Promise<void> {
    this.node.status({ fill: "blue", shape: "dot", text: "Initializing..." });
    try {
      const userDir = this.RED.settings.userDir || process.cwd();
      const configPath = path.resolve(userDir, this.config.systemConfigPath);

      this.setupFileWatcher(configPath, validateSystemConfig);
      const outcome = await this.enqueueConfigLoad(configPath, validateSystemConfig, true);

      if (outcome === "applied") {
        this.ensureTimersStarted();
        this.node.status({ fill: "green", shape: "dot", text: "Ready" });
        this.node.log("Node initialized and configuration loaded.");
        return;
      }

      this.node.log(
        "Initial config load was superseded by a newer queued reload. Waiting for the latest load to determine readiness.",
      );
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

  /**
   * Starts periodic cleanup/watchdog timers only after the runtime has applied
   * a valid configuration at least once.
   */
  private ensureTimersStarted(): void {
    if (this.timersStarted) {
      return;
    }

    this.setupTimers();
    this.timersStarted = true;
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

    const topicResult = normalizeInboundTopic(msg);
    if (!topicResult.ok) {
      const error = new Error(topicResult.error);
      this.node.error(`Rejected inbound message: ${topicResult.error}`);
      done(error);
      return;
    }

    const topic = topicResult.topic;
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

    // Forward debug output through the same serialized send queue used by all
    // runtime output paths so Node-RED never receives overlapping send calls.
    await this.enqueueSendOperation(() => {
      if (this.isClosing) {
        return;
      }
      this.send({ [Output.Debug]: msg });
    });
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
    await this.processServiceResultNow(result);
  }

  /**
   * Serializes actual `send()` calls into Node-RED without forcing low-priority
   * staggered traffic to block later high-priority outputs.
   */
  private enqueueSendOperation<T>(work: () => T | Promise<T>): Promise<T> {
    const queuedWork = this.sendQueue.then(work, work);
    this.sendQueue = queuedWork.then(
      () => undefined,
      () => undefined,
    );
    return queuedWork;
  }

  /**
   * Drains low-priority bulk LSH traffic in the background, one message at a
   * time. Future watchdog/startup bulk messages remain serialized, but live
   * high-priority outputs may interleave between batches while the drain sleeps.
   */
  private scheduleLowPriorityLshDrain(messages: NodeMessage[]): void {
    const generation = this.lowPriorityLshGeneration;
    const queuedMessages = messages.map((message) => {
      const controllerPingDeviceName = this.getControllerPingDeviceName(message);
      const snapshotRecoveryDeviceName = this.getSnapshotRecoveryDeviceName(message);

      return {
        generation,
        message,
        controllerPingDeviceName,
        bridgeProbe: this.isBridgeProbeMessage(message),
        snapshotRecoveryDeviceName,
        startupVerificationDeviceCommand:
          this.tracksStartupVerificationRecoveryWindow &&
          (controllerPingDeviceName !== null || snapshotRecoveryDeviceName !== null),
      };
    });
    for (const queuedMessage of queuedMessages) {
      if (queuedMessage.controllerPingDeviceName) {
        this.service.recordQueuedControllerPing(queuedMessage.controllerPingDeviceName);
      }
    }
    this.pendingLowPriorityLshMessages.push(...queuedMessages);
    if (this.lowPriorityLshDrainPromise) {
      return;
    }

    this.lowPriorityLshDrainPromise = (async () => {
      try {
        while (!this.isClosing && this.pendingLowPriorityLshMessages.length > 0) {
          const nextMessage = this.pendingLowPriorityLshMessages.shift();
          if (!nextMessage) {
            continue;
          }

          // A successful config load invalidates any older watchdog/startup burst
          // traffic so removed or reshaped devices never keep draining stale work.
          if (nextMessage.generation !== this.lowPriorityLshGeneration) {
            if (nextMessage.controllerPingDeviceName) {
              this.service.cancelQueuedControllerPing(nextMessage.controllerPingDeviceName);
            }
            if (nextMessage.bridgeProbe) {
              this.service.cancelQueuedBridgeProbe();
            }
            if (nextMessage.snapshotRecoveryDeviceName) {
              this.service.cancelQueuedSnapshotRecovery(nextMessage.snapshotRecoveryDeviceName);
            }
            continue;
          }

          await this.enqueueSendOperation(() => {
            if (this.isClosing || nextMessage.generation !== this.lowPriorityLshGeneration) {
              if (nextMessage.controllerPingDeviceName) {
                this.service.cancelQueuedControllerPing(nextMessage.controllerPingDeviceName);
              }
              if (nextMessage.bridgeProbe) {
                this.service.cancelQueuedBridgeProbe();
              }
              if (nextMessage.snapshotRecoveryDeviceName) {
                this.service.cancelQueuedSnapshotRecovery(nextMessage.snapshotRecoveryDeviceName);
              }
              return;
            }
            if (nextMessage.controllerPingDeviceName) {
              this.service.recordDispatchedControllerPing(nextMessage.controllerPingDeviceName);
            }
            if (nextMessage.bridgeProbe) {
              this.service.recordDispatchedBridgeProbe();
            }
            if (nextMessage.snapshotRecoveryDeviceName) {
              this.service.recordDispatchedSnapshotRecovery(nextMessage.snapshotRecoveryDeviceName);
            }
            if (nextMessage.startupVerificationDeviceCommand) {
              this.extendWarmupForStartupVerificationDispatch();
            }
            this.send({ [Output.Lsh]: nextMessage.message });
          });

          if (this.isClosing || this.pendingLowPriorityLshMessages.length === 0) {
            continue;
          }

          // Sleep outside the send queue so live high-priority results can send
          // before the next low-priority watchdog/startup frame.
          await sleep(Math.random() * 200 + 50);
        }
      } finally {
        this.lowPriorityLshDrainPromise = null;
      }
    })();
  }

  private async processServiceResultNow(result: ServiceResult): Promise<void> {
    if (this.isClosing) {
      return;
    }

    result.logs.forEach((log) => this.node.log(log));
    result.warnings.forEach((warn) => this.node.warn(warn));
    result.errors.forEach((err) => this.node.error(err));

    if (result.stateChanged || result.registryChanged) {
      this.updateExposedState();
    }

    if (result.discoveryFlushDelayMs !== undefined) {
      this.scheduleDiscoveryFlush(result.discoveryFlushDelayMs);
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
        this.scheduleLowPriorityLshDrain(lshMessages);
        // The low-priority LSH frames are now owned by the background drain.
        delete result.messages[Output.Lsh];
      }

      if (Object.keys(result.messages).length === 0) {
        return;
      }

      // Send any remaining messages (or all if no staggering was needed).
      if (this.isClosing) {
        return;
      }
      await this.enqueueSendOperation(() => {
        if (this.isClosing) {
          return;
        }
        this.markImmediateLshDispatches(result.messages[Output.Lsh]);
        this.send(result.messages);
      });
    }
  }

  private scheduleDiscoveryFlush(delayMs: number): void {
    if (this.isClosing) {
      return;
    }

    this.clearDiscoveryFlushTimer();
    this.discoveryFlushTimer = setTimeout(() => {
      void (async () => {
        this.discoveryFlushTimer = null;
        if (this.isClosing) {
          return;
        }

        try {
          const result = this.service.flushPendingDiscovery();
          await this.processServiceResult(result);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.node.error(
            `Error while flushing deferred Home Assistant discovery: ${errorMessage}`,
          );
        }
      })();
    }, delayMs);
  }

  private clearDiscoveryFlushTimer(): void {
    if (this.discoveryFlushTimer) {
      clearTimeout(this.discoveryFlushTimer);
      this.discoveryFlushTimer = null;
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
   * Startup loads own the full warm-up / replay sequence. Runtime reloads do not
   * restart warm-up, but they still schedule a focused post-reload recovery pass.
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
    const hadValidConfigBeforeLoad = this.service.getSystemConfig() !== null;
    let shouldRefreshAdapterState = false;
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

      // Only a startup-owned load is allowed to reset the bootstrap timers.
      // Runtime reloads must preserve any already-running warm-up / replay flow.
      if (scheduleStartupVerification) {
        this.clearStartupTimers();
      }
      this.clearDiscoveryFlushTimer();
      this.invalidateLowPriorityLshDrain();
      const logMessage = this.service.updateSystemConfig(parsedConfig as SystemConfig);
      this.node.log(logMessage);
      await this.processServiceResult(this.service.syncDiscoveryConfig());
      shouldRefreshAdapterState = true;

      if (scheduleStartupVerification) {
        this.scheduleInitialVerification();
      } else if (this.isStartupRecoveryStillPending()) {
        this.runtimeRecoveryQueuedAfterStartup = true;
      } else {
        this.scheduleRuntimeRecoveryVerification();
      }
      return "applied";
    } catch (error) {
      if (this.isConfigLoadStale(loadVersion)) {
        return "skipped";
      }

      if (!hadValidConfigBeforeLoad || scheduleStartupVerification) {
        await this.processServiceResult(this.service.clearSystemConfig());
        shouldRefreshAdapterState = true;
      } else {
        this.node.warn("Keeping the last valid runtime configuration because a hot-reload failed.");
      }
      throw error;
    } finally {
      if (!this.isConfigLoadStale(loadVersion) && shouldRefreshAdapterState) {
        this.updateExposedState();
        this.updateExposedConfig();
        await this.updateExportedTopics();
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
   * Returns whether the startup-owned recovery flow still has a BOOT settle or
   * verification timer pending. Warm-up alone is not enough: late warm-up loads
   * still need their own strong runtime recovery pass.
   */
  private isStartupRecoveryStillPending(): boolean {
    return this.startupBootTimer !== null || this.initialVerificationTimer !== null;
  }

  /**
   * Drops any queued low-priority startup/watchdog traffic from older config
   * generations so a hot reload never drains stale commands for removed or
   * reshaped devices.
   */
  private invalidateLowPriorityLshDrain(): void {
    for (const pendingMessage of this.pendingLowPriorityLshMessages) {
      if (pendingMessage.controllerPingDeviceName) {
        this.service.cancelQueuedControllerPing(pendingMessage.controllerPingDeviceName);
      }
      if (pendingMessage.bridgeProbe) {
        this.service.cancelQueuedBridgeProbe();
      }
      if (pendingMessage.snapshotRecoveryDeviceName) {
        this.service.cancelQueuedSnapshotRecovery(pendingMessage.snapshotRecoveryDeviceName);
      }
    }
    this.lowPriorityLshGeneration++;
    this.pendingLowPriorityLshMessages = [];
  }

  /**
   * Returns the target device when an outgoing LSH message is a controller-level
   * `PING` directed at a device topic. Bridge-level service pings intentionally
   * return `null` because they do not participate in watchdog timeout tracking.
   */
  private getControllerPingDeviceName(message: NodeMessage): string | null {
    if (typeof message.topic !== "string" || !message.topic.startsWith(this.config.lshBasePath)) {
      return null;
    }

    if (!message.topic.endsWith("/IN")) {
      return null;
    }

    const decodedPayload = this.codec.decode(message.payload, this.config.protocol);
    const payload =
      decodedPayload && typeof decodedPayload === "object"
        ? (decodedPayload as { p?: unknown })
        : null;
    if (!payload || payload.p !== LshProtocol.PING) {
      return null;
    }

    const deviceName = message.topic.slice(this.config.lshBasePath.length, -"/IN".length);
    return deviceName.length > 0 ? deviceName : null;
  }

  /**
   * Returns `true` when an outgoing LSH message is the global service-topic
   * bridge probe broadcast used by the watchdog to distinguish bridge health
   * from controller silence.
   */
  private isBridgeProbeMessage(message: NodeMessage): boolean {
    if (typeof message.topic !== "string" || message.topic !== this.config.serviceTopic) {
      return false;
    }

    const decodedPayload = this.codec.decode(message.payload, this.config.protocol);
    const payload =
      decodedPayload && typeof decodedPayload === "object"
        ? (decodedPayload as { p?: unknown })
        : null;
    return payload?.p === LshProtocol.PING;
  }

  /**
   * Returns the target device when an outgoing LSH message is a snapshot
   * recovery command (`REQUEST_DETAILS` or `REQUEST_STATE`) directed at a
   * device topic.
   */
  private getSnapshotRecoveryDeviceName(message: NodeMessage): string | null {
    if (typeof message.topic !== "string" || !message.topic.startsWith(this.config.lshBasePath)) {
      return null;
    }

    if (!message.topic.endsWith("/IN")) {
      return null;
    }

    const decodedPayload = this.codec.decode(message.payload, this.config.protocol);
    const payload =
      decodedPayload && typeof decodedPayload === "object"
        ? (decodedPayload as { p?: unknown })
        : null;
    if (!payload) {
      return null;
    }

    if (payload.p !== LshProtocol.REQUEST_DETAILS && payload.p !== LshProtocol.REQUEST_STATE) {
      return null;
    }

    const deviceName = message.topic.slice(this.config.lshBasePath.length, -"/IN".length);
    return deviceName.length > 0 ? deviceName : null;
  }

  /**
   * Starts watchdog and recovery timeout accounting only once the relevant LSH
   * message is actually being emitted by the adapter.
   */
  private markImmediateLshDispatches(lshMessages: OutputMessages[Output.Lsh] | undefined): void {
    if (!lshMessages) {
      return;
    }

    const messages = Array.isArray(lshMessages) ? lshMessages : [lshMessages];
    for (const message of messages) {
      let startupVerificationDeviceCommandDispatched = false;

      const deviceName = this.getControllerPingDeviceName(message);
      if (deviceName) {
        this.service.recordDispatchedControllerPing(deviceName);
        startupVerificationDeviceCommandDispatched = true;
      }

      if (this.isBridgeProbeMessage(message)) {
        this.service.recordDispatchedBridgeProbe();
      }

      const snapshotRecoveryDeviceName = this.getSnapshotRecoveryDeviceName(message);
      if (snapshotRecoveryDeviceName) {
        this.service.recordDispatchedSnapshotRecovery(snapshotRecoveryDeviceName);
        startupVerificationDeviceCommandDispatched = true;
      }

      if (
        startupVerificationDeviceCommandDispatched &&
        this.tracksStartupVerificationRecoveryWindow
      ) {
        this.extendWarmupForStartupVerificationDispatch();
      }
    }
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
    this.warmupDeadlineAt = null;
    this.runtimeRecoveryQueuedAfterStartup = false;
    this.tracksStartupVerificationRecoveryWindow = false;
  }

  private clearRuntimeRecoveryTimer(): void {
    if (this.runtimeRecoveryTimer) {
      clearTimeout(this.runtimeRecoveryTimer);
      this.runtimeRecoveryTimer = null;
    }
  }

  private startWarmup(durationMs: number): void {
    this.setWarmupDeadline(Date.now() + durationMs);
  }

  private setWarmupDeadline(deadlineAt: number): void {
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
    }

    this.isWarmingUp = true;
    this.warmupDeadlineAt = deadlineAt;
    const delayMs = Math.max(deadlineAt - Date.now(), 0);
    this.warmupTimer = setTimeout(() => {
      this.isWarmingUp = false;
      this.warmupDeadlineAt = null;
      this.node.log("Warm-up period finished. Node is now fully operational.");
      this.warmupTimer = null;
    }, delayMs);
  }

  /**
   * During startup verification, suppress recovery noise until `pingTimeout`
   * after the last controller-side verification command that actually leaves
   * the adapter. This covers both direct `PING`s and snapshot repair requests.
   */
  private extendWarmupForStartupVerificationDispatch(now = Date.now()): void {
    if (!this.isWarmingUp) {
      return;
    }

    const nextDeadline = now + this.config.pingTimeout * 1000;
    if (this.warmupDeadlineAt !== null && this.warmupDeadlineAt >= nextDeadline) {
      return;
    }

    this.setWarmupDeadline(nextDeadline);
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

  /**
   * Schedules a strong runtime recovery pass after a successful hot reload
   * without restarting warm-up. This keeps runtime reloads self-healing for
   * newly added or reshaped devices while preserving normal live alerting.
   */
  private scheduleRuntimeRecoveryVerification(): void {
    this.clearRuntimeRecoveryTimer();
    this.runtimeRecoveryQueuedAfterStartup = false;
    this.runtimeRecoveryTimer = setTimeout(() => {
      void this.runRuntimeRecoverySequence(this.config.initialStateTimeout * 1000);
    }, STARTUP_BOOT_DELAY_MS);
  }

  private async runRuntimeRecoverySequence(initialStateTimeoutMs: number): Promise<void> {
    this.runtimeRecoveryTimer = null;
    if (this.isClosing) {
      return;
    }

    this.node.log(
      "Running post-reload device recovery: reconciling snapshots for the updated runtime configuration.",
    );

    if (!this.service.needsStartupBootReplay()) {
      await this.runInitialVerification();
      return;
    }

    this.node.log(
      "Config reload left one or more devices without authoritative snapshots. Requesting a bridge-local BOOT resync before runtime verification.",
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
    this.tracksStartupVerificationRecoveryWindow = true;
    try {
      const result = this.service.verifyInitialDeviceStates();
      await this.processServiceResult(result);
    } finally {
      this.tracksStartupVerificationRecoveryWindow = false;
    }

    if (this.runtimeRecoveryQueuedAfterStartup && !this.isClosing) {
      this.scheduleRuntimeRecoveryVerification();
    }
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
    const isStartupRecoveryReload = !this.timersStarted && this.service.getSystemConfig() === null;
    try {
      const outcome = await this.enqueueConfigLoad(path, validateFn, isStartupRecoveryReload);
      if (outcome === "skipped") {
        return;
      }
      this.ensureTimersStarted();
      this.node.log(
        isStartupRecoveryReload
          ? `Configuration successfully recovered from ${path}. Restarting the full startup bootstrap flow.`
          : `Configuration successfully reloaded from ${path}.`,
      );
      this.node.status({ fill: "green", shape: "dot", text: "Ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.node.error(`Error reloading ${path}: ${message}`);
      if (this.service.getSystemConfig() !== null) {
        this.node.status({
          fill: "yellow",
          shape: "ring",
          text: "Reload failed, using last config",
        });
      } else {
        this.node.status({ fill: "red", shape: "ring", text: "Config reload failed" });
      }
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
    this.timersStarted = false;
    this.watchdogCycleQueued = false;
    this.clearDiscoveryFlushTimer();
    this.clearStartupTimers();
    this.clearRuntimeRecoveryTimer();
    this.invalidateLowPriorityLshDrain();
    if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
    if (this.watcher) {
      await this.watcher.close();
    }
    await this.configLoadQueue;
    if (this.lowPriorityLshDrainPromise) {
      await this.lowPriorityLshDrainPromise;
    }
    await this.sendQueue;
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

  private async updateExportedTopics(): Promise<void> {
    const { exportTopics, exportTopicsKey, lshBasePath, homieBasePath } = this.config;
    if (this.isClosing) {
      return;
    }

    // Subscription sets are semantic sets, not ordered lists. Sorting keeps the
    // runtime comparison stable across config reordering and prevents needless
    // unsubscribe/resubscribe churn for equivalent topic sets.
    const deviceNames = [...(this.service.getConfiguredDeviceNames() || [])].sort((left, right) =>
      left.localeCompare(right),
    );

    // Explicitly define the sub-topics to subscribe to for each LSH device, excluding '/IN'.
    const lshSubTopics = ["conf", "state", "events", "bridge"];
    const lshTopics = deviceNames.flatMap((name) =>
      lshSubTopics.map((subTopic) => `${lshBasePath}${name}/${subTopic}`),
    ); // These require QoS 2.

    const homieTopics = deviceNames.map((name) => `${homieBasePath}${name}/$state`); // These require QoS 1
    const discoveryTopics = this.config.haDiscovery ? getHomieDiscoveryTopics(homieBasePath) : [];

    const outputMessages: Array<MqttSubscribeMsg | MqttUnsubscribeMsg> = [
      {
        action: "unsubscribe",
        topic: true,
      },
    ];

    // Create the message to unsubscribe from ALL current topics.
    // The `mqtt-in` node accepts `topic: true` for this action.
    // We disable the lint rule because this structure is specific to the `mqtt-in` node
    // and intentionally not a standard Node-RED message type.

    // If there are Homie topics, create a specific subscribe message with QoS 1.
    if (homieTopics.length > 0) {
      const subscribeQos1Message: MqttSubscribeMsg = {
        action: "subscribe",
        topic: homieTopics,
        qos: 1, // Set QoS to 1 for Homie topics
      };
      outputMessages.push(subscribeQos1Message);
    }

    // If there are LSH topics, create a specific subscribe message with QoS 2.
    if (lshTopics.length > 0) {
      const subscribeQos2Message: MqttSubscribeMsg = {
        action: "subscribe",
        topic: lshTopics,
        qos: 2, // Set QoS to 2 for LSH topics
      };
      outputMessages.push(subscribeQos2Message);
    }

    if (discoveryTopics.length > 0) {
      const subscribeDiscoveryMessage: MqttSubscribeMsg = {
        action: "subscribe",
        topic: discoveryTopics,
        qos: 1,
      };
      outputMessages.push(subscribeDiscoveryMessage);
    }

    const nextConfigurationOutputSignature = buildTopicSetSignature(
      outputMessages.map((message) => JSON.stringify(message)),
    );
    if (nextConfigurationOutputSignature !== this.lastConfigurationOutputSignature) {
      this.lastConfigurationOutputSignature = nextConfigurationOutputSignature;
      this.node.log("MQTT topic set changed. Reconfiguring runtime subscriptions.");

      // Configuration traffic must obey the same send serialization contract as
      // runtime outputs, otherwise a reload can interleave subscribe churn with
      // live lifecycle messages.
      await this.enqueueSendOperation(() => {
        if (this.isClosing) {
          return;
        }
        this.send({ [Output.Configuration]: outputMessages });
      });
    } else {
      this.node.log(
        "MQTT topic set unchanged after config update. Skipping runtime subscription reconfiguration.",
      );
    }

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
