/**
 * @file This file contains the core business logic for the LSH Logic system.
 * The LshLogicService class orchestrates the various managers (`DeviceRegistryManager`, etc.)
 * and is completely decoupled from the Node-RED runtime. It returns descriptive
 * results (`ServiceResult`) rather than performing I/O actions itself. This design
 * makes the core logic pure, portable, and easy to test.
 */

import { DeviceRegistryManager } from "./DeviceRegistryManager";
import { ClickTransactionManager } from "./ClickTransactionManager";
import { HomieDiscoveryManager } from "./HomieDiscoveryManager";
import { LshCodec } from "./LshCodec";
import { Watchdog } from "./Watchdog";
import { ClickType, LSH_WIRE_PROTOCOL_MAJOR, LshProtocol, Output } from "./types";
import type {
  Actor,
  AlertPayload,
  AnyMiscTopicPayload,
  BootPayload,
  DeviceActuatorsStatePayload,
  BridgeDiagnosticPayload,
  DeviceDetailsPayload,
  DeviceEntry,
  HomieLifecycleState,
  FailoverClickPayload,
  FailoverPayload,
  NetworkClickAckPayload,
  NetworkClickConfirmPayload,
  NetworkClickRequestPayload,
  OtherActorsCommandPayload,
  OutputMessages,
  PingPayload,
  ProcessMessageOptions,
  RequestDetailsPayload,
  RequestStatePayload,
  ServiceResult,
  SetSingleActuatorPayload,
  SetStatePayload,
  SystemConfig,
} from "./types";
import { formatAlertMessage } from "./utils";
import type { NodeMessage } from "node-red";
import type { ValidateFunction } from "ajv";

/**
 * Collects actions to be performed at the end of a watchdog cycle.
 * @internal
 */
type WatchdogActions = {
  devicesToPing: Set<string>;
  unhealthyDevicesForAlert: Array<{ name: string; reason: string }>;
  stateChanged: boolean;
};

const BIT_MASK_8 = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80] as const;

function buildClickSlotKey(deviceName: string, buttonId: number, clickType: ClickType): string {
  return `${deviceName}.${buttonId}.${clickType}`;
}

function buildClickCorrelationKey(
  deviceName: string,
  buttonId: number,
  clickType: ClickType,
  correlationId: number,
): string {
  return `${buildClickSlotKey(deviceName, buttonId, clickType)}.${correlationId}`;
}

function isDiagnosticOnlyHomieState(
  homieState: HomieLifecycleState,
): homieState is "init" | "sleeping" {
  return homieState === "init" || homieState === "sleeping";
}

function isBridgeDiagnosticPayload(
  payload: AnyMiscTopicPayload,
): payload is BridgeDiagnosticPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "bridge_diagnostic" in payload &&
    typeof payload.bridge_diagnostic === "string"
  );
}

/**
 * Custom error for handling click validation failures gracefully. This allows
 * the service to distinguish between different failure types and provide
 * specific feedback to the device.
 * @internal
 */
export class ClickValidationError extends Error {
  constructor(
    public readonly reason: string,
    public readonly failoverType: "general" | "click",
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
  private readonly discoveryManager: HomieDiscoveryManager;
  private readonly watchdog: Watchdog;

  private readonly lshBasePath: string;
  private readonly homieBasePath: string;
  private readonly haDiscovery: boolean;

  private readonly protocol: "json" | "msgpack";
  private readonly serviceTopic: string;
  private readonly codec: LshCodec;
  private readonly validators: {
    validateDeviceDetails: ValidateFunction;
    validateActuatorStates: ValidateFunction;
    validateAnyMiscTopic: ValidateFunction;
  };

  private systemConfig: SystemConfig | null = null;
  private deviceConfigMap: Map<string, DeviceEntry> = new Map();

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
      protocol: "json" | "msgpack";
      otherDevicesPrefix: string;
      clickTimeout: number;
      interrogateThreshold: number;
      pingTimeout: number;
      haDiscovery: boolean;
      haDiscoveryPrefix: string;
    },
    otherActorsContext: { get(key: string): unknown },
    validators: {
      validateDeviceDetails: ValidateFunction;
      validateActuatorStates: ValidateFunction;
      validateAnyMiscTopic: ValidateFunction;
    },
  ) {
    this.lshBasePath = config.lshBasePath;
    this.homieBasePath = config.homieBasePath;
    this.serviceTopic = config.serviceTopic;
    this.protocol = config.protocol;
    this.haDiscovery = config.haDiscovery;

    this.validators = validators;

    this.deviceManager = new DeviceRegistryManager(config.otherDevicesPrefix, otherActorsContext);
    this.discoveryManager = new HomieDiscoveryManager(
      config.homieBasePath,
      config.haDiscoveryPrefix,
    );
    this.clickManager = new ClickTransactionManager(config.clickTimeout);
    this.watchdog = new Watchdog(config.interrogateThreshold, config.pingTimeout);
    this.codec = new LshCodec();
  }

  /**
   * Returns a copy of the currently loaded system configuration object.
   * @returns The loaded SystemConfig or null if none is loaded.
   */
  public getSystemConfig(): SystemConfig | null {
    return this.systemConfig ? structuredClone(this.systemConfig) : null;
  }

  /**
   * Actively verifies the state of all configured devices after the startup
   * replay window. The check prefers the lightest recovery step that can close
   * each device gap:
   * - reachable but incomplete devices get only the missing snapshot requests
   * - still-unreachable devices get direct pings
   * @returns A ServiceResult describing the startup recovery work.
   */
  public verifyInitialDeviceStates(): ServiceResult {
    const result = this.createEmptyResult();
    if (!this.systemConfig) {
      result.warnings.push("Cannot run initial state verification: config not loaded.");
      return result;
    }

    const configuredDevices = this.getConfiguredDeviceNames() as string[];
    const unreachableDevices: string[] = [];
    const recoveryCommands: NodeMessage[] = [];

    for (const deviceName of configuredDevices) {
      const deviceState = this.deviceManager.getDevice(deviceName);
      if (!deviceState) {
        unreachableDevices.push(deviceName);
        continue;
      }

      if (!deviceState.connected) {
        unreachableDevices.push(deviceName);
        continue;
      }

      recoveryCommands.push(...this._buildSnapshotRecoveryCommands(deviceName));
    }

    if (recoveryCommands.length > 0) {
      const devicesNeedingRepair = new Set(
        recoveryCommands.map((command) => {
          const topic = String(command.topic);
          const baseLen = this.lshBasePath.length;
          const slashIndex = topic.indexOf("/", baseLen);
          return slashIndex === -1 ? topic : topic.substring(baseLen, slashIndex);
        }),
      );
      result.logs.push(
        `Initial state verification: ${devicesNeedingRepair.size} reachable device(s) still need authoritative snapshot recovery.`,
      );
      result.messages[Output.Lsh] = recoveryCommands;
    }

    if (unreachableDevices.length > 0) {
      result.logs.push(
        `Initial state verification: ${unreachableDevices.length} device(s) are still unreachable. Pinging them directly.`,
      );

      const pingCommands: NodeMessage[] = unreachableDevices.map((deviceName) =>
        this._createLshCommand(
          `${this.lshBasePath}${deviceName}/IN`,
          { p: LshProtocol.PING } as PingPayload,
          1,
        ),
      );

      if (result.messages[Output.Lsh]) {
        const existingMessages = Array.isArray(result.messages[Output.Lsh])
          ? result.messages[Output.Lsh]
          : [result.messages[Output.Lsh]];
        result.messages[Output.Lsh] = [...existingMessages, ...pingCommands];
      } else {
        result.messages[Output.Lsh] = pingCommands;
      }
    }

    if (recoveryCommands.length === 0 && unreachableDevices.length === 0) {
      result.logs.push(
        "Initial state verification: all configured devices are reachable and already have authoritative snapshots.",
      );
    }

    return result;
  }

  /**
   * Returns whether startup should request a bridge-local BOOT replay because
   * at least one configured device still lacks a complete retained/live
   * `details + state` snapshot in the registry.
   */
  public needsStartupBootReplay(): boolean {
    if (!this.systemConfig || this.systemConfig.devices.length === 0) {
      return false;
    }

    return this.systemConfig.devices.some(({ name }) => {
      const device = this.deviceManager.getDevice(name);
      return !device || device.lastDetailsTime === 0 || device.lastStateTime === 0;
    });
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
    // Simplicity over improbable race handling: any successful config load invalidates
    // the assumptions under which pending network clicks were validated.
    const clearedPendingClicks = this.clickManager.clearAll();

    const newDeviceNames = new Set(this.systemConfig.devices.map((d) => d.name));
    for (const device of this.systemConfig.devices) {
      this.deviceConfigMap.set(device.name, device);
    }
    this.discoveryManager.setDiscoveryConfig(this.deviceConfigMap);

    const prunedDevices = [];
    for (const deviceName of this.deviceManager.getRegisteredDeviceNames()) {
      if (!newDeviceNames.has(deviceName)) {
        this.deviceManager.pruneDevice(deviceName);
        prunedDevices.push(deviceName);
      }
    }
    let logMessage = "System configuration successfully loaded and validated.";
    if (prunedDevices.length > 0) {
      logMessage += ` Pruned stale devices from registry: ${prunedDevices.join(", ")}.`;
    }
    if (clearedPendingClicks > 0) {
      logMessage += ` Cleared ${clearedPendingClicks} pending click transaction(s).`;
    }
    return logMessage;
  }

  public syncDiscoveryConfig(): ServiceResult {
    if (!this.haDiscovery) {
      return this.createEmptyResult();
    }

    return this.discoveryManager.regenerateDiscoveryPayloads();
  }

  /**
   * Resets the configuration to null, typically on a file loading or validation error.
   */
  public clearSystemConfig(): void {
    this.systemConfig = null;
    this.deviceConfigMap.clear();
    this.discoveryManager.setDiscoveryConfig(this.deviceConfigMap);
    this.clickManager.clearAll();
  }

  /**
   * Gets the list of all configured device names from the loaded config.
   * @returns An array of device names or null if the config is not loaded.
   */
  public getConfiguredDeviceNames(): string[] | null {
    return this.systemConfig ? this.systemConfig.devices.map((d) => d.name) : null;
  }

  /**
   * Generates the broadcast bridge-local BOOT resync command used during
   * startup when one or more configured devices still lack an authoritative
   * `details + state` snapshot.
   * @returns A ServiceResult containing the startup commands.
   */
  public getStartupCommands(): ServiceResult {
    const result = this.createEmptyResult();
    if (!this.systemConfig || this.systemConfig.devices.length === 0) {
      result.warnings.push("Cannot generate startup commands: config not loaded.");
      return result;
    }
    result.logs.push("Requesting a single bridge-local BOOT resync from all devices.");
    result.messages[Output.Lsh] = this._createLshCommand(
      this.serviceTopic,
      { p: LshProtocol.BOOT } as BootPayload,
      1,
    );
    return result;
  }

  /**
   * @internal
   * Creates an LSH command message, transparently encoding the payload to MsgPack
   * if the protocol is configured to do so. Otherwise, sends a standard JSON object.
   * @param topic - The target MQTT topic for the command.
   * @param payload - The command payload as a JavaScript object.
   * @param qos - The desired Quality of Service level for the message.
   * @returns A NodeMessage object ready to be sent.
   */
  private _createLshCommand(topic: string, payload: object, qos: 0 | 1 | 2): NodeMessage {
    const encodedPayload = this.codec.encode(payload, this.protocol);
    return { topic, payload: encodedPayload, qos };
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

  private mergeServiceResult(target: ServiceResult, source: ServiceResult): void {
    Object.assign(target.messages, source.messages);
    target.logs.push(...source.logs);
    target.warnings.push(...source.warnings);
    target.errors.push(...source.errors);
    target.stateChanged = target.stateChanged || source.stateChanged;
    if (source.staggerLshMessages) {
      target.staggerLshMessages = true;
    }
  }

  private recordLiveDeviceReachability(
    result: ServiceResult,
    deviceName: string,
    trafficDescription: string,
  ): void {
    const { stateChanged, becameHealthy } = this.deviceManager.recordReachableActivity(deviceName);
    if (!stateChanged) {
      return;
    }

    result.stateChanged = true;
    result.logs.push(`Device '${deviceName}' sent live ${trafficDescription} and is reachable.`);

    if (becameHealthy) {
      const alertInfo = [
        {
          name: deviceName,
          reason: `Device sent live ${trafficDescription} and is now healthy.`,
        },
      ];
      Object.assign(result.messages, this._prepareAlerts(alertInfo, "healthy").messages);
    }
  }

  /**
   * Builds the smallest best-effort recovery command set required to refresh a
   * device snapshot.
   * If details are missing, request both details and state. If only the
   * authoritative state is missing, request only state.
   * @internal
   */
  private _buildSnapshotRecoveryCommands(deviceName: string): NodeMessage[] {
    const device = this.deviceManager.getDevice(deviceName);
    const commandTopic = `${this.lshBasePath}${deviceName}/IN`;

    if (!device || device.lastDetailsTime === 0) {
      return [
        this._createLshCommand(
          commandTopic,
          { p: LshProtocol.REQUEST_DETAILS } as RequestDetailsPayload,
          1,
        ),
        this._createLshCommand(
          commandTopic,
          { p: LshProtocol.REQUEST_STATE } as RequestStatePayload,
          1,
        ),
      ];
    }

    if (device.lastStateTime === 0) {
      return [
        this._createLshCommand(
          commandTopic,
          { p: LshProtocol.REQUEST_STATE } as RequestStatePayload,
          1,
        ),
      ];
    }

    return [];
  }

  /**
   * Processes an incoming message by matching its topic against known patterns.
   * This implementation avoids Regex for performance, using efficient string parsing instead.
   * @param topic - The MQTT topic of the message.
   * @param payload - The payload of the message.
   * @param options - Optional MQTT envelope metadata such as the retained flag.
   * @returns A ServiceResult describing the actions to be taken.
   */
  public processMessage(
    topic: string,
    payload: unknown,
    options: ProcessMessageOptions = {},
  ): ServiceResult {
    if (!this.systemConfig) {
      const result = this.createEmptyResult();
      result.warnings.push("Configuration not loaded, ignoring message.");
      return result;
    }

    // --- HOMIE TOPICS ---
    if (topic.startsWith(this.homieBasePath)) {
      const baseLen = this.homieBasePath.length;
      const slashIndex = topic.indexOf("/", baseLen);
      const isRetained = options.retained === true;

      if (slashIndex === -1) return this._handleUnhandledTopic(topic);

      const deviceName = topic.substring(baseLen, slashIndex);

      if (topic.endsWith("/$state")) {
        // Only a live `$state` transition proves current Homie reachability.
        // Retained discovery metadata must not reset watchdog ping tracking.
        if (!isRetained) {
          this.watchdog.onDeviceActivity(deviceName);
        }
        return this._handleHomieState(deviceName, payload, isRetained);
      }

      if (this.haDiscovery) {
        const suffix = topic.substring(slashIndex);
        if (suffix === "/$mac" || suffix === "/$fw/version" || suffix === "/$nodes") {
          return this.discoveryManager.processDiscoveryMessage(deviceName, suffix, String(payload));
        }
      }
    }

    // --- LSH TOPICS ---
    else if (topic.startsWith(this.lshBasePath)) {
      const baseLen = this.lshBasePath.length;
      const slashIndex = topic.indexOf("/", baseLen);
      const isRetained = options.retained === true;

      if (slashIndex === -1) return this._handleUnhandledTopic(topic);

      const deviceName = topic.substring(baseLen, slashIndex);

      if (!isRetained) {
        this.watchdog.onDeviceActivity(deviceName);
      }

      if (topic.endsWith("/state")) {
        return this._handleLshState(deviceName, payload, !isRetained);
      } else if (topic.endsWith("/misc")) {
        return this._handleLshMisc(deviceName, payload);
      } else if (topic.endsWith("/conf")) {
        return this._handleLshConf(deviceName, payload, !isRetained);
      }
    }

    return this._handleUnhandledTopic(topic);
  }

  private _handleUnhandledTopic(topic: string): ServiceResult {
    const result = this.createEmptyResult();
    // Only log if it's not a completely irrelevant topic?
    // For now, keep behavior consistent with old regex fallback logic which logged everything unhandled.
    // However, in a real env, we might receive many messages.
    // Old logic: "Message on unhandled topic: ..."
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
      const { messages, logs, stagger } = this._preparePings(actions);
      Object.assign(result.messages, messages);
      result.logs.push(...logs);
      if (stagger) {
        result.staggerLshMessages = true;
      }
    }

    if (actions.unhealthyDevicesForAlert.length > 0) {
      const alertResult = this._prepareAlerts(actions.unhealthyDevicesForAlert, "unhealthy");
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
    actions: WatchdogActions,
  ): void {
    const deviceState = this.deviceManager.getDevice(deviceName);
    // Optimization: If a device is already known to be offline and an alert has been sent,
    // skip any further checks on it until it comes back online. This prevents redundant work and log spam.
    if (deviceState && !deviceState.isHealthy && deviceState.alertSent) {
      return; // Skip already alerted devices
    }
    const healthResult = this.watchdog.checkDeviceHealth(deviceState, now);

    // If a device appears healthy to the watchdog (recent lastSeenTime) but is not
    // connected via Homie, skip health updates entirely. This covers two cases:
    // 1. A device that just disconnected — its lastSeenTime is still fresh, but it
    //    shouldn't be re-marked as healthy since Homie reported it offline.
    // 2. A device that hasn't connected yet in this session — updating health would
    //    generate a spurious recovery event.
    if (healthResult.status === "ok" && deviceState && !deviceState.connected) {
      return;
    }

    const { stateChanged } = this.deviceManager.updateHealthFromResult(deviceName, healthResult);
    if (stateChanged) actions.stateChanged = true;

    switch (healthResult.status) {
      case "needs_ping":
        actions.devicesToPing.add(deviceName);
        break;
      case "stale":
        if (stateChanged) {
          actions.unhealthyDevicesForAlert.push({
            name: deviceName,
            reason: "No response to ping.",
          });
        }
        actions.devicesToPing.add(deviceName);
        break;
      case "unhealthy":
        actions.unhealthyDevicesForAlert.push({
          name: deviceName,
          reason: healthResult.reason,
        });
        {
          const { stateChanged } = this.deviceManager.recordAlertSent(deviceName);
          /* istanbul ignore if */
          if (stateChanged) {
            actions.stateChanged = true;
          }
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
    return cleanedCount > 0 ? `Cleaned up ${cleanedCount} expired click transactions.` : null;
  }

  /* -------------------------------------------------------------------------- */
  /*                             TOPIC HANDLERS                                 */
  /* -------------------------------------------------------------------------- */

  private _handleHomieState(
    deviceName: string,
    payload: unknown,
    isRetained: boolean,
  ): ServiceResult {
    const result = this.createEmptyResult();
    const existingDevice = this.deviceManager.getDevice(deviceName);
    const homieState = String(payload) as HomieLifecycleState;

    // Retained Homie state alone is not enough to bootstrap reachability for a device
    // we have never seen live in this Node-RED session. Once a device has produced live
    // traffic, retained `$state` frames are still treated as metadata only: broker
    // reconnects can replay stale retained lifecycle states that should not flip the
    // live reachability model used by network-click validation.
    if (isRetained && (!existingDevice || existingDevice.lastSeenTime === 0)) {
      return result;
    }

    if (isRetained) {
      const { stateChanged: lifecycleChanged } = this.deviceManager.recordHomieLifecycleState(
        deviceName,
        homieState,
        false,
      );
      if (!lifecycleChanged) {
        return result;
      }

      result.stateChanged = true;
      result.logs.push(
        `Device '${deviceName}' reported retained Homie lifecycle state '${homieState}'. Ignoring it for reachability, alerts and resync.`,
      );
      return result;
    }

    const { stateChanged: lifecycleChanged } = this.deviceManager.recordHomieLifecycleState(
      deviceName,
      homieState,
      true,
    );

    const { stateChanged, wasConnected, isConnected } = this.deviceManager.updateConnectionState(
      deviceName,
      homieState,
    );

    if (isDiagnosticOnlyHomieState(homieState)) {
      if (!stateChanged && !lifecycleChanged) {
        return result;
      }

      result.stateChanged = stateChanged || lifecycleChanged;
      result.logs.push(
        `Device '${deviceName}' reported Homie lifecycle state '${homieState}'. Ignoring it for alerts and resync.`,
      );
      return result;
    }

    if (!stateChanged) {
      return result; // No change, nothing more to do.
    }

    result.stateChanged = true;
    result.logs.push(`Device '${deviceName}' connection state changed to '${homieState}'.`);

    const wentOffline = wasConnected && !isConnected;
    const cameOnline = !wasConnected && isConnected;

    if (wentOffline) {
      const alertInfo = [
        {
          name: deviceName,
          reason: `Device reported as '${homieState}' by Homie.`,
        },
      ];
      Object.assign(result.messages, this._prepareAlerts(alertInfo, "unhealthy").messages);
    } else if (cameOnline) {
      result.logs.push(`Device '${deviceName}' came back online (Homie state: ready).`);
      const alertInfo = [
        {
          name: deviceName,
          reason: "Device is now connected and healthy.",
        },
      ];
      Object.assign(result.messages, this._prepareAlerts(alertInfo, "healthy").messages);
      const recoveryCommands = this._buildSnapshotRecoveryCommands(deviceName);
      if (recoveryCommands.length > 0) {
        result.logs.push(
          `Device '${deviceName}' is online. Requesting the missing authoritative snapshot data.`,
        );
        result.messages[Output.Lsh] = recoveryCommands;
      }
    }
    return result;
  }

  private _handleLshConf(
    deviceName: string,
    payload: unknown,
    isLiveTelemetry: boolean,
  ): ServiceResult {
    const result = this.createEmptyResult();
    if (!this.validators.validateDeviceDetails(payload)) {
      const errorText =
        this.validators.validateDeviceDetails.errors?.map((e) => e.message).join(", ") ||
        "unknown validation error";
      result.warnings.push(`Invalid 'conf' payload from ${deviceName}: ${errorText}`);
      return result;
    }
    const detailsPayload = payload as DeviceDetailsPayload;
    if (detailsPayload.v !== LSH_WIRE_PROTOCOL_MAJOR) {
      result.warnings.push(
        `Protocol major mismatch for ${deviceName}: received ${detailsPayload.v}, expected ${LSH_WIRE_PROTOCOL_MAJOR}. Ignoring details payload.`,
      );
      return result;
    }
    const { changed } = this.deviceManager.registerDeviceDetails(
      deviceName,
      detailsPayload,
      isLiveTelemetry,
    );
    if (isLiveTelemetry) {
      const { stateChanged, becameHealthy } =
        this.deviceManager.recordReachableActivity(deviceName);
      if (stateChanged) {
        result.stateChanged = true;
        result.logs.push(`Device '${deviceName}' sent live details and is reachable.`);
        if (becameHealthy) {
          const alertInfo = [
            {
              name: deviceName,
              reason: "Device sent live details and is now healthy.",
            },
          ];
          Object.assign(result.messages, this._prepareAlerts(alertInfo, "healthy").messages);
        }
      }
    }
    if (changed) {
      result.logs.push(`Stored/Updated details for device '${deviceName}'.`);
      result.stateChanged = true;
    }
    return result;
  }

  private _handleLshState(
    deviceName: string,
    payload: unknown,
    isLiveTelemetry: boolean,
  ): ServiceResult {
    const result = this.createEmptyResult();
    if (!this.validators.validateActuatorStates(payload)) {
      const errorText =
        this.validators.validateActuatorStates.errors?.map((e) => e.message).join(", ") ||
        "unknown validation error";
      result.warnings.push(`Invalid 'state' payload from ${deviceName}: ${errorText}`);
      return result;
    }
    try {
      const packedBytes = (payload as DeviceActuatorsStatePayload).s;

      // Get the device to know how many actuators we expect
      const device = this.deviceManager.getDevice(deviceName);
      const hasKnownDetails = device !== undefined && device.lastDetailsTime !== 0;
      const numActuators = hasKnownDetails ? device.actuatorsIDs.length : packedBytes.length * 8;

      // Validate byte array length: each byte covers 8 actuators
      const expectedBytes = Math.ceil(numActuators / 8);
      if (packedBytes.length !== expectedBytes) {
        result.errors.push(
          `State mismatch for ${deviceName}: expected ${expectedBytes} bytes for ${numActuators} actuators, received ${packedBytes.length}.`,
        );
        return result;
      }

      // Unpack using per-byte loop structure (matches C++ implementation)
      // This avoids Math.floor() and % operations on the hot path
      const states: boolean[] = [];
      for (
        let byteIndex = 0;
        byteIndex < packedBytes.length && states.length < numActuators;
        byteIndex++
      ) {
        const packedByte = packedBytes[byteIndex];
        for (let bitIndex = 0; bitIndex < 8 && states.length < numActuators; bitIndex++) {
          states.push((packedByte & BIT_MASK_8[bitIndex]) !== 0);
        }
      }

      const { isNew, changed, configIsMissing } = this.deviceManager.registerActuatorStates(
        deviceName,
        states,
        isLiveTelemetry,
      );
      if (isLiveTelemetry) {
        const { stateChanged, becameHealthy } =
          this.deviceManager.recordReachableActivity(deviceName);
        if (stateChanged) {
          result.stateChanged = true;
          result.logs.push(`Device '${deviceName}' sent live state and is reachable.`);
          if (becameHealthy) {
            const alertInfo = [
              {
                name: deviceName,
                reason: "Device sent live state and is now healthy.",
              },
            ];
            Object.assign(result.messages, this._prepareAlerts(alertInfo, "healthy").messages);
          }
        }
      }
      if (isNew)
        result.logs.push(`Received state for a new device: ${deviceName}. Creating partial entry.`);
      if (changed) {
        result.logs.push(`Updated state for '${deviceName}': [${states.join(", ")}]`);
        result.stateChanged = true;
      }
      // If we receive a state but don't have the device details (IDs), proactively request them.
      if (configIsMissing) {
        result.warnings.push(
          `Device '${deviceName}' sent state but its configuration is unknown. Requesting details.`,
        );
        result.messages[Output.Lsh] = this._createLshCommand(
          `${this.lshBasePath}${deviceName}/IN`,
          { p: LshProtocol.REQUEST_DETAILS } as RequestDetailsPayload,
          1,
        );
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    return result;
  }

  private _handleLshMisc(deviceName: string, payload: unknown): ServiceResult {
    if (!this.validators.validateAnyMiscTopic(payload)) {
      const result = this.createEmptyResult();
      const errorText =
        this.validators.validateAnyMiscTopic.errors?.map((e) => e.message).join(", ") ||
        "unknown validation error";
      result.warnings.push(`Invalid 'misc' payload from ${deviceName}: ${errorText}`);
      return result;
    }
    const miscPayload = payload as AnyMiscTopicPayload;
    const result = this.createEmptyResult();

    if (isBridgeDiagnosticPayload(miscPayload)) {
      // Bridge-local diagnostics share the `misc` topic for transport convenience,
      // but they do not describe button logic or device-side reachability.
      // Accept them silently as informational runtime events.
      result.logs.push(
        `Bridge diagnostic from '${deviceName}': ${miscPayload.bridge_diagnostic}. Ignoring it for reachability and click logic.`,
      );
      return result;
    }

    switch (miscPayload.p) {
      case LshProtocol.NETWORK_CLICK_REQUEST: {
        this.recordLiveDeviceReachability(result, deviceName, "misc traffic");
        this.mergeServiceResult(result, this._processNewClickRequest(deviceName, miscPayload));
        return result;
      }

      case LshProtocol.NETWORK_CLICK_CONFIRM: {
        this.recordLiveDeviceReachability(result, deviceName, "misc traffic");
        this.mergeServiceResult(result, this._processClickConfirmation(deviceName, miscPayload));
        return result;
      }

      case LshProtocol.PING:
        {
          const device = this.deviceManager.getDevice(deviceName);
          const { stateChanged, becameHealthy } =
            this.deviceManager.recordReachableActivity(deviceName);
          const recoveryCommands = this._buildSnapshotRecoveryCommands(deviceName);

          if (stateChanged) {
            result.logs.push(`Device '${deviceName}' is now responsive.`);
            result.stateChanged = true;

            if (becameHealthy) {
              result.logs.push(`Device '${deviceName}' is healthy again after ping response.`);
              const alertInfo = [
                {
                  name: deviceName,
                  reason: "Device responded to ping and is now healthy.",
                },
              ];
              Object.assign(result.messages, this._prepareAlerts(alertInfo, "healthy").messages);
            }
          } else {
            result.logs.push(`Received ping response from '${deviceName}'.`);
          }

          if (recoveryCommands.length > 0) {
            result.messages[Output.Lsh] = recoveryCommands;
            if (!device || device.lastDetailsTime === 0) {
              result.logs.push(
                `Device '${deviceName}' is missing device details. Requesting details and state.`,
              );
            } else {
              result.logs.push(
                `Device '${deviceName}' is missing an authoritative actuator state. Requesting state.`,
              );
            }
          }
        }
        break;

      default:
        return result;
    }
    return result;
  }

  /**
   * Processes the first phase of a network click: a new request from a device.
   * Validates the request and sends an ACK if successful, or a FAILOVER if not.
   * @internal
   */
  private _processNewClickRequest(
    deviceName: string,
    payload: NetworkClickRequestPayload,
  ): ServiceResult {
    const result = this.createEmptyResult();
    const { c: correlationId, i: buttonId, t: clickType } = payload;
    const slotKey = buildClickSlotKey(deviceName, buttonId, clickType);
    const transactionKey = buildClickCorrelationKey(deviceName, buttonId, clickType, correlationId);
    const commandTopic = `${this.lshBasePath}${deviceName}/IN`;

    try {
      const { actors, otherActors } = this._validateClickRequest(deviceName, buttonId, clickType);
      this.clickManager.startTransaction(slotKey, transactionKey, actors, otherActors);

      result.messages[Output.Lsh] = this._createLshCommand(
        commandTopic,
        {
          p: LshProtocol.NETWORK_CLICK_ACK,
          c: correlationId,
          t: clickType,
          i: buttonId,
        } as NetworkClickAckPayload,
        2,
      );
      result.logs.push(`Validation OK for ${transactionKey}. Sending ACK.`);
    } catch (error) {
      if (error instanceof ClickValidationError) {
        const alertInfo = [{ name: deviceName, reason: `Action failed: ${error.reason}` }];
        const alertResult = this._prepareAlerts(alertInfo, "unhealthy", payload);
        Object.assign(result.messages, alertResult.messages);

        if (error.failoverType === "general") {
          result.errors.push(`System failure on click. Sending General Failover (c_gf).`);
          result.messages[Output.Lsh] = this._createLshCommand(
            commandTopic,
            { p: LshProtocol.FAILOVER } as FailoverPayload,
            2,
          );
        } else {
          result.messages[Output.Lsh] = this._createLshCommand(
            commandTopic,
            {
              p: LshProtocol.FAILOVER_CLICK,
              c: correlationId,
              t: clickType,
              i: buttonId,
            } as FailoverClickPayload,
            2,
          );
        }
      } else {
        result.errors.push(
          `Unexpected error during click processing for ${transactionKey}: ${String(error)}`,
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
    payload: NetworkClickConfirmPayload,
  ): ServiceResult {
    const result = this.createEmptyResult();
    const { c: correlationId, i: buttonId, t: clickType } = payload;
    const transactionKey = buildClickCorrelationKey(deviceName, buttonId, clickType, correlationId);

    const transaction = this.clickManager.consumeTransaction(transactionKey);
    if (!transaction) {
      result.warnings.push(
        `Received confirmation for an expired or unknown click: ${transactionKey}.`,
      );
      return result;
    }

    result.logs.push(`Click confirmed for ${transactionKey}. Executing logic.`);
    const logicResult = this.executeClickLogic(
      transaction.actors,
      transaction.otherActors,
      clickType,
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
    buttonId: number,
    clickType: ClickType,
  ): { actors: Actor[]; otherActors: string[] } {
    const deviceConfig = this.deviceConfigMap.get(deviceName);
    const clickTypeKey =
      clickType === ClickType.Long ? "longClickButtons" : "superLongClickButtons";
    const buttonConfig = deviceConfig?.[clickTypeKey]?.find((btn) => btn.id === buttonId);

    if (!buttonConfig)
      throw new ClickValidationError("No action configured for this button.", "click");

    const { actors = [], otherActors = [] } = buttonConfig;
    if (actors.length === 0 && otherActors.length === 0)
      throw new ClickValidationError("Action configured with no targets.", "click");

    for (const actor of actors) {
      const device = this.deviceManager.getDevice(actor.name);
      if (!device) {
        throw new ClickValidationError(
          `Target actor '${actor.name}' is unknown to the registry.`,
          "click",
        );
      }

      if (!device.connected) {
        throw new ClickValidationError(`Target actor '${actor.name}' is offline.`, "click");
      }

      if (device.isStale) {
        throw new ClickValidationError(
          `Target actor '${actor.name}' is stale after a timed-out ping.`,
          "click",
        );
      }

      if (!device.isHealthy) {
        throw new ClickValidationError(`Target actor '${actor.name}' is unhealthy.`, "click");
      }

      if (device.lastDetailsTime === 0) {
        throw new ClickValidationError(
          `Target actor '${actor.name}' has unknown device details.`,
          "click",
        );
      }

      // Keep distributed click handling intentionally simple: if the action needs
      // an authoritative local state snapshot, reject it before sending ACK rather
      // than trying to recover mid-transaction.
      const requiresAuthoritativeState =
        clickType === ClickType.Long || actor.allActuators === false;
      if (requiresAuthoritativeState && device.lastStateTime === 0) {
        throw new ClickValidationError(
          `Target actor '${actor.name}' has no authoritative actuator state yet.`,
          "click",
        );
      }

      if (device.actuatorsIDs.length === 0) {
        throw new ClickValidationError(`Target actor '${actor.name}' has no actuators.`, "click");
      }

      if (!actor.allActuators) {
        if (actor.actuators.length === 0) {
          throw new ClickValidationError(
            `Target actor '${actor.name}' has no actuator IDs configured.`,
            "click",
          );
        }

        const invalidActuatorIds = actor.actuators.filter(
          (actuatorId) => device.actuatorIndexes[actuatorId] === undefined,
        );
        if (invalidActuatorIds.length > 0) {
          throw new ClickValidationError(
            `Target actor '${actor.name}' references unknown actuator ID(s): ${invalidActuatorIds.join(", ")}.`,
            "click",
          );
        }
      }
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
    clickType: ClickType,
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
      const toggleResult = this.deviceManager.getSmartToggleState(actors, otherActors);
      if (toggleResult.warning) result.warnings.push(toggleResult.warning);
      result.logs.push(
        `Smart Toggle: ${toggleResult.active}/${
          toggleResult.total
        } active. Decision: ${toggleResult.stateToSet ? "ON" : "OFF"}`,
      );
      stateToSet = toggleResult.stateToSet;

      if (toggleResult.total === 0) {
        if (!toggleResult.warning) {
          result.warnings.push("Smart Toggle aborted because no authoritative state is available.");
        }
        result.logs.push(
          "Skipping click execution because no authoritative actor state is available.",
        );
        return result;
      }
    }

    const { commands: lshCommands, warnings: commandWarnings } = this.buildStateCommands(
      actors,
      stateToSet,
    );
    result.warnings.push(...commandWarnings);
    if (lshCommands.length > 0) {
      result.messages[Output.Lsh] = lshCommands;
    }

    if (otherActors.length > 0) {
      const payload: OtherActorsCommandPayload = {
        otherActors,
        stateToSet,
      };

      result.messages[Output.OtherActors] = { payload };
    }
    return result;
  }

  /**
   * Builds an array of MQTT messages to set the state of LSH actuators.
   * @internal
   */
  private buildStateCommands(
    actors: Actor[],
    stateToSet: boolean,
  ): { commands: NodeMessage[]; warnings: string[] } {
    const commands: NodeMessage[] = [];
    const warnings: string[] = [];
    const stateValue = stateToSet ? 1 : 0;
    for (const actor of actors) {
      const device = this.deviceManager.getDevice(actor.name);
      if (!device) {
        warnings.push(
          `Skipping actor '${actor.name}' because it disappeared before command execution.`,
        );
        continue;
      }

      const commandTopic = `${this.lshBasePath}${actor.name}/IN`;
      // Optimization: use the more specific 'c_asas' command if only one actuator is targeted.
      const isSingleSpecificActuator = !actor.allActuators && actor.actuators.length === 1;

      if (isSingleSpecificActuator) {
        commands.push(
          this._createLshCommand(
            commandTopic,
            {
              p: LshProtocol.SET_SINGLE_ACTUATOR,
              i: actor.actuators[0],
              s: stateValue,
            } as SetSingleActuatorPayload,
            2,
          ),
        );
      } else {
        let booleanStates: boolean[];
        if (actor.allActuators) {
          booleanStates = new Array<boolean>(device.actuatorsIDs.length).fill(stateToSet);
        } else {
          if (device.lastStateTime === 0) {
            warnings.push(
              `Skipping actor '${actor.name}' because its actuator state is not authoritative yet.`,
            );
            continue;
          }

          booleanStates = device.actuatorStates.slice();
          for (const actuatorId of actor.actuators) {
            const index = device.actuatorIndexes[actuatorId];
            if (index !== undefined) booleanStates[index] = stateToSet;
          }
        }

        // Pack boolean states into the current bitpacked LSH wire format.
        const numBytes = Math.ceil(booleanStates.length / 8);
        const packedBytes = new Array<number>(numBytes).fill(0);

        for (let i = 0; i < booleanStates.length; i++) {
          if (booleanStates[i]) {
            const byteIndex = i >> 3; // i / 8
            const bitIndex = i & 7; // i % 8
            packedBytes[byteIndex] |= BIT_MASK_8[bitIndex];
          }
        }

        commands.push(
          this._createLshCommand(
            commandTopic,
            {
              p: LshProtocol.SET_STATE,
              s: packedBytes,
            } as SetStatePayload,
            2,
          ),
        );
      }
    }
    return { commands, warnings };
  }

  /**
   * Prepares ping commands for a list of devices. It decides whether to use
   * a single broadcast ping or staggered individual pings.
   * @internal
   */
  private _preparePings(actions: WatchdogActions): {
    messages: OutputMessages;
    logs: string[];
    stagger: boolean;
  } {
    const messages: OutputMessages = {};
    const logs: string[] = [];
    const devicesToPing = Array.from(actions.devicesToPing);
    const totalConfiguredDevices = this.systemConfig!.devices.length;
    let stagger = false;

    if (devicesToPing.length === totalConfiguredDevices) {
      logs.push(
        `All ${totalConfiguredDevices} devices are silent. Preparing a single broadcast ping.`,
      );
      messages[Output.Lsh] = this._createLshCommand(
        this.serviceTopic,
        { p: LshProtocol.PING } as PingPayload,
        1,
      );
    } else {
      logs.push(`Preparing staggered pings for ${devicesToPing.length} device(s)...`);
      if (devicesToPing.length > 1) {
        stagger = true;
      }
      const pingCommands: NodeMessage[] = devicesToPing.map((deviceName) =>
        this._createLshCommand(
          `${this.lshBasePath}${deviceName}/IN`,
          { p: LshProtocol.PING } as PingPayload,
          1,
        ),
      );
      messages[Output.Lsh] = pingCommands;
    }
    return { messages, logs, stagger };
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
    details?: object,
  ): { messages: OutputMessages } {
    const payload: AlertPayload = {
      message: formatAlertMessage(devices, status, details),
      status,
      devices,
      details,
    };
    return {
      messages: {
        [Output.Alerts]: {
          payload,
        },
      },
    };
  }
}
