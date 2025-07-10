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
 * @internal
 * @description Defines the structure for a single route in the topic routing table.
 * Each route contains a regular expression to match against an MQTT topic and a
 * handler function to execute if the topic matches.
 */
type TopicRoute = {
  /** The regular expression to test against the incoming MQTT topic. */
  regex: RegExp;
  /** 
   * The handler function to be executed on a match.
   * @param deviceName - The first capture group from the regex, typically the device's name.
   * @param payload - The payload of the Node-RED message.
   * @param parts - An array of any additional capture groups from the regex.
   */
  handler: (deviceName: string, payload: any, parts: string[]) => void;
};

/**
* @internal
* @description Collects actions to be performed at the end of a watchdog cycle.
* Using a single object makes it easier to pass these actions between helper methods.
*/
type WatchdogActions = {
  devicesToPing: Set<string>;
  unhealthyDevicesForAlert: Array<{ name: string; reason: string }>;
  stateChanged: boolean;
};

/**
 * @internal
 * @description Custom error for handling click validation failures gracefully.
 * This allows us to throw an error with all necessary context for sending a failover message.
 */
class ClickValidationError extends Error {
  constructor(
    public readonly reason: string,
    public readonly failoverType: "general" | "click"
  ) {
    super(reason);
    this.name = "ClickValidationError";
  }
}


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
  /** 
   * @internal
   * @description A declarative routing table that maps MQTT topic patterns to handler functions.
   * This simplifies the `handleInput` method by replacing conditional logic with a lookup table.
   */
  private routes: TopicRoute[];

  // Timers for periodic tasks.
  /** Timer for periodically cleaning up expired click transactions. */
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** Timer for periodically running device health checks. */
  private watchdogInterval: NodeJS.Timeout | null = null;

  /**
   * @internal
   * @description A map of handler functions for different LSH message types.
   * This replaces a `switch` statement, making the code more declarative and extensible.
   */
  private lshMessageHandlers: {
    [key in 'conf' | 'state' | 'misc']: (deviceName: string, payload: any) => void;
  };

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

    // Initialize the declarative routing table.
    this.routes = this._createTopicRoutes();

    this.lshMessageHandlers = {
      conf: (deviceName, payload) => this._handleConfMessage(deviceName, payload),
      state: (deviceName, payload) => this._handleStateMessage(deviceName, payload),
      misc: (deviceName, payload) => this._handleMiscMessage(deviceName, payload),
    };

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
   * @internal
   * @description Creates and returns the topic routing table.
   * This keeps the constructor cleaner by isolating the route definitions.
   * @returns An array of `TopicRoute` objects.
   */
  private _createTopicRoutes(): TopicRoute[] {
    return [
      // Route for Homie connection state messages (e.g., homie/device/$state)
      {
        regex: new RegExp(`^${this.config.homieBasePath}([^/]+)/\\$state$`),
        handler: (deviceName, payload) => {
          this.watchdog.onDeviceActivity(deviceName);
          this.storeConnectionState(deviceName, String(payload));
        },
      },
      // Route for all LSH protocol messages (e.g., LSH/device/conf, /state, /misc)
      {
        regex: new RegExp(`^${this.config.lshBasePath}([^/]+)/(conf|state|misc)$`),
        handler: (deviceName, payload, parts) => {
          this.watchdog.onDeviceActivity(deviceName);
          const suffix = parts[0] as "conf" | "state" | "misc";
          this._handleLshMessage(deviceName, suffix, payload);
        },
      },
    ];
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
      const { isNew, changed } = this.deviceManager.storeDeviceState(deviceName, states);
      if (isNew) {
        this.node.log(
          `Received state for a new device: ${deviceName}. Creating a partial registry entry.`
        );
      }
      if (changed) {
        this.updateExposedState();
        this.node.log(
          `Updated state for '${deviceName}': [${states.join(", ")}]`
        );
      }
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
   * @internal
   * @description Validates a new network click request against the current system state and configuration.
   * This method uses guard clauses and throws a `ClickValidationError` on failure.
   * @returns An object with the validated actors if successful.
   * @throws {ClickValidationError} If the validation fails for any reason.
   */
  private _validateClickRequest(
    deviceName: string,
    buttonId: string,
    clickType: "lc" | "slc"
  ): { actors: Actor[]; otherActors: string[] } {
    // GUARD: System-level config not loaded.
    if (!this.longClickConfig) {
      throw new ClickValidationError("longClickConfig is not loaded.", "general");
    }

    const deviceConfig = this.deviceConfigMap.get(deviceName);
    const clickTypeKey =
      clickType === "lc" ? "longClickButtons" : "superLongClickButtons";
    const buttonConfig = deviceConfig?.[clickTypeKey]?.find(
      (btn) => btn.id === buttonId
    );

    // GUARD: No specific configuration found for this button.
    if (!buttonConfig) {
      throw new ClickValidationError("No action configured for this button.", "click");
    }

    const { actors = [], otherActors = [] } = buttonConfig;
    // GUARD: Configuration exists but has no targets.
    if (actors.length === 0 && otherActors.length === 0) {
      throw new ClickValidationError("Action configured with no targets.", "click");
    }

    // GUARD: One or more target LSH actors are offline.
    const offlineActors = actors.filter(
      (actor) => !this.deviceManager.getDevice(actor.name)?.connected
    );
    if (offlineActors.length > 0) {
      const names = offlineActors.map((a) => a.name).join(", ");
      throw new ClickValidationError(`Target actor(s) are offline: ${names}.`, "click");
    }

    // SUCCESS: All validations passed.
    return { actors, otherActors };
  }


  /**
    * Orchestrates the two-phase commit protocol for "Network Clicks".
    * This method now acts as a dispatcher, delegating to helper methods based
    * on whether the click is a new request or a confirmation.
    * @param deviceName - The name of the device that sent the click.
    * @param payload - The validated NetworkClickPayload.
    */
  private handleNetworkClick(
    deviceName: string,
    payload: NetworkClickPayload
  ): void {
    if (payload.c) { // c: isConfirmation
      this._processClickConfirmation(deviceName, payload);
    } else {
      this._processNewClickRequest(deviceName, payload);
    }
  }

  /**
   * @internal
   * @description Processes the first phase of a network click: a new request.
   * It validates the request and, if successful, sends an ACK.
   * If validation throws, it catches the error and sends the appropriate failover command.
   */
  private _processNewClickRequest(
    deviceName: string,
    payload: NetworkClickPayload
  ): void {
    const { bi: buttonId, ct: clickType } = payload;
    const transactionKey = `${deviceName}.${buttonId}.${clickType}`;
    const commandTopic = `${this.config.lshBasePath}${deviceName}/IN`;

    try {
      // The "happy path" is now clean and linear.
      const { actors, otherActors } = this._validateClickRequest(
        deviceName,
        buttonId,
        clickType
      );

      this.clickManager.startTransaction(transactionKey, actors, otherActors);

      // Send ACK to the device, starting Phase 2.
      this.send({
        [Output.Lsh]: {
          topic: commandTopic,
          payload: { p: LshProtocol.NETWORK_CLICK_ACK, ct: clickType, bi: buttonId },
        },
      });
      this.node.log(`Validation OK for ${transactionKey}. Sending ACK.`);

    } catch (error) {
      // The "error path" is neatly contained in the catch block.
      if (error instanceof ClickValidationError) {
        if (error.failoverType === 'general') {
          this.node.error(`System failure on click ${transactionKey}: ${error.reason}. Sending General Failover (c_gf).`);
          this.send({ [Output.Lsh]: { topic: commandTopic, payload: { p: LshProtocol.GENERAL_FAILOVER } } });
        } else {
          this.node.warn(`Click validation failed for ${transactionKey}: ${error.reason}. Sending Click Failover (c_f).`);
          this.send({ [Output.Lsh]: { topic: commandTopic, payload: { p: LshProtocol.CLICK_FAILOVER, ct: clickType, bi: buttonId } } });
        }
      } else {
        // Handle unexpected errors
        this.node.error(`Unexpected error during click processing for ${transactionKey}: ${error}`);
      }
    }
  }

  /**
   * @internal
   * @description Processes the second phase of a network click: a confirmation.
   * It consumes the transaction and executes the click logic.
   * @param deviceName - The name of the device that sent the click.
   * @param payload - The validated NetworkClickPayload.
   */
  private _processClickConfirmation(
    deviceName: string,
    payload: NetworkClickPayload
  ): void {
    const { bi: buttonId, ct: clickType } = payload;
    const transactionKey = `${deviceName}.${buttonId}.${clickType}`;

    const transaction = this.clickManager.consumeTransaction(transactionKey);
    if (!transaction) {
      this.node.warn(`Received confirmation for an expired or unknown click: ${transactionKey}.`);
      return;
    }

    this.node.log(`Click confirmed for ${transactionKey}. Executing logic.`);
    this.executeClickLogic(transaction.actors, transaction.otherActors, clickType);
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
        `Smart Toggle: ${toggleResult.active}/${toggleResult.total
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
     * This method now follows a cleaner, more declarative pattern:
     * 1. Iterates through all configured devices.
     * 2. Asks the Watchdog for a health assessment.
     * 3. Tells the DeviceRegistryManager to update the device's state based on the assessment.
     * 4. Collects and performs necessary actions (sending pings and alerts) at the end.
     */
  private async runWatchdogCheck(): Promise<void> {
    if (!this.longClickConfig || this.longClickConfig.devices.length === 0) {
      return;
    }

    const now = Date.now();
    const actions: WatchdogActions = {
      devicesToPing: new Set<string>(),
      unhealthyDevicesForAlert: [],
      stateChanged: false,
    };

    // The orchestrator owns the loop, making the flow explicit.
    for (const deviceConfig of this.longClickConfig.devices) {
      const deviceName = deviceConfig.name;
      const deviceState = this.deviceManager.getDevice(deviceName);

      // 1. Ask the Watchdog for a pure, logical assessment.
      const result = this.watchdog.checkDeviceHealth(deviceState, now);

      // 2. Tell the manager to update its state based on the result.
      const { stateChanged } = this.deviceManager.updateHealthFromResult(deviceName, result);
      if (stateChanged) {
        actions.stateChanged = true;
      }

      // 3. The orchestrator collects actions based on the assessment.
      switch (result.status) {
        case "needs_ping":
          actions.devicesToPing.add(deviceName);
          break;
        case "stale":
          // When a device becomes stale, it's considered unhealthy for alerting.
          actions.unhealthyDevicesForAlert.push({ name: deviceName, reason: "No response to ping." });
          // We also try pinging it again.
          actions.devicesToPing.add(deviceName);
          break;
        case "unhealthy":
          actions.unhealthyDevicesForAlert.push({ name: deviceName, reason: result.reason });
          break;
      }
    }

    // 4. The orchestrator executes the collected actions.
    if (actions.stateChanged) {
      this.updateExposedState();
    }
    if (actions.devicesToPing.size > 0) {
      await this._sendPings(actions);
    }
    if (actions.unhealthyDevicesForAlert.length > 0) {
      this._sendAlerts(actions);
    }
  }

  // --- Watchdog Helper Methods ---

  /**
   * @internal
   * @description Sends ping commands to a list of devices.
   * It uses a single broadcast ping if all devices need pinging.
   * @param actions - The collected watchdog actions.
   */
  private async _sendPings(actions: WatchdogActions): Promise<void> {
    const devicesToPing = Array.from(actions.devicesToPing);
    const totalConfiguredDevices = this.longClickConfig!.devices.length;

    if (devicesToPing.length === totalConfiguredDevices) {
      this.node.log(`All ${totalConfiguredDevices} devices are silent. Sending a single broadcast ping.`);
      this.send({ [Output.Lsh]: { topic: this.config.serviceTopic, payload: { p: LshProtocol.PING } } });
    } else {
      this.node.log(`Sending staggered pings to ${devicesToPing.length} device(s)...`);
      for (const deviceName of devicesToPing) {
        const pingCommand = { topic: `${this.config.lshBasePath}${deviceName}/IN`, payload: { p: LshProtocol.PING } };
        this.send({ [Output.Lsh]: pingCommand });
        await sleep(Math.random() * 200 + 50);
      }
    }
  }

  /**
   * @internal
   * @description Formats and sends an alert message for unhealthy devices.
   * @param actions - The collected watchdog actions.
   */
  private _sendAlerts(actions: WatchdogActions): void {
    this.send({
      [Output.Alerts]: { payload: formatAlertMessage(actions.unhealthyDevicesForAlert) },
    });
  }

  /**
   * @internal
   * @description Dispatches an incoming LSH message to the correct handler based on its topic suffix.
   * @param deviceName - The name of the device that sent the message.
   * @param suffix - The final part of the topic (e.g., 'conf', 'state', 'misc').
   * @param payload - The message payload.
   */
  private _handleLshMessage(deviceName: string, suffix: 'conf' | 'state' | 'misc', payload: any): void {
    const handler = this.lshMessageHandlers[suffix];
    if (handler) {
      handler(deviceName, payload);
    }
  }

  /**
   * @internal
   * @description Handles 'conf' messages by validating the payload and storing device details.
   * @param deviceName - The name of the device.
   * @param payload - The 'conf' message payload.
   */
  private _handleConfMessage(deviceName: string, payload: any): void {
    if (this.validateConfPayload(payload)) {
      this.storeDeviceDetails(deviceName, payload as DeviceConfPayload);
    } else {
      this.node.warn(
        `Invalid 'conf' payload from ${deviceName}: ${this.ajv.errorsText(
          this.validateConfPayload.errors
        )}`
      );
    }
  }

  /**
   * @internal
   * @description Handles 'state' messages by validating the payload and storing actuator states.
   * @param deviceName - The name of the device.
   * @param payload - The 'state' message payload.
   */
  private _handleStateMessage(deviceName: string, payload: any): void {
    if (this.validateStatePayload(payload)) {
      this.storeDeviceState(deviceName, (payload as DeviceStatePayload).as);
    } else {
      this.node.warn(
        `Invalid 'state' payload from ${deviceName}: ${this.ajv.errorsText(
          this.validateStatePayload.errors
        )}`
      );
    }
  }

  /**
   * @internal
   * @description Handles 'misc' messages, dispatching them to further logic based on the protocol identifier 'p'.
   * @param deviceName - The name of the device.
   * @param payload - The 'misc' message payload.
   */
  private _handleMiscMessage(deviceName: string, payload: any): void {
    if (!this.validateAnyMiscPayload(payload)) {
      this.node.warn(`Received invalid or unhandled 'misc' payload from ${deviceName}.`);
      this.send({
        [Output.Debug]: {
          payload: {
            error: "Invalid Misc Payload", topic: `${this.config.lshBasePath}${deviceName}/misc`, receivedPayload: payload,
          },
        },
      });
      return;
    }

    const miscPayload = payload as AnyDeviceMiscPayload;
    switch (miscPayload.p) {
      case LshProtocol.NETWORK_CLICK:
        this.handleNetworkClick(deviceName, miscPayload);
        break;
      case LshProtocol.DEVICE_BOOT:
        this.node.log(`Device '${deviceName}' reported a boot event.`);
        const device = this.deviceManager.getDevice(deviceName);
        if (device) {
          device.lastSeenTime = Date.now();
          device.lastBootTime = Date.now();
          this.updateExposedState();
        }
        break;
      case LshProtocol.PING:
        this.node.log(`Received ping response from '${deviceName}'.`);
        const pingingDevice = this.deviceManager.getDevice(deviceName);
        if (pingingDevice) {
          pingingDevice.lastSeenTime = Date.now();
          if (pingingDevice.isStale) {
            this.node.log(`Device '${deviceName}' is no longer stale.`);
            pingingDevice.isStale = false;
          }
          this.updateExposedState();
        }
        break;
    }
  }

  /**
   * The main handler for all incoming messages. It dispatches messages to the
   * appropriate logic by matching their topic against the declarative routing table.
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

      // Iterate through the routing table to find a matching handler.
      for (const route of this.routes) {
        const match = topic.match(route.regex);
        if (match) {
          // The first capture group is always the device name.
          const deviceName = match[1];
          // Subsequent capture groups are other dynamic parts of the topic.
          const otherParts = match.slice(2);

          route.handler(deviceName, msg.payload, otherParts);
          processed = true;
          break; // Stop after the first matching route is found.
        }
      }

      if (!processed) {
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