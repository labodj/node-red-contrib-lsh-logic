/**
 * @file This is the main entry point for the LSH Logic node.
 * It defines the `LshLogicNode` class, which acts as the primary orchestrator,
 * and registers the node with the Node-RED runtime.
 */
import { Node, NodeMessage, NodeAPI } from "node-red";
import * as fs from "fs/promises";
import * as chokidar from "chokidar";
import * as path from "path";
import Ajv, { ValidateFunction } from "ajv";

import { DeviceRegistryManager } from "./DeviceRegistryManager";
import { ClickTransactionManager } from "./ClickTransactionManager";
import { Watchdog } from "./Watchdog";
import {
  anyMiscPayloadSchema,
  longClickConfigSchema,
  deviceConfPayloadSchema,
  deviceStatePayloadSchema,
} from "./schemas";
import { sleep, formatAlertMessage } from "./utils";
import {
  LshLogicNodeDef,
  LongClickConfig,
  DeviceConfigEntry,
  DeviceConfPayload,
  DeviceStatePayload,
  AnyDeviceMiscPayload,
  NetworkClickPayload,
  Output,
  OutputMessages,
  LshProtocol,
  Actor,
} from "./types";

/**
 * Main orchestrator class for the LSH Logic node.
 * It does not contain business logic itself, but coordinates the different
 * managers (`DeviceRegistryManager`, `ClickTransactionManager`, `Watchdog`)
 * and handles all I/O with the Node-RED environment.
 */
export class LshLogicNode {
  private node: Node;
  private config: LshLogicNodeDef;
  private RED: NodeAPI;

  // Schema validators, pre-compiled for performance.
  private ajv: Ajv;
  private validateLongClickConfig: ValidateFunction;
  private validateConfPayload: ValidateFunction;
  private validateStatePayload: ValidateFunction;
  private validateAnyMiscPayload: ValidateFunction;

  // --- INTERNAL STATE ---
  /** Holds the parsed long-click configuration from the JSON file. */
  private longClickConfig: LongClickConfig | null = null;
  /** A map for O(1) lookup of device configurations. */
  private deviceConfigMap: Map<string, DeviceConfigEntry> = new Map();
  /** Watches the config file for changes to enable hot-reloading. */
  private watcher: chokidar.FSWatcher | null = null;
  /** Manages the in-memory state of all known devices. */
  private deviceManager: DeviceRegistryManager;
  /** Manages the state and lifecycle of network click transactions. */
  private clickManager: ClickTransactionManager;
  /** Monitors device health and determines when to ping them. */
  private watchdog: Watchdog;

  // Timers for periodic tasks.
  /** Timer for periodically cleaning up expired click transactions. */
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** Timer for periodically running device health checks. */
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

    // Initialize AJV and pre-compile all schemas for performance.
    this.ajv = new Ajv({ discriminator: true });
    this.validateLongClickConfig = this.ajv.compile(longClickConfigSchema);
    this.validateConfPayload = this.ajv.compile(deviceConfPayloadSchema);
    this.validateStatePayload = this.ajv.compile(deviceStatePayloadSchema);
    this.validateAnyMiscPayload = this.ajv.compile(anyMiscPayloadSchema);

    this.deviceManager = new DeviceRegistryManager(
      this.config.otherDevicesPrefix,
      this.getContext(this.config.otherActorsContext)
    );
    this.clickManager = new ClickTransactionManager(this.config.clickTimeout);
    this.watchdog = new Watchdog(
      this.config.interrogateThreshold,
      this.config.pingTimeout
    );

    this.initialize();

    // Start a timer to periodically clean up expired click transactions.
    const cleanupIntervalMs = this.config.clickCleanupInterval * 1000;
    this.cleanupInterval = setInterval(() => {
      this.cleanupPendingClicks();
    }, cleanupIntervalMs);

    // Start the watchdog timer to monitor device health.
    const watchdogIntervalMs = this.config.watchdogInterval * 1000;
    this.watchdogInterval = setInterval(() => {
      this.runWatchdogCheck();
    }, watchdogIntervalMs);

    // Register handlers for Node-RED events.
    this.node.on("input", (msg, _send, done) => {
      this.handleInput(msg, done);
    });

    this.node.on("close", (done: () => void) => {
      this.handleClose(done);
    });
  }

  /**
   * Cleans up resources for testing purposes or when the node is closed.
   */
  public testCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
    if (this.watcher) {
      // The `as any` is used because the chokidar mock in tests
      // might not perfectly match the real type.
      (this.watcher as any)?.close();
    }
  }

  /**
   * Retrieves the flow or global context object.
   * @param type - The type of context to retrieve ('flow' or 'global').
   * @returns The requested context object.
   */
  private getContext(type: "flow" | "global") {
    return type === "flow"
      ? this.node.context().flow
      : this.node.context().global;
  }

  /**
   * Sends messages to one or more node outputs in a single, atomic operation.
   * @param messages An object where keys are `Output` enum members and values
   * are the `NodeMessage` objects to be sent on that output.
   */
  private send(messages: OutputMessages): void {
    // TypeScript enums have both numeric and string keys. Dividing by 2 gets the actual number of outputs
    const outputArray: (NodeMessage | null)[] = new Array(
      Object.keys(Output).length / 2
    ).fill(null);
    outputArray[Output.Lsh] = messages[Output.Lsh] || null;
    outputArray[Output.OtherActors] = messages[Output.OtherActors] || null;
    outputArray[Output.Alerts] = messages[Output.Alerts] || null;
    outputArray[Output.Debug] = messages[Output.Debug] || null;
    if (outputArray.some((msg) => msg !== null)) {
      this.node.send(outputArray);
    }
  }

  /**
   * Initializes the node, loads the configuration file, and sets up the file watcher.
   * This is the main entry point for the node's setup logic.
   */
  private async initialize(): Promise<void> {
    // Initializing state: node is starting up.
    this.node.status({ fill: "blue", shape: "dot", text: "Initializing..." });
    try {
      const userDir = this.RED.settings.userDir || process.cwd();
      const configPath = path.resolve(userDir, this.config.longClickConfigPath);
      await this.loadLongClickConfig(configPath);
      this.setupFileWatcher(configPath);
      // Ready state: initialization complete and config loaded.
      this.node.status({ fill: "green", shape: "dot", text: "Ready" });
      this.node.log("Node initialized and configuration loaded.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.node.error(`Critical error during initialization: ${msg}`);
      // Error state: a critical failure occurred, node is non-operational.
      this.node.status({ fill: "red", shape: "ring", text: "Config Error" });
    }
  }

  /**
   * Updates the flow or global context with the current dynamic device state.
   */
  private updateExposedState(): void {
    const { exposeStateContext, exposeStateKey } = this.config;
    if (exposeStateContext === "none" || !exposeStateKey) return;
    const exposedData = {
      devices: this.deviceManager.getRegistry(),
      lastUpdated: Date.now(),
    };
    this.getContext(exposeStateContext).set(exposeStateKey, exposedData);
  }

  /**
   * Updates the flow or global context with the static configuration.
   * This should be called only when the configuration is loaded/reloaded.
   */
  private updateExposedConfig(): void {
    const { exposeConfigContext, exposeConfigKey } = this.config;
    if (exposeConfigContext === "none" || !exposeConfigKey) return;
    const exposedData = {
      nodeConfig: this.config,
      longClickConfig: this.longClickConfig,
      lastUpdated: Date.now(),
    };
    this.getContext(exposeConfigContext).set(exposeConfigKey, exposedData);
  }

  /**
   * Loads, parses, and validates the long-click configuration JSON file.
   * @param filePath - The absolute path to the configuration file.
   * @throws {Error} If the file cannot be read, parsed, or validated.
   */
  private async loadLongClickConfig(filePath: string): Promise<void> {
    try {
      this.node.log(`Loading config from: ${filePath}`);
      const fileContent = await fs.readFile(filePath, "utf-8");
      const parsedConfig = JSON.parse(fileContent);

      if (!this.validateLongClickConfig(parsedConfig)) {
        throw new Error(
          `Invalid longClickConfig: ${this.ajv.errorsText(
            this.validateLongClickConfig.errors
          )}`
        );
      }

      this.longClickConfig = parsedConfig as LongClickConfig;
      this.deviceConfigMap.clear();
      const newDeviceNames = new Set(
        this.longClickConfig.devices.map((d) => d.name)
      );

      for (const device of this.longClickConfig.devices) {
        this.deviceConfigMap.set(device.name, device);
      }

      for (const deviceName in this.deviceManager.getRegistry()) {
        if (!newDeviceNames.has(deviceName)) {
          this.deviceManager.pruneDevice(deviceName);
          this.node.log(
            `Pruned stale device from registry: '${deviceName}' (removed from config).`
          );
        }
      }
      this.node.log(
        "Long-click configuration successfully loaded and validated."
      );
    } catch (error) {
      this.longClickConfig = null;
      this.deviceConfigMap.clear();
      throw error; // Re-throw to be caught by the caller
    } finally {
      // This block ensures that the exposed context and topics are always
      // updated, even if loading fails. In case of failure, it will expose
      // an empty/null config, correctly reflecting the node's internal state.
      this.updateExposedState();
      this.updateExposedConfig();
      this.updateExportedTopics();
    }
  }

  /**
   * Sets up a file watcher (chokidar) to monitor the long-click configuration file.
   * If the file changes, it triggers a hot-reload of the configuration.
   * @param filePath - The absolute path to the configuration file to watch.
   * @private
   */
  private setupFileWatcher(filePath: string): void {
    if (this.watcher) this.watcher.close();
    this.watcher = chokidar.watch(filePath);
    this.watcher.on("change", (path) => {
      this.node.log(`Configuration file changed: ${path}. Reloading...`);
      // Reloading state: config file changed, attempting to reload.
      this.node.status({
        fill: "yellow",
        shape: "dot",
        text: "Reloading config...",
      });
      this.loadLongClickConfig(path)
        .then(() => {
          this.node.log(`Configuration successfully reloaded from ${path}.`);
          // Back to ready state after successful reload.
          this.node.status({ fill: "green", shape: "dot", text: "Ready" });
        })
        .catch((err) => {
          this.node.error(`Error reloading ${path}: ${err.message}`);
          // Error state: reload failed, node may be in an inconsistent state.
          this.node.status({
            fill: "red",
            shape: "ring",
            text: `Config reload failed`,
          });
        });
    });
  }

  /**
   * Stores device configuration details by delegating to the DeviceRegistryManager.
   * @param deviceName - The name of the device.
   * @param details - The payload from the 'conf' topic.
   */
  private storeDeviceDetails(
    deviceName: string,
    details: DeviceConfPayload
  ): void {
    this.deviceManager.storeDeviceDetails(deviceName, details);
    this.updateExposedState();
    this.node.log(`Stored/Updated details for device '${deviceName}'.`);
  }
  /**
   * Corresponds to the original "Store state" function node.
   * Updates the actuator state array for a specific device.
   * If the device is not yet registered, it creates a partial "shell"
   * entry and stores the state, awaiting a 'conf' message.
   * @param deviceName - The name of the device.
   * @param states - The boolean array from the 'state' topic payload.
   */
  private storeDeviceState(deviceName: string, states: boolean[]): void {
    try {
      const isNew = this.deviceManager.storeDeviceState(deviceName, states);
      if (isNew) {
        this.node.log(
          `Received state for a new device: ${deviceName}. Creating a partial registry entry.`
        );
      }
      this.updateExposedState();
      this.node.log(
        `Updated state for '${deviceName}': [${states.join(", ")}]`
      );
    } catch (error) {
      this.node.error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Corresponds to the original "Store connection state" function node (from Homie).
   * Updates the connection status of a device.
   * @param deviceName - The name of the device.
   * @param homieState - The state from the Homie $state topic (e.g., "ready", "lost").
   */
  private storeConnectionState(deviceName: string, homieState: string): void {
    const { changed, connected } = this.deviceManager.storeConnectionState(
      deviceName,
      homieState
    );
    if (changed) {
      this.node.log(
        `Device '${deviceName}' ${connected ? "connected" : "disconnected"}.`
      );
      this.updateExposedState();
    }
  }

  /**
   * Handles the two-phase commit protocol for "Network Clicks".
   * This method acts as an orchestrator. It validates the click request and then
   * delegates the state management of the transaction to the `ClickTransactionManager`.
   * @param deviceName - The name of the device that sent the click.
   * @param payload - The validated NetworkClickPayload.
   */
  private handleNetworkClick(
    deviceName: string,
    payload: NetworkClickPayload
  ): void {
    // --- Step 1: Update device's last seen time ---
    const device = this.deviceManager.getDevice(deviceName);
    if (device) {
      device.lastSeenTime = Date.now();
      this.updateExposedState();
    }

    const { bi: buttonId, ct: clickType, c: isConfirmation } = payload;
    const transactionKey = `${deviceName}.${buttonId}.${clickType}`;
    const commandTopic = `${this.config.lshBasePath}${deviceName}/IN`;

    // --- Helper function for sending a Click Failover (c_f) response.
    const sendClickFailover = (reason: string) => {
      this.node.warn(
        `Click validation failed for ${transactionKey}: ${reason}. Sending Click Failover (c_f).`
      );
      this.send({
        [Output.Lsh]: {
          topic: commandTopic,
          payload: {
            p: LshProtocol.CLICK_FAILOVER,
            ct: clickType,
            bi: buttonId,
          },
        },
      });
    };

    // --- Helper function for sending a General Failover (c_gf) response.
    const sendGeneralFailover = (reason: string) => {
      this.node.error(
        `System failure on click ${transactionKey}: ${reason}. Sending General Failover (c_gf).`
      );
      this.send({
        [Output.Lsh]: {
          topic: commandTopic,
          payload: { p: LshProtocol.GENERAL_FAILOVER },
        },
        [Output.Debug]: { payload: { error: reason } },
      });
    };

    // --- Step 2: Handle incoming confirmation (Phase 2) ---
    if (isConfirmation) {
      // Delegate consuming the transaction to the manager
      const transaction = this.clickManager.consumeTransaction(transactionKey);

      if (!transaction) {
        this.node.warn(
          `Received confirmation for an expired or unknown click: ${transactionKey}.`
        );
        return;
      }

      this.node.log(`Click confirmed for ${transactionKey}. Executing logic.`);
      this.executeClickLogic(
        transaction.actors,
        transaction.otherActors,
        clickType
      );
      return;
    }

    // --- Step 3: Handle new click request (Phase 1) ---

    // FAILOVER SCENARIO 1: System-level config not loaded.
    if (!this.longClickConfig) {
      return sendGeneralFailover("longClickConfig is not loaded.");
    }

    // FAILOVER SCENARIO 2: No specific configuration found for this button.
    const deviceConfig = this.deviceConfigMap.get(deviceName);
    const clickTypeKey =
      clickType === "lc" ? "longClickButtons" : "superLongClickButtons";
    const buttonConfig = deviceConfig?.[clickTypeKey]?.find(
      (btn) => btn.id === buttonId
    );

    if (!buttonConfig) {
      return sendClickFailover(`No action configured for this button.`);
    }

    // FAILOVER SCENARIO 3: Configuration exists but has no targets.
    const { actors = [], otherActors = [] } = buttonConfig;
    if (actors.length === 0 && otherActors.length === 0) {
      return sendClickFailover(`Action configured with no targets.`);
    }

    // FAILOVER SCENARIO 4: One or more target actors are offline.
    const offlineActors = actors.filter(
      (actor) => !this.deviceManager.getDevice(actor.name)?.connected
    );
    if (offlineActors.length > 0) {
      const names = offlineActors.map((a) => a.name).join(", ");
      return sendClickFailover(`Target actor(s) are offline: ${names}.`);
    }

    // --- SUCCESS: Validation Passed. Start the transaction. ---

    // Delegate starting the transaction to the manager
    this.clickManager.startTransaction(transactionKey, actors, otherActors);

    // Send ACK to the device
    this.send({
      [Output.Lsh]: {
        topic: commandTopic,
        payload: {
          p: LshProtocol.NETWORK_CLICK_ACK,
          ct: clickType,
          bi: buttonId,
        },
      },
    });
    this.node.log(`Validation OK for ${transactionKey}. Sending ACK.`);
  }

  /**
   * Cleans up pending click transactions that have exceeded the configured timeout.
   */
  private cleanupPendingClicks(): void {
    const cleanedCount = this.clickManager.cleanupExpired();
    if (cleanedCount > 0) {
      this.node.log(`Cleaned up ${cleanedCount} expired click transactions.`);
    }
  }

  /**
   * Corresponds to the original "Build State Commands" function node.
   * Prepares MQTT messages to set the state of actuators.
   * @param actors - The target actor configurations.
   * @param stateToSet - The boolean state to apply.
   * @returns An array of MQTT messages ready to be sent.
   */
  private buildStateCommands(
    actors: Actor[],
    stateToSet: boolean
  ): NodeMessage[] {
    const commands: NodeMessage[] = [];
    for (const actor of actors) {
      const device = this.deviceManager.getDevice(actor.name);
      if (!device) continue;

      const commandTopic = `${this.config.lshBasePath}${actor.name}/IN`;
      const isSingleSpecificActuator =
        !actor.allActuators && actor.actuators.length === 1;

      if (isSingleSpecificActuator) {
        commands.push({
          topic: commandTopic,
          payload: {
            p: LshProtocol.APPLY_SINGLE_ACTUATOR_STATE,
            ai: actor.actuators[0],
            as: stateToSet,
          },
        });
      } else {
        const newState = [...device.actuatorStates];
        if (actor.allActuators) {
          newState.fill(stateToSet);
        } else {
          for (const actuatorId of actor.actuators) {
            const index = device.actuatorIndexes[actuatorId];
            if (index !== undefined) newState[index] = stateToSet;
          }
        }
        commands.push({
          topic: commandTopic,
          payload: { p: LshProtocol.APPLY_ALL_ACTUATORS_STATE, as: newState },
        });
      }
    }
    return commands;
  }
  /**
   * Orchestrates the execution of a confirmed click action.
   * Sends LSH commands to output 1 and other actor commands to output 2.
   * @param actors - The primary target actors (LSH).
   * @param otherActors - The secondary target actors (external).
   * @param clickType - The type of click ('lc' or 'slc').
   */
  private executeClickLogic(
    actors: Actor[],
    otherActors: string[],
    clickType: "lc" | "slc"
  ): void {
    let stateToSet: boolean;

    if (clickType === "slc") {
      stateToSet = false;
      this.node.log("Executing SLC logic: setting state to OFF.");
    } else {
      const toggleResult = this.deviceManager.getSmartToggleState(
        actors,
        otherActors
      );
      if (toggleResult.warning) {
        this.node.warn(toggleResult.warning);
      }
      this.node.log(
        `Smart Toggle: ${toggleResult.active}/${
          toggleResult.total
        } active. Decision: ${toggleResult.stateToSet ? "ON" : "OFF"}`
      );
      stateToSet = toggleResult.stateToSet;
    }

    const lshCommands = this.buildStateCommands(actors, stateToSet);
    if (lshCommands.length > 0) {
      lshCommands.forEach((cmd) => this.send({ [Output.Lsh]: cmd }));
    }

    if (otherActors.length > 0) {
      this.send({
        [Output.OtherActors]: {
          otherActors,
          stateToSet,
          payload: `Set state=${stateToSet} for external actors.`,
        },
      });
    }
  }

  /**
   * Performs a periodic health check on all registered devices.
   * Implements a multi-stage logic to avoid false positives.
   * Corresponds to the original "Check Devices Health" function node.
   */
  private async runWatchdogCheck(): Promise<void> {
    if (!this.longClickConfig || this.longClickConfig.devices.length === 0)
      return;

    const now = Date.now();
    const devicesToPing: string[] = [];
    const unhealthyDevicesForAlert: { name: string; reason: string }[] = [];
    let stateChanged = false;

    for (const deviceConfig of this.longClickConfig.devices) {
      const deviceName = deviceConfig.name;
      const deviceState = this.deviceManager.getDevice(deviceName);

      // The device is configured but not in the registry yet.
      if (!deviceState) {
        unhealthyDevicesForAlert.push({
          name: deviceName,
          reason: "Never seen on the network.",
        });
        continue;
      }

      const result = this.watchdog.checkDeviceHealth(deviceState, now);

      switch (result.status) {
        case "ok":
          if (!deviceState.isHealthy || deviceState.isStale) {
            this.node.log(`Device ${deviceName} is back online.`);
            deviceState.isHealthy = true;
            deviceState.isStale = false;
            stateChanged = true;
          }
          break;
        case "needs_ping":
          this.node.log(
            `Device ${deviceName} is silent. Sending interrogation ping.`
          );
          devicesToPing.push(deviceName);
          break;
        case "stale":
          if (deviceState.isStale) {
            // It was already stale, now it's unhealthy
            if (deviceState.isHealthy) {
              // Report only on the first transition to unhealthy
              unhealthyDevicesForAlert.push({
                name: deviceName,
                reason: `No response for > ${this.config.pingTimeout}s.`,
              });
              deviceState.isHealthy = false;
              stateChanged = true;
            }
          } else {
            // First time it's stale
            this.node.warn(
              `Device ${deviceName} has become "stale" (ping not answered).`
            );
            deviceState.isStale = true;
            stateChanged = true;
          }
          devicesToPing.push(deviceName); // Try pinging again
          break;
        case "unhealthy":
          if (deviceState.isHealthy) {
            unhealthyDevicesForAlert.push({
              name: deviceName,
              reason: result.reason,
            });
            deviceState.isHealthy = false;
            stateChanged = true;
          }
          break;
      }
    }

    if (stateChanged) this.updateExposedState();

    if (devicesToPing.length > 0) {
      const totalConfiguredDevices = this.longClickConfig.devices.length;

      // Optimization: If all devices are silent, it might indicate a wider network issue
      // or that this node just started. A single broadcast ping is more efficient.
      if (devicesToPing.length === totalConfiguredDevices) {
        this.node.log(
          `All ${totalConfiguredDevices} devices are silent. Sending a single broadcast ping.`
        );
        const pingCommand = {
          topic: this.config.serviceTopic,
          payload: { p: LshProtocol.PING },
        };
        this.send({ [Output.Lsh]: pingCommand });
      } else {
        this.node.log(
          `Sending staggered pings to ${devicesToPing.length} device(s)...`
        );
        for (const deviceName of devicesToPing) {
          const pingCommand = {
            topic: `${this.config.lshBasePath}${deviceName}/IN`,
            payload: { p: LshProtocol.PING },
          };
          this.send({ [Output.Lsh]: pingCommand });
          // Add a small, random delay (jitter) to stagger the pings and avoid a network burst.
          await sleep(Math.random() * 200 + 50);
        }
      }
    }

    if (unhealthyDevicesForAlert.length > 0) {
      this.send({
        [Output.Alerts]: {
          payload: formatAlertMessage(unhealthyDevicesForAlert),
        },
      });
    }
  }

  /**
   * The main handler for all incoming messages. It routes messages
   * to the appropriate logic based on their MQTT topic.
   * @param msg - The incoming Node-RED message.
   * @param done - The function to call when processing is complete.
   */
  private handleInput(msg: NodeMessage, done: (err?: Error) => void): void {
    if (!this.config || !this.longClickConfig) {
      this.node.warn("Configuration not loaded, ignoring message.");
      return done();
    }

    try {
      const topic = msg.topic || "";
      let processed = false;

      // The message routing logic follows a specific priority:
      // 1. Homie topics for connection state are checked first.
      // 2. LSH-specific topics are checked next.
      // Messages that don't match are logged but otherwise ignored.

      // 1. Handle Homie connection state messages (e.g., homie/device/$state)
      if (topic.startsWith(this.config.homieBasePath)) {
        const parts = topic
          .substring(this.config.homieBasePath.length)
          .split("/");
        if (parts.length === 2 && parts[1] === "$state") {
          const deviceName = parts[0];
          // Any valid message counts as activity.
          this.watchdog.onDeviceActivity(deviceName);
          this.storeConnectionState(deviceName, String(msg.payload));
          processed = true;
        }
      }
      // 2. Handle LSH protocol messages (e.g., LSH/device/conf, /state, /misc)
      else if (topic.startsWith(this.config.lshBasePath)) {
        const parts = topic
          .substring(this.config.lshBasePath.length)
          .split("/");
        if (parts.length === 2) {
          const [deviceName, suffix] = parts;

          // Any valid LSH message from a device also counts as activity.
          this.watchdog.onDeviceActivity(deviceName);

          switch (suffix) {
            case "conf":
              if (this.validateConfPayload(msg.payload)) {
                this.storeDeviceDetails(
                  deviceName,
                  msg.payload as DeviceConfPayload
                );
              } else {
                this.node.warn(
                  `Invalid 'conf' payload from ${deviceName}: ${this.ajv.errorsText(
                    this.validateConfPayload.errors
                  )}`
                );
              }
              processed = true;
              break;

            case "state":
              if (this.validateStatePayload(msg.payload)) {
                this.storeDeviceState(
                  deviceName,
                  (msg.payload as DeviceStatePayload).as
                );
              } else {
                this.node.warn(
                  `Invalid 'state' payload from ${deviceName}: ${this.ajv.errorsText(
                    this.validateStatePayload.errors
                  )}`
                );
              }
              processed = true;
              break;

            case "misc":
              if (!this.validateAnyMiscPayload(msg.payload)) {
                this.node.warn(
                  `Received invalid or unhandled 'misc' payload from ${deviceName}.`
                );
                this.send({
                  [Output.Debug]: {
                    payload: {
                      error: "Invalid Misc Payload",
                      topic: msg.topic,
                      receivedPayload: msg.payload,
                    },
                  },
                });
              } else {
                const miscPayload = msg.payload as AnyDeviceMiscPayload;

                switch (miscPayload.p) {
                  case LshProtocol.NETWORK_CLICK:
                    this.handleNetworkClick(deviceName, miscPayload);
                    break;
                  case LshProtocol.DEVICE_BOOT:
                    this.node.log(
                      `Device '${deviceName}' reported a boot event.`
                    );
                    const device = this.deviceManager.getDevice(deviceName);
                    if (device) {
                      device.lastSeenTime = Date.now();
                      device.lastBootTime = Date.now();
                      this.updateExposedState();
                    }
                    break;
                  case LshProtocol.PING:
                    this.node.log(
                      `Received ping response from '${deviceName}'.`
                    );
                    // This is a special case of activity already handled by the watchdog's internal state.
                    // The main effect is updating the device state to not be 'stale'.
                    const pingingDevice =
                      this.deviceManager.getDevice(deviceName);
                    if (pingingDevice) {
                      pingingDevice.lastSeenTime = Date.now();
                      if (pingingDevice.isStale) {
                        this.node.log(
                          `Device '${deviceName}' is no longer stale.`
                        );
                        pingingDevice.isStale = false;
                      }
                      this.updateExposedState();
                    }
                    break;
                }
              }
              processed = true;
              break;
          }
        }
      }

      if (!processed) {
        // This is not an error, just a log entry for visibility during debugging.
        // It allows the user to see all messages passing through the node,
        // even those on topics the node doesn't actively handle.
        this.node.log(`Message on unhandled topic: ${topic}`);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.node.error(`Error processing message: ${errorMessage}`);
      return done(error instanceof Error ? error : new Error(errorMessage));
    }

    // Forward the original message to the debug output, regardless of processing.
    this.send({ [Output.Debug]: msg });
    done();
  }

  /**
   * Cleans up resources when the node is removed or Node-RED is shut down.
   * @param done - Callback to signal completion.
   */
  private async handleClose(done: () => void): Promise<void> {
    this.node.log("Closing LSH Logic node.");
    this.testCleanup(); // Use the same cleanup method
    done();
  }

  /**
   * Generates lists of MQTT topics for LSH and Homie based on the
   * current configuration and saves them to the specified context.
   */
  private updateExportedTopics(): void {
    const contextType = this.config.exportTopics;
    if (contextType === "none" || !this.config.exportTopicsKey) {
      return;
    }

    if (!this.longClickConfig) {
      this.node.warn("Cannot generate topics: longClickConfig is not loaded.");
      return;
    }

    const deviceNames = this.longClickConfig.devices.map((d) => d.name);

    // Generate LSH topics (e.g., LSH/kitchen/+, LSH/livingroom/+)
    const lshTopics = deviceNames.map(
      (name) => `${this.config.lshBasePath}${name}/+`
    );

    // Generate Homie topics (e.g., homie/kitchen/$state, homie/livingroom/$state)
    const homieTopics = deviceNames.map(
      (name) => `${this.config.homieBasePath}${name}/$state`
    );

    const topicsToExport = {
      lsh: lshTopics,
      homie: homieTopics,
      all: [...lshTopics, ...homieTopics],
      lastUpdated: Date.now(),
    };

    const context =
      contextType === "flow"
        ? this.node.context().flow
        : this.node.context().global;

    context.set(this.config.exportTopicsKey, topicsToExport);

    this.node.log(
      `Exported ${topicsToExport.all.length} MQTT topics to context key '${this.config.exportTopicsKey}'.`
    );
  }
}

/**
 * The main module definition for Node-RED.
 * This function is called by the Node-RED runtime when the node is loaded.
 * It registers the node's type and its constructor function.
 * @param RED - The Node-RED runtime API object.
 */
const nodeRedModule = function (RED: NodeAPI) {
  /**
   * The constructor function for the `lsh-logic` node, as called by the Node-RED runtime.
   * This function creates the Node-RED node instance and initializes the main LshLogicNode orchestrator.
   * @param this - The `Node` instance being constructed.
   * @param config - The configuration properties set by the user in the editor.
   */
  function LshLogicNodeWrapper(this: Node, config: LshLogicNodeDef) {
    RED.nodes.createNode(this, config);
    new LshLogicNode(this, config, RED);
  }
  RED.nodes.registerType("lsh-logic", LshLogicNodeWrapper);
};

module.exports = Object.assign(nodeRedModule, { LshLogicNode, Output });
