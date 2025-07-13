/**
 * @file This file contains the core business logic for the LSH Logic system.
 * The LshLogicService class orchestrates the various managers (`DeviceRegistryManager`, etc.)
 * and is completely decoupled from the Node-RED runtime. It returns descriptive
 * results (`ServiceResult`) rather than performing I/O actions itself. This design
 * makes the core logic pure, portable, and easy to test.
 */

import { DeviceRegistryManager } from "./DeviceRegistryManager";
import { ClickTransactionManager } from "./ClickTransactionManager";
import { Watchdog } from "./Watchdog";
import {
  ClickType,
  DeviceEntry,
  SystemConfig,
  DeviceDetailsPayload,
  DeviceActuatorsStatePayload,
  AnyMiscTopicPayload,
  NetworkClickPayload,
  LshProtocol,
  Actor,
  ServiceResult,
  Output,
  OutputMessages,
} from "./types";
import { formatAlertMessage } from "./utils";
import { NodeMessage } from "node-red";
import { ValidateFunction } from "ajv";

/**
 * Defines the structure for a single route in the topic routing table.
 * @internal
 */
type TopicRoute = {
  regex: RegExp;
  handler: (deviceName: string, payload: unknown, parts: string[]) => ServiceResult;
};

/**
 * Collects actions to be performed at the end of a watchdog cycle.
 * @internal
 */
type WatchdogActions = {
  devicesToPing: Set<string>;
  unhealthyDevicesForAlert: Array<{ name: string; reason: string }>;
  stateChanged: boolean;
};

/**
 * Custom error for handling click validation failures gracefully. This allows
 * the service to distinguish between different failure types and provide
 * specific feedback to the device.
 * @internal
 */
export class ClickValidationError extends Error {
  constructor(
    public readonly reason: string,
    public readonly failoverType: "general" | "click"
  ) {
    super(reason);
    this.name = "ClickValidationError";
  }
}

/**
 * @class LshLogicService
 * @description The main service class for LSH Logic. It contains all business logic
 * and state, but does not interact directly with the Node-RED runtime.
 * It orchestrates the various managers and returns descriptive results (`ServiceResult`)
 * rather than performing I/O actions itself.
 */
export class LshLogicService {
  private readonly deviceManager: DeviceRegistryManager;
  private readonly clickManager: ClickTransactionManager;
  private readonly watchdog: Watchdog;

  private readonly lshBasePath: string;
  private readonly homieBasePath: string;
  private readonly serviceTopic: string;
  private readonly validators: {
    validateDeviceDetails: ValidateFunction;
    validateActuatorStates: ValidateFunction;
    validateAnyMiscTopic: ValidateFunction;
  };

  private systemConfig: SystemConfig | null = null;
  private deviceConfigMap: Map<string, DeviceEntry> = new Map();
  private readonly routes: TopicRoute[];

  /**
   * Constructs a new LshLogicService. Dependencies are injected to promote
   * loose coupling and high testability.
   * @param config - Core configuration values for the service.
   * @param otherActorsContext - A context reader for external device states.
   * @param validators - An object containing pre-compiled AJV validation functions.
   */
  constructor(
    config: {
      lshBasePath: string;
      homieBasePath: string;
      serviceTopic: string;
      otherDevicesPrefix: string;
      clickTimeout: number;
      interrogateThreshold: number;
      pingTimeout: number;
    },
    otherActorsContext: { get(key: string): unknown },
    validators: {
      validateDeviceDetails: ValidateFunction;
      validateActuatorStates: ValidateFunction;
      validateAnyMiscTopic: ValidateFunction;
    }
  ) {
    this.lshBasePath = config.lshBasePath;
    this.homieBasePath = config.homieBasePath;
    this.serviceTopic = config.serviceTopic;
    this.validators = validators;

    this.deviceManager = new DeviceRegistryManager(
      config.otherDevicesPrefix,
      otherActorsContext
    );
    this.clickManager = new ClickTransactionManager(config.clickTimeout);
    this.watchdog = new Watchdog(
      config.interrogateThreshold,
      config.pingTimeout
    );
    this.routes = this._createTopicRoutes();
  }

  /**
   * Actively verifies the state of all configured devices after an initial grace period.
   * This method identifies devices that haven't reported as 'connected' via Homie
   * and generates targeted pings to check their LSH-level health.
   * @returns A ServiceResult containing targeted ping commands.
   */
  public verifyInitialDeviceStates(): ServiceResult {
    const result = this.createEmptyResult();
    if (!this.systemConfig) {
      result.warnings.push(
        "Cannot run initial state verification: config not loaded."
      );
      return result;
    }

    const configuredDevices = this.getConfiguredDeviceNames() as string[];
    const registry = this.deviceManager.getRegistry();
    const silentDevices: string[] = [];

    for (const deviceName of configuredDevices) {
      const deviceState = registry[deviceName];
      // A device is considered silent if it's not in the registry yet, or if it is but isn't connected.
      if (!deviceState || !deviceState.connected) {
        silentDevices.push(deviceName);
      }
    }

    if (silentDevices.length > 0) {
      result.logs.push(
        `Initial state verification: ${silentDevices.length} device(s) did not report 'ready' state. Pinging them directly.`
      );

      // Generate targeted ping commands for only the silent devices.
      const pingCommands: NodeMessage[] = silentDevices.map((deviceName) => ({
        topic: `${this.lshBasePath}${deviceName}/IN`,
        payload: { p: LshProtocol.PING },
        qos: 1,
      }));

      result.messages[Output.Lsh] = pingCommands;
    } else {
      result.logs.push(
        "Initial state verification: all configured devices are connected."
      );
    }

    return result;
  }

  /**
   * Runs a final check on devices that were pinged during initial verification.
   * Any device from the list that is still not healthy is now declared unhealthy.
   * @param pingedDevices - An array of device names that were pinged.
   * @returns A ServiceResult containing alerts for any unresponsive devices.
   */
  public runFinalVerification(pingedDevices: string[]): ServiceResult {
    const result = this.createEmptyResult();
    const registry = this.deviceManager.getRegistry();
    const unhealthyDevicesForAlert: { name: string; reason: string }[] = [];

    for (const deviceName of pingedDevices) {
      const deviceState = registry[deviceName];

      // If the device is still not healthy after being pinged, it's officially unresponsive.
      if (!deviceState || !deviceState.isHealthy) {
        unhealthyDevicesForAlert.push({
          name: deviceName,
          reason: "Did not respond to initial verification ping.",
        });

        // Forcibly update its state in the registry for consistency
        if (deviceState) {
          this.deviceManager.updateHealthFromResult(
            deviceName,
            { status: "unhealthy", reason: "Initial ping failed" }
          );
        }
        // Finding an unresponsive device is a state change for the system.
        result.stateChanged = true;
      }
    }

    if (unhealthyDevicesForAlert.length > 0) {
      result.warnings.push(
        `Final verification failed for: ${unhealthyDevicesForAlert
          .map((d) => d.name)
          .join(", ")}`
      );
      result.messages[Output.Alerts] = {
        payload: formatAlertMessage(unhealthyDevicesForAlert, "unhealthy"),
      };
    } else {
      result.logs.push(
        "Final verification successful: all pinged devices responded."
      );
    }

    return result;
  }

  /**
   * Updates the service's internal configuration from a new, validated config object.
   * It also prunes devices from the registry that are no longer in the new config.
   * @param newConfig - The new, validated SystemConfig.
   * @returns A log message indicating the result of the update.
   */
  public updateSystemConfig(newConfig: SystemConfig): string {
    this.systemConfig = newConfig;
    this.deviceConfigMap.clear();

    const newDeviceNames = new Set(
      this.systemConfig.devices.map((d) => d.name)
    );
    for (const device of this.systemConfig.devices) {
      this.deviceConfigMap.set(device.name, device);
    }

    const prunedDevices = [];
    for (const deviceName in this.deviceManager.getRegistry()) {
      if (!newDeviceNames.has(deviceName)) {
        this.deviceManager.pruneDevice(deviceName);
        prunedDevices.push(deviceName);
      }
    }
    let logMessage = "System configuration successfully loaded and validated.";
    if (prunedDevices.length > 0) {
      logMessage += ` Pruned stale devices from registry: ${prunedDevices.join(
        ", "
      )}.`;
    }
    return logMessage;
  }

  /**
   * Resets the configuration to null, typically on a file loading or validation error.
   */
  public clearSystemConfig(): void {
    this.systemConfig = null;
    this.deviceConfigMap.clear();
  }

  /**
   * Gets the list of all configured device names from the loaded config.
   * @returns An array of device names or null if the config is not loaded.
   */
  public getConfiguredDeviceNames(): string[] | null {
    return this.systemConfig
      ? this.systemConfig.devices.map((d) => d.name)
      : null;
  }

  /**
   * Generates a ServiceResult with commands to be sent on node startup.
   * This is now a passive action, waiting for Homie state messages.
   * @returns A ServiceResult containing the startup commands.
   */
  public getStartupCommands(): ServiceResult {
    const result = this.createEmptyResult();
    if (!this.systemConfig || this.systemConfig.devices.length === 0) {
      result.warnings.push(
        "Cannot generate startup commands: config not loaded."
      );
      return result;
    }
    result.logs.push(
      "Node started. Passively waiting for device Homie state announcements."
    );
    return result;
  }

  /**
   * Creates an empty ServiceResult object to be populated.
   * @internal
   */
  private createEmptyResult(): ServiceResult {
    return {
      messages: {},
      logs: [],
      warnings: [],
      errors: [],
      stateChanged: false,
    };
  }

  /**
   * Processes an incoming message by matching its topic against the routing table.
   * @param topic - The MQTT topic of the message.
   * @param payload - The payload of the message.
   * @returns A ServiceResult describing the actions to be taken.
   */
  public processMessage(topic: string, payload: unknown): ServiceResult {
    if (!this.systemConfig) {
      const result = this.createEmptyResult();
      result.warnings.push("Configuration not loaded, ignoring message.");
      return result;
    }

    for (const route of this.routes) {
      const match = topic.match(route.regex);
      if (match) {
        const deviceName = match[1];
        const otherParts = match.slice(2);
        this.watchdog.onDeviceActivity(deviceName);
        const handlerPayload = topic.includes("$state") ? payload : payload;
        return route.handler(deviceName, handlerPayload, otherParts);
      }
    }
    const result = this.createEmptyResult();
    result.logs.push(`Message on unhandled topic: ${topic}`);
    return result;
  }

  /**
   * Returns a copy of the device registry for external use (e.g., exposing to context).
   */
  public getDeviceRegistry() {
    return this.deviceManager.getRegistry();
  }

  /**
   * Runs the periodic watchdog check across all configured devices.
   * @returns A ServiceResult containing any pings or alerts to be sent.
   */
  public runWatchdogCheck(): ServiceResult {
    const result = this.createEmptyResult();
    if (!this.systemConfig || this.systemConfig.devices.length === 0) {
      return result;
    }

    const now = Date.now();
    const actions: WatchdogActions = {
      devicesToPing: new Set<string>(),
      unhealthyDevicesForAlert: [],
      stateChanged: false,
    };

    for (const deviceConfig of this.systemConfig.devices) {
      this._processWatchdogForDevice(deviceConfig.name, now, actions);
    }

    result.stateChanged = actions.stateChanged;
    if (actions.devicesToPing.size > 0) {
      const { messages, logs } = this._preparePings(actions);
      Object.assign(result.messages, messages);
      result.logs.push(...logs);
    }

    if (actions.unhealthyDevicesForAlert.length > 0) {
      const alertResult = this._prepareAlerts(
        actions.unhealthyDevicesForAlert,
        "unhealthy"
      );
      Object.assign(result.messages, alertResult.messages);
    }
    return result;
  }

  /**
   * @internal
   * Processes the watchdog health check for a single device and updates the collected actions.
   */
  private _processWatchdogForDevice(
    deviceName: string,
    now: number,
    actions: WatchdogActions
  ): void {
    const deviceState = this.deviceManager.getDevice(deviceName);
    // Optimization: If a device is already known to be offline and an alert has been sent,
    // skip any further checks on it until it comes back online. This prevents redundant work and log spam.
    if (deviceState && !deviceState.isHealthy && deviceState.alertSent) {
      return; // Skip already alerted devices
    }
    const healthResult = this.watchdog.checkDeviceHealth(deviceState, now);
    const { stateChanged } = this.deviceManager.updateHealthFromResult(
      deviceName,
      healthResult
    );
    if (stateChanged) actions.stateChanged = true;

    switch (healthResult.status) {
      case "needs_ping":
        actions.devicesToPing.add(deviceName);
        break;
      case "stale":
        actions.unhealthyDevicesForAlert.push({
          name: deviceName,
          reason: "No response to ping.",
        });
        actions.devicesToPing.add(deviceName);
        break;
      case "unhealthy":
        actions.unhealthyDevicesForAlert.push({
          name: deviceName,
          reason: healthResult.reason,
        });
        const { stateChanged } = this.deviceManager.recordAlertSent(deviceName);
        /* istanbul ignore if */
        if (stateChanged) {
          actions.stateChanged = true;
        }
        break;
    }
  }

  /**
   * Cleans up expired click transactions via the ClickTransactionManager.
   * @returns A log message if any transactions were cleaned.
   */
  public cleanupPendingClicks(): string | null {
    const cleanedCount = this.clickManager.cleanupExpired();
    return cleanedCount > 0
      ? `Cleaned up ${cleanedCount} expired click transactions.`
      : null;
  }

  /**
   * Creates and returns the topic routing table.
   * This method defines a regex for each topic structure the service listens to
   * and maps it to a specific handler function. This approach provides a clean,
   * scalable, and maintainable way to process incoming MQTT messages.
   * @internal
   * @returns {TopicRoute[]} An array of topic route definitions.
   */
  private _createTopicRoutes(): TopicRoute[] {
    return [
      /**
       * Handles Homie device state messages (e.g., 'homie/my-device/$state').
       * This is the primary mechanism for detecting if a device is online or offline.
       */
      {
        regex: new RegExp(`^${this.homieBasePath}([^/]+)/\\$state$`),
        handler: (deviceName, payload) => {
          const result = this.createEmptyResult();
          const homieState = String(payload);
          const { changed, connected, wentOffline, cameOnline } =
            this.deviceManager.updateConnectionState(deviceName, homieState);

          if (changed) {
            result.stateChanged = true;
            result.logs.push(
              `Device '${deviceName}' connection state changed to '${homieState}'.`
            );
          }

          if (wentOffline) {
            const alertInfo = [
              {
                name: deviceName,
                reason: `Device reported as '${homieState}' by Homie.`,
              },
            ];
            Object.assign(
              result.messages,
              this._prepareAlerts(alertInfo, "unhealthy").messages
            );
          } else if (cameOnline) {
            result.logs.push(
              `Device '${deviceName}' came back online (Homie state: ready).`
            );
            const alertInfo = [
              {
                name: deviceName,
                reason: "Device is now connected and healthy.",
              },
            ];
            Object.assign(
              result.messages,
              this._prepareAlerts(alertInfo, "healthy").messages
            );
          }

          // If the device just came online, proactively request its full configuration and state.
          if (changed && connected) {
            result.logs.push(
              `Device '${deviceName}' is online. Requesting full state (details and actuators).`
            );
            result.messages[Output.Lsh] = [
              {
                topic: `${this.lshBasePath}${deviceName}/IN`,
                payload: { p: LshProtocol.SEND_DEVICE_DETAILS },
                qos: 1,
              },
              {
                topic: `${this.lshBasePath}${deviceName}/IN`,
                payload: { p: LshProtocol.SEND_ACTUATORS_STATE },
                qos: 1,
              },
            ];
          }
          return result;
        },
      },

      /**
       * Handles LSH device configuration messages (e.g., 'LSH/my-device/conf').
       * This message contains the device's static details, like its actuator and button IDs.
       * It is crucial for the node's ability to control the device.
       */
      {
        regex: new RegExp(`^${this.lshBasePath}([^/]+)/conf$`),
        handler: (deviceName, payload) => {
          const result = this.createEmptyResult();
          if (!this.validators.validateDeviceDetails(payload)) {
            const errorText =
              this.validators.validateDeviceDetails.errors
                ?.map((e) => e.message)
                .join(", ") || "unknown validation error";
            result.warnings.push(
              `Invalid 'conf' payload from ${deviceName}: ${errorText}`
            );
            return result;
          }
          const { changed } = this.deviceManager.registerDeviceDetails(
            deviceName,
            payload as DeviceDetailsPayload
          );
          if (changed) {
            result.logs.push(
              `Stored/Updated details for device '${deviceName}'.`
            );
            result.stateChanged = true;
          }
          return result;
        },
      },

      /**
       * Handles LSH device actuator state messages (e.g., 'LSH/my-device/state').
       * This message reports the current ON/OFF status of all device actuators.
       */
      {
        regex: new RegExp(`^${this.lshBasePath}([^/]+)/state$`),
        handler: (deviceName, payload) => {
          const result = this.createEmptyResult();
          if (!this.validators.validateActuatorStates(payload)) {
            const errorText =
              this.validators.validateActuatorStates.errors
                ?.map((e) => e.message)
                .join(", ") || "unknown validation error";
            result.warnings.push(
              `Invalid 'state' payload from ${deviceName}: ${errorText}`
            );
            return result;
          }
          try {
            const { isNew, changed, configIsMissing } =
              this.deviceManager.registerActuatorStates(
                deviceName,
                (payload as DeviceActuatorsStatePayload).as
              );
            if (isNew)
              result.logs.push(
                `Received state for a new device: ${deviceName}. Creating partial entry.`
              );
            if (changed) {
              result.logs.push(
                `Updated state for '${deviceName}': [${(
                  payload as DeviceActuatorsStatePayload
                ).as.join(", ")}]`
              );
              result.stateChanged = true;
            }
            // If we receive a state but don't have the device details (IDs), proactively request them.
            if (configIsMissing) {
              result.warnings.push(
                `Device '${deviceName}' sent state but its configuration is unknown. Requesting details.`
              );
              result.messages[Output.Lsh] = {
                topic: `${this.lshBasePath}${deviceName}/IN`,
                payload: { p: LshProtocol.SEND_DEVICE_DETAILS },
                qos: 1,
              };
            }
          } catch (error) {
            result.errors.push(
              error instanceof Error ? error.message : String(error)
            );
          }
          return result;
        },
      },

      /**
       * Handles miscellaneous LSH device messages (e.g., 'LSH/my-device/misc').
       * This topic is used for events like network clicks, pings, and boot notifications.
       */
      {
        regex: new RegExp(`^${this.lshBasePath}([^/]+)/misc$`),
        handler: (deviceName, payload) => {
          if (!this.validators.validateAnyMiscTopic(payload)) {
            const result = this.createEmptyResult();
            const errorText =
              this.validators.validateAnyMiscTopic.errors
                ?.map((e) => e.message)
                .join(", ") || "unknown validation error";
            result.warnings.push(
              `Invalid 'misc' payload from ${deviceName}: ${errorText}`
            );
            return result;
          }
          const miscPayload = payload as AnyMiscTopicPayload;
          const result = this.createEmptyResult();

          switch (miscPayload.p) {
            case LshProtocol.NETWORK_CLICK:
              return this.handleNetworkClick(deviceName, miscPayload);

            case LshProtocol.DEVICE_BOOT:
              result.logs.push(`Device '${deviceName}' reported a boot event.`);
              if (this.deviceManager.recordBoot(deviceName).stateChanged) {
                result.stateChanged = true;
              }
              break;

            case LshProtocol.PING:
              const { stateChanged, cameOnline } =
                this.deviceManager.recordPingResponse(deviceName);
              if (stateChanged) {
                result.logs.push(`Device '${deviceName}' is now responsive.`);
                result.stateChanged = true;
              } else {
                result.logs.push(
                  `Received ping response from '${deviceName}'.`
                );
              }
              if (cameOnline) {
                result.logs.push(
                  `Device '${deviceName}' is healthy again after ping response.`
                );
                const alertInfo = [
                  {
                    name: deviceName,
                    reason: "Device responded to ping and is now healthy.",
                  },
                ];
                Object.assign(
                  result.messages,
                  this._prepareAlerts(alertInfo, "healthy").messages
                );
              }
              break;
          }
          return result;
        },
      },
    ];
  }

  /**
   * Orchestrates the two-phase commit protocol for "Network Clicks".
   * @internal
   */
  private handleNetworkClick(
    deviceName: string,
    payload: NetworkClickPayload
  ): ServiceResult {
    if (payload.c) {
      // isConfirmation
      return this._processClickConfirmation(deviceName, payload);
    } else {
      return this._processNewClickRequest(deviceName, payload);
    }
  }

  /**
   * Processes the first phase of a network click: a new request from a device.
   * Validates the request and sends an ACK if successful, or a FAILOVER if not.
   * @internal
   */
  private _processNewClickRequest(
    deviceName: string,
    payload: NetworkClickPayload
  ): ServiceResult {
    const result = this.createEmptyResult();
    const { bi: buttonId, ct: clickType } = payload;
    const transactionKey = `${deviceName}.${buttonId}.${clickType}`;
    const commandTopic = `${this.lshBasePath}${deviceName}/IN`;

    try {
      const { actors, otherActors } = this._validateClickRequest(
        deviceName,
        buttonId,
        clickType
      );
      this.clickManager.startTransaction(transactionKey, actors, otherActors);

      result.messages[Output.Lsh] = {
        topic: commandTopic,
        payload: {
          p: LshProtocol.NETWORK_CLICK_ACK,
          ct: clickType,
          bi: buttonId,
        },
        qos: 2,
      };
      result.logs.push(`Validation OK for ${transactionKey}. Sending ACK.`);
    } catch (error) {
      if (error instanceof ClickValidationError) {
        const alertInfo = [
          { name: deviceName, reason: `Action failed: ${error.reason}` },
        ];
        const alertResult = this._prepareAlerts(
          alertInfo,
          "unhealthy",
          payload
        );
        Object.assign(result.messages, alertResult.messages);

        if (error.failoverType === "general") {
          result.errors.push(
            `System failure on click. Sending General Failover (c_gf).`
          );
          result.messages[Output.Lsh] = {
            topic: commandTopic,
            payload: { p: LshProtocol.GENERAL_FAILOVER },
            qos: 2,
          };
        } else {
          result.messages[Output.Lsh] = {
            topic: commandTopic,
            payload: { p: LshProtocol.FAILOVER, ct: clickType, bi: buttonId },
            qos: 2,
          };
        }
      } else {
        result.errors.push(
          `Unexpected error during click processing for ${transactionKey}: ${String(error)}`
        );
      }
    }
    return result;
  }

  /**
   * Processes the second phase of a network click: a confirmation from the device.
   * @internal
   */
  private _processClickConfirmation(
    deviceName: string,
    payload: NetworkClickPayload
  ): ServiceResult {
    const result = this.createEmptyResult();
    const { bi: buttonId, ct: clickType } = payload;
    const transactionKey = `${deviceName}.${buttonId}.${clickType}`;

    const transaction = this.clickManager.consumeTransaction(transactionKey);
    if (!transaction) {
      result.warnings.push(
        `Received confirmation for an expired or unknown click: ${transactionKey}.`
      );
      return result;
    }

    result.logs.push(`Click confirmed for ${transactionKey}. Executing logic.`);
    const logicResult = this.executeClickLogic(
      transaction.actors,
      transaction.otherActors,
      clickType
    );

    Object.assign(result.messages, logicResult.messages);
    result.logs.push(...logicResult.logs);
    result.warnings.push(...logicResult.warnings);

    return result;
  }

  /**
   * Validates a new network click request against the current system state and configuration.
   * This method uses guard clauses and throws a `ClickValidationError` on failure.
   * @returns An object with the validated actors if successful.
   * @throws {ClickValidationError} If the validation fails for any reason.
   * @internal
   */
  private _validateClickRequest(
    deviceName: string,
    buttonId: string,
    clickType: ClickType
  ): { actors: Actor[]; otherActors: string[] } {
    const deviceConfig = this.deviceConfigMap.get(deviceName);
    const clickTypeKey =
      clickType === ClickType.Long
        ? "longClickButtons"
        : "superLongClickButtons";
    const buttonConfig = deviceConfig?.[clickTypeKey]?.find(
      (btn) => btn.id === buttonId
    );

    if (!buttonConfig)
      throw new ClickValidationError(
        "No action configured for this button.",
        "click"
      );

    const { actors = [], otherActors = [] } = buttonConfig;
    if (actors.length === 0 && otherActors.length === 0)
      throw new ClickValidationError(
        "Action configured with no targets.",
        "click"
      );

    const offlineActors = actors.filter(
      (actor) => !this.deviceManager.getDevice(actor.name)?.connected
    );
    if (offlineActors.length > 0) {
      const names = offlineActors.map((a) => a.name).join(", ");
      throw new ClickValidationError(
        `Target actor(s) are offline: ${names}.`,
        "click"
      );
    }

    return { actors, otherActors };
  }

  /**
   * Orchestrates the execution of a confirmed click action, generating the necessary commands.
   * @param actors - The primary target actors (LSH).
   * @param otherActors - The secondary target actors (external).
   * @param clickType - The type of click ('lc' or 'slc').
   * @internal
   */
  private executeClickLogic(
    actors: Actor[],
    otherActors: string[],
    clickType: ClickType
  ): Pick<ServiceResult, "messages" | "logs" | "warnings"> {
    const result: Pick<ServiceResult, "messages" | "logs" | "warnings"> = {
      messages: {},
      logs: [],
      warnings: [],
    };
    let stateToSet: boolean;

    if (clickType === ClickType.SuperLong) {
      stateToSet = false; // Super-long-click always turns devices off.
      result.logs.push("Executing SLC logic: setting state to OFF.");
    } else {
      // Long-click uses the "smart toggle" logic.
      const toggleResult = this.deviceManager.getSmartToggleState(
        actors,
        otherActors
      );
      if (toggleResult.warning) result.warnings.push(toggleResult.warning);
      result.logs.push(
        `Smart Toggle: ${toggleResult.active}/${toggleResult.total
        } active. Decision: ${toggleResult.stateToSet ? "ON" : "OFF"}`
      );
      stateToSet = toggleResult.stateToSet;
    }

    const lshCommands = this.buildStateCommands(actors, stateToSet);
    if (lshCommands.length > 0) {
      result.messages[Output.Lsh] = lshCommands;
    }

    if (otherActors.length > 0) {
      result.messages[Output.OtherActors] = {
        otherActors,
        stateToSet,
        payload: `Set state=${stateToSet} for external actors.`,
      };
    }
    return result;
  }

  /**
   * Builds an array of MQTT messages to set the state of LSH actuators.
   * @internal
   */
  private buildStateCommands(
    actors: Actor[],
    stateToSet: boolean
  ): NodeMessage[] {
    const commands: NodeMessage[] = [];
    for (const actor of actors) {
      // The device's existence is guaranteed by _validateClickRequest.
      // We can assert non-null here to satisfy TypeScript.
      const device = this.deviceManager.getDevice(actor.name)!;

      const commandTopic = `${this.lshBasePath}${actor.name}/IN`;
      // Optimization: use the more specific 'c_asas' command if only one actuator is targeted.
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
          qos: 2,
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
          payload: {
            p: LshProtocol.APPLY_ALL_ACTUATORS_STATE,
            as: newState,
          },
          qos: 2,
        });
      }
    }
    return commands;
  }

  /**
   * Prepares ping commands for a list of devices. It decides whether to use
   * a single broadcast ping or staggered individual pings.
   * @internal
   */
  private _preparePings(actions: WatchdogActions): {
    messages: OutputMessages;
    logs: string[];
  } {
    const messages: OutputMessages = {};
    const logs: string[] = [];
    const devicesToPing = Array.from(actions.devicesToPing);
    const totalConfiguredDevices = this.systemConfig!.devices.length;

    if (devicesToPing.length === totalConfiguredDevices) {
      logs.push(
        `All ${totalConfiguredDevices} devices are silent. Preparing a single broadcast ping.`
      );
      messages[Output.Lsh] = {
        topic: this.serviceTopic,
        payload: { p: LshProtocol.PING },
        qos: 1,
      };
    } else {
      logs.push(
        `Preparing staggered pings for ${devicesToPing.length} device(s)...`
      );
      const pingCommands: NodeMessage[] = devicesToPing.map((deviceName) => ({
        topic: `${this.lshBasePath}${deviceName}/IN`,
        payload: { p: LshProtocol.PING },
        qos: 1,
      }));
      messages[Output.Lsh] = pingCommands;
    }
    return { messages, logs };
  }

  /**
   * Formats and prepares an alert message for devices that have changed state.
   * @internal
   * @param devices - The list of devices to include in the alert.
   * @param status - The health status to report ('healthy' or 'unhealthy').
   * @param details - Optional details object to append to the message.
   * @returns An object containing the formatted message for the Alerts output.
   */
  private _prepareAlerts(
    devices: { name: string; reason: string }[],
    status: "healthy" | "unhealthy",
    details?: object
  ): { messages: OutputMessages } {
    return {
      messages: {
        [Output.Alerts]: {
          payload: formatAlertMessage(devices, status, details),
        },
      },
    };
  }
}
