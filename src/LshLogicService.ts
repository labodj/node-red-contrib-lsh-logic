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
import {
  appendLshMessages,
  BIT_MASK_8,
  buildClickCorrelationKey,
  buildClickSlotKey,
  createEmptyServiceResult,
  isBridgeDiagnosticPayload,
  isDiagnosticOnlyHomieState,
  mergeServiceResults,
  parseDeviceScopedTopic,
  prependLshMessages,
} from "./LshLogicService.helpers";
import { Watchdog } from "./Watchdog";
import { ClickType, LSH_WIRE_PROTOCOL_MAJOR, LshProtocol, Output } from "./types";
import type {
  Actor,
  AlertPayload,
  AlertEventSource,
  AlertEventType,
  AnyBridgeTopicPayload,
  AnyEventsTopicPayload,
  BootPayload,
  DeviceActuatorsStatePayload,
  DeviceDetailsPayload,
  DeviceEntry,
  DeviceState,
  FailoverClickPayload,
  FailoverPayload,
  HomieLifecycleState,
  NetworkClickAckPayload,
  NetworkClickConfirmPayload,
  NetworkClickRequestPayload,
  OtherActorsCommandPayload,
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
  shouldProbeBridges: boolean;
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
    validateAnyEventsTopic: ValidateFunction;
    validateAnyBridgeTopic: ValidateFunction;
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
      validateAnyEventsTopic: ValidateFunction;
      validateAnyBridgeTopic: ValidateFunction;
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
    const result = createEmptyServiceResult();
    if (!this.systemConfig) {
      result.warnings.push("Cannot run initial state verification: config not loaded.");
      return result;
    }

    const configuredDevices = this.getConfiguredDeviceNames() as string[];
    const unreachableDevices: string[] = [];
    const recoveryCommands: NodeMessage[] = [];
    let devicesNeedingRecovery = 0;

    for (const deviceName of configuredDevices) {
      const deviceState = this.deviceManager.getDevice(deviceName);
      if (!deviceState) {
        unreachableDevices.push(deviceName);
        continue;
      }

      if (!deviceState.connected && !deviceState.bridgeConnected) {
        unreachableDevices.push(deviceName);
        continue;
      }

      const recoveryPlan = this._buildSnapshotRecoveryPlan(deviceName);
      if (recoveryPlan.reason !== null) {
        devicesNeedingRecovery++;
        recoveryCommands.push(...recoveryPlan.commands);
      }
    }

    if (recoveryCommands.length > 0) {
      result.logs.push(
        `Initial state verification: ${devicesNeedingRecovery} reachable device(s) still need authoritative snapshot recovery.`,
      );
      appendLshMessages(result, recoveryCommands);
    }

    if (unreachableDevices.length > 0) {
      result.logs.push(
        `Initial state verification: ${unreachableDevices.length} device(s) are still unreachable. Pinging them directly.`,
      );
      appendLshMessages(result, this._buildDevicePingCommands(unreachableDevices));
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
      return createEmptyServiceResult();
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
    const result = createEmptyServiceResult();
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

  private _deviceCommandTopic(deviceName: string): string {
    return `${this.lshBasePath}${deviceName}/IN`;
  }

  private _buildDevicePingCommands(deviceNames: Iterable<string>): NodeMessage[] {
    return Array.from(deviceNames, (deviceName) =>
      this._createLshCommand(
        this._deviceCommandTopic(deviceName),
        { p: LshProtocol.PING } as PingPayload,
        1,
      ),
    );
  }

  private _buildBridgeProbeCommand(): NodeMessage {
    return this._createLshCommand(this.serviceTopic, { p: LshProtocol.PING } as PingPayload, 1);
  }

  private recordLiveControllerActivity(
    result: ServiceResult,
    deviceName: string,
    trafficDescription: string,
  ): void {
    this.watchdog.onDeviceActivity(deviceName);
    const { stateChanged, becameHealthy } = this.deviceManager.recordControllerActivity(deviceName);
    if (!stateChanged) {
      return;
    }

    result.stateChanged = true;
    result.logs.push(`Device '${deviceName}' sent live ${trafficDescription} and is reachable.`);

    if (becameHealthy) {
      this._emitAlert(
        result,
        [
          {
            name: deviceName,
            reason: `Device sent live ${trafficDescription} and is now healthy.`,
          },
        ],
        "healthy",
        "device_recovered",
        "live_telemetry",
      );
    }
  }

  private recordControllerPingResponse(
    result: ServiceResult,
    deviceName: string,
    isLiveTelemetry: boolean,
  ): void {
    if (isLiveTelemetry) {
      this.watchdog.onDeviceActivity(deviceName);
    }
    const { stateChanged, becameHealthy } = this.deviceManager.recordControllerActivity(deviceName);

    if (stateChanged) {
      result.stateChanged = true;
      result.logs.push(`Device '${deviceName}' is now responsive.`);

      if (becameHealthy) {
        result.logs.push(`Device '${deviceName}' is healthy again after ping response.`);
        this._emitAlert(
          result,
          [
            {
              name: deviceName,
              reason: "Device responded to ping and is now healthy.",
            },
          ],
          "healthy",
          "device_recovered",
          "watchdog",
        );
      }
    } else {
      result.logs.push(`Received ping response from '${deviceName}'.`);
    }

    this.requestSnapshotRecovery(result, deviceName, {
      detailsAndState: `Device '${deviceName}' is missing device details. Requesting details and state.`,
      stateOnly: `Device '${deviceName}' is missing an authoritative actuator state. Requesting state.`,
    });
  }

  /**
   * Builds the smallest best-effort recovery command set required to refresh a
   * device snapshot.
   * If details are missing, request both details and state. If only the
   * authoritative state is missing, request only state.
   * @internal
   */
  private _buildSnapshotRecoveryPlan(deviceName: string): {
    commands: NodeMessage[];
    reason: "details_and_state" | "state_only" | null;
  } {
    const device = this.deviceManager.getDevice(deviceName);
    const commandTopic = this._deviceCommandTopic(deviceName);

    if (!device || device.lastDetailsTime === 0) {
      return {
        reason: "details_and_state",
        commands: [
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
        ],
      };
    }

    if (device.lastStateTime === 0) {
      return {
        reason: "state_only",
        commands: [
          this._createLshCommand(
            commandTopic,
            { p: LshProtocol.REQUEST_STATE } as RequestStatePayload,
            1,
          ),
        ],
      };
    }

    return { reason: null, commands: [] };
  }

  private requestSnapshotRecovery(
    result: ServiceResult,
    deviceName: string,
    logMessages: {
      detailsAndState?: string;
      stateOnly?: string;
    } = {},
  ): boolean {
    const recoveryPlan = this._buildSnapshotRecoveryPlan(deviceName);
    if (recoveryPlan.reason === null) {
      return false;
    }

    appendLshMessages(result, recoveryPlan.commands);

    if (recoveryPlan.reason === "details_and_state") {
      if (logMessages.detailsAndState) {
        result.logs.push(logMessages.detailsAndState);
      }
      return true;
    }

    if (logMessages.stateOnly) {
      result.logs.push(logMessages.stateOnly);
    }
    return true;
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
      const result = createEmptyServiceResult();
      result.warnings.push("Configuration not loaded, ignoring message.");
      return result;
    }

    const isRetained = options.retained === true;
    const homieResult = this._routeHomieTopic(topic, payload, isRetained);
    if (homieResult) {
      return homieResult;
    }

    const lshResult = this._routeLshTopic(topic, payload, isRetained);
    if (lshResult) {
      return lshResult;
    }

    return this._handleUnhandledTopic(topic);
  }

  private _routeHomieTopic(
    topic: string,
    payload: unknown,
    isRetained: boolean,
  ): ServiceResult | null {
    if (!topic.startsWith(this.homieBasePath)) {
      return null;
    }

    const parsedTopic = parseDeviceScopedTopic(topic, this.homieBasePath);
    if (!parsedTopic) {
      return this._handleUnhandledTopic(topic);
    }

    if (parsedTopic.suffix === "/$state") {
      return this._handleHomieState(parsedTopic.deviceName, payload, isRetained);
    }

    if (
      this.haDiscovery &&
      (parsedTopic.suffix === "/$mac" ||
        parsedTopic.suffix === "/$fw/version" ||
        parsedTopic.suffix === "/$nodes")
    ) {
      return this.discoveryManager.processDiscoveryMessage(
        parsedTopic.deviceName,
        parsedTopic.suffix,
        String(payload),
      );
    }

    return this._handleUnhandledTopic(topic);
  }

  private _routeLshTopic(
    topic: string,
    payload: unknown,
    isRetained: boolean,
  ): ServiceResult | null {
    if (!topic.startsWith(this.lshBasePath)) {
      return null;
    }

    const parsedTopic = parseDeviceScopedTopic(topic, this.lshBasePath);
    if (!parsedTopic) {
      return this._handleUnhandledTopic(topic);
    }

    switch (parsedTopic.suffix) {
      case "/state":
        return this._handleLshState(parsedTopic.deviceName, payload, !isRetained);
      case "/events":
        return isRetained
          ? this._ignoreRetainedLshRuntimeTopic(parsedTopic.deviceName, "events")
          : this._handleLshEvents(parsedTopic.deviceName, payload, true);
      case "/bridge":
        return isRetained
          ? this._ignoreRetainedLshRuntimeTopic(parsedTopic.deviceName, "bridge")
          : this._handleLshBridge(parsedTopic.deviceName, payload);
      case "/conf":
        return this._handleLshConf(parsedTopic.deviceName, payload, !isRetained);
      default:
        return this._handleUnhandledTopic(topic);
    }
  }

  private _ignoreRetainedLshRuntimeTopic(
    deviceName: string,
    topicKind: "events" | "bridge",
  ): ServiceResult {
    const result = createEmptyServiceResult();
    result.logs.push(
      `Ignoring retained '${topicKind}' payload from '${deviceName}' because only live runtime traffic can affect reachability, clicks or bridge health.`,
    );
    return result;
  }

  private _handleUnhandledTopic(topic: string): ServiceResult {
    const result = createEmptyServiceResult();
    // Keep unhandled-topic logging explicit so unexpected broker traffic stays visible
    // during commissioning and debugging.
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
    const result = createEmptyServiceResult();
    if (!this.systemConfig || this.systemConfig.devices.length === 0) {
      return result;
    }

    const now = Date.now();
    const actions: WatchdogActions = {
      devicesToPing: new Set<string>(),
      unhealthyDevicesForAlert: [],
      stateChanged: false,
      shouldProbeBridges: false,
    };

    for (const deviceConfig of this.systemConfig.devices) {
      this._processWatchdogForDevice(deviceConfig.name, now, actions);
    }

    result.stateChanged = actions.stateChanged;
    if (actions.devicesToPing.size > 0) {
      const { commands, logs, stagger } = this._prepareControllerPings(actions.devicesToPing);
      appendLshMessages(result, commands);
      result.logs.push(...logs);
      if (stagger) {
        result.staggerLshMessages = true;
      }
    }

    if (actions.shouldProbeBridges) {
      prependLshMessages(result, this._buildBridgeProbeCommand());
      result.logs.push(
        "Requesting one bridge-level service ping to distinguish bridge health from controller silence.",
      );
      if (result.messages[Output.Lsh] && Array.isArray(result.messages[Output.Lsh])) {
        result.staggerLshMessages = true;
      }
    }

    if (actions.unhealthyDevicesForAlert.length > 0) {
      this._emitAlert(
        result,
        actions.unhealthyDevicesForAlert,
        "unhealthy",
        "device_unreachable",
        "watchdog",
      );
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
        actions.shouldProbeBridges = true;
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

  private _emitHomieLifecycleAlert(
    result: ServiceResult,
    deviceName: string,
    status: "healthy" | "unhealthy",
    eventType: "device_lifecycle_online" | "device_lifecycle_offline",
    reason: string,
  ): void {
    this._emitAlert(result, [{ name: deviceName, reason }], status, eventType, "homie_lifecycle");
  }

  private _handleRetainedHomieState(
    deviceName: string,
    homieState: HomieLifecycleState,
    existingDevice: DeviceState | undefined,
    previousLifecycleState: HomieLifecycleState | null,
    isConfiguredDevice: boolean,
  ): ServiceResult {
    const result = createEmptyServiceResult();

    // Homie publishes `$state` as retained. In practice this means the bridge-local
    // runtime transitions `lost -> init -> ready` also reach Node-RED with
    // `msg.retain === true`.
    //
    // We therefore use two different rules:
    // 1. If the device has not produced any live session activity yet, a retained
    //    `$state` is stored only as a silent baseline and must not emit alerts.
    // 2. Once the device is already part of the live session, retained `$state`
    //    transitions are treated as authoritative runtime events.
    if (!existingDevice && !isConfiguredDevice) {
      return result;
    }

    const lifecycleChanged = this.deviceManager.recordHomieLifecycleState(
      deviceName,
      homieState,
      false,
    ).stateChanged;

    if (!existingDevice || existingDevice.lastSeenTime === 0 || !lifecycleChanged) {
      return result;
    }

    result.stateChanged = true;

    if (isDiagnosticOnlyHomieState(homieState)) {
      result.logs.push(
        `Device '${deviceName}' reported retained Homie lifecycle state '${homieState}'. Ignoring it for reachability, alerts and resync.`,
      );
      return result;
    }

    const retainedWentOffline = previousLifecycleState === "ready" && homieState === "lost";
    const retainedCameOnline =
      homieState === "ready" &&
      (previousLifecycleState === "lost" ||
        previousLifecycleState === "init" ||
        previousLifecycleState === "sleeping");

    if (retainedWentOffline) {
      result.logs.push(
        `Device '${deviceName}' reported retained Homie runtime transition 'ready -> lost'. Emitting an offline alert without changing reachability state.`,
      );
      this._emitHomieLifecycleAlert(
        result,
        deviceName,
        "unhealthy",
        "device_lifecycle_offline",
        "Device reported as 'lost' by Homie.",
      );
      return result;
    }

    if (retainedCameOnline) {
      result.logs.push(
        `Device '${deviceName}' reported retained Homie runtime transition '${previousLifecycleState} -> ready'. Emitting a recovery alert without changing reachability state.`,
      );
      this._emitHomieLifecycleAlert(
        result,
        deviceName,
        "healthy",
        "device_lifecycle_online",
        "Device reported recovery as 'ready' by Homie.",
      );
      return result;
    }

    result.logs.push(
      `Device '${deviceName}' reported retained Homie lifecycle state '${homieState}'. Ignoring it for reachability, alerts and resync.`,
    );
    return result;
  }

  private _handleLiveHomieState(
    deviceName: string,
    homieState: HomieLifecycleState,
    previousLifecycleState: HomieLifecycleState | null,
  ): ServiceResult {
    const result = createEmptyServiceResult();
    const lifecycleChanged = this.deviceManager.recordHomieLifecycleState(
      deviceName,
      homieState,
      true,
    ).stateChanged;
    const bridgeConnectionResult = this.deviceManager.updateBridgeConnectionState(
      deviceName,
      homieState,
    );

    if (isDiagnosticOnlyHomieState(homieState)) {
      if (!bridgeConnectionResult.stateChanged && !lifecycleChanged) {
        return result;
      }

      result.stateChanged = bridgeConnectionResult.stateChanged || lifecycleChanged;
      result.logs.push(
        `Device '${deviceName}' reported Homie lifecycle state '${homieState}'. Ignoring it for alerts and resync.`,
      );
      return result;
    }

    // A retained `ready` recorded earlier is enough to tell us that a subsequent live
    // `lost` means "device went offline", even if this Node-RED session never observed
    // a live `ready` edge and the boolean `connected` flag therefore remained false.
    const wentOfflineFromLifecycleBaseline =
      !bridgeConnectionResult.stateChanged &&
      homieState === "lost" &&
      previousLifecycleState === "ready";

    if (!bridgeConnectionResult.stateChanged && !wentOfflineFromLifecycleBaseline) {
      return result;
    }

    result.stateChanged = bridgeConnectionResult.stateChanged || lifecycleChanged;

    if (bridgeConnectionResult.stateChanged) {
      result.logs.push(`Bridge '${deviceName}' connection state changed to '${homieState}'.`);
    } else {
      result.logs.push(
        `Bridge '${deviceName}' reported a live Homie transition from retained 'ready' to live '${homieState}'. Treating it as an offline event.`,
      );
    }

    const wentOffline =
      (bridgeConnectionResult.wasConnected && !bridgeConnectionResult.isConnected) ||
      wentOfflineFromLifecycleBaseline;
    const cameOnline = !bridgeConnectionResult.wasConnected && bridgeConnectionResult.isConnected;

    if (wentOffline) {
      this._emitHomieLifecycleAlert(
        result,
        deviceName,
        "unhealthy",
        "device_lifecycle_offline",
        `Bridge reported as '${homieState}' by Homie.`,
      );
      return result;
    }

    if (cameOnline) {
      result.logs.push(`Bridge '${deviceName}' came back online (Homie state: ready).`);
      this._emitHomieLifecycleAlert(
        result,
        deviceName,
        "healthy",
        "device_lifecycle_online",
        "Bridge is now connected and ready to refresh controller state.",
      );
      this.requestSnapshotRecovery(result, deviceName, {
        detailsAndState: `Bridge '${deviceName}' is online. Requesting the missing authoritative snapshot data.`,
        stateOnly: `Bridge '${deviceName}' is online. Requesting the missing authoritative snapshot data.`,
      });
    }

    return result;
  }

  private _handleHomieState(
    deviceName: string,
    payload: unknown,
    isRetained: boolean,
  ): ServiceResult {
    const existingDevice = this.deviceManager.getDevice(deviceName);
    const isConfiguredDevice = this.deviceConfigMap.has(deviceName);
    const previousLifecycleState = existingDevice?.lastHomieState ?? null;
    const homieState = String(payload) as HomieLifecycleState;

    if (isRetained) {
      return this._handleRetainedHomieState(
        deviceName,
        homieState,
        existingDevice,
        previousLifecycleState,
        isConfiguredDevice,
      );
    }

    return this._handleLiveHomieState(deviceName, homieState, previousLifecycleState);
  }

  private _handleLshConf(
    deviceName: string,
    payload: unknown,
    isLiveTelemetry: boolean,
  ): ServiceResult {
    const result = createEmptyServiceResult();
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
      this.recordLiveControllerActivity(result, deviceName, "details");
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
    const result = createEmptyServiceResult();
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
        this.recordLiveControllerActivity(result, deviceName, "state");
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
          this._deviceCommandTopic(deviceName),
          { p: LshProtocol.REQUEST_DETAILS } as RequestDetailsPayload,
          1,
        );
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    return result;
  }

  private _handleLshEvents(
    deviceName: string,
    payload: unknown,
    isLiveTelemetry: boolean,
  ): ServiceResult {
    if (!this.validators.validateAnyEventsTopic(payload)) {
      const result = createEmptyServiceResult();
      const errorText =
        this.validators.validateAnyEventsTopic.errors?.map((e) => e.message).join(", ") ||
        "unknown validation error";
      result.warnings.push(`Invalid 'events' payload from ${deviceName}: ${errorText}`);
      return result;
    }
    const eventsPayload = payload as AnyEventsTopicPayload;
    const result = createEmptyServiceResult();

    switch (eventsPayload.p) {
      case LshProtocol.NETWORK_CLICK_REQUEST: {
        if (isLiveTelemetry) {
          this.recordLiveControllerActivity(result, deviceName, "events traffic");
        }
        mergeServiceResults(result, this._processNewClickRequest(deviceName, eventsPayload));
        return result;
      }

      case LshProtocol.NETWORK_CLICK_CONFIRM: {
        if (isLiveTelemetry) {
          this.recordLiveControllerActivity(result, deviceName, "events traffic");
        }
        mergeServiceResults(result, this._processClickConfirmation(deviceName, eventsPayload));
        return result;
      }

      case LshProtocol.PING:
        this.recordControllerPingResponse(result, deviceName, isLiveTelemetry);
        break;

      default:
        return result;
    }
    return result;
  }

  private _handleLshBridge(deviceName: string, payload: unknown): ServiceResult {
    if (!this.validators.validateAnyBridgeTopic(payload)) {
      const result = createEmptyServiceResult();
      const errorText =
        this.validators.validateAnyBridgeTopic.errors?.map((e) => e.message).join(", ") ||
        "unknown validation error";
      result.warnings.push(`Invalid 'bridge' payload from ${deviceName}: ${errorText}`);
      return result;
    }

    const bridgePayload = payload as AnyBridgeTopicPayload;
    const result = createEmptyServiceResult();

    if (isBridgeDiagnosticPayload(bridgePayload)) {
      result.logs.push(
        `Bridge diagnostic from '${deviceName}': ${bridgePayload.kind}. Ignoring it for controller reachability and click logic.`,
      );
      return result;
    }

    const servicePingReply = bridgePayload;
    const { stateChanged, bridgeBecameConnected, controllerDisconnected, snapshotInvalidated } =
      this.deviceManager.recordBridgePingReply(
        deviceName,
        servicePingReply.controller_connected,
        servicePingReply.runtime_synchronized,
      );

    if (stateChanged) {
      result.stateChanged = true;
    }

    if (bridgeBecameConnected) {
      result.logs.push(`Bridge '${deviceName}' replied to the service ping and is reachable.`);
    } else {
      result.logs.push(`Received bridge service ping reply from '${deviceName}'.`);
    }

    if (!servicePingReply.controller_connected) {
      result.logs.push(
        `Bridge '${deviceName}' reports that the downstream controller link is disconnected.`,
      );
    } else if (!servicePingReply.runtime_synchronized) {
      result.logs.push(
        `Bridge '${deviceName}' reports that the controller link is up but its runtime cache is not synchronized yet.`,
      );
    } else {
      result.logs.push(
        `Bridge '${deviceName}' reports a connected and synchronized downstream controller path.`,
      );
    }

    if (controllerDisconnected) {
      result.warnings.push(
        `Device '${deviceName}' is no longer considered controller-reachable because the bridge reported controller_connected=false.`,
      );
    }

    if (snapshotInvalidated) {
      this.requestSnapshotRecovery(result, deviceName, {
        detailsAndState: `Bridge '${deviceName}' reported an unsynchronized runtime cache. Requesting a fresh authoritative snapshot immediately.`,
        stateOnly: `Bridge '${deviceName}' reported an unsynchronized runtime cache. Requesting a fresh authoritative state immediately.`,
      });
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
    const result = createEmptyServiceResult();
    const { c: correlationId, i: buttonId, t: clickType } = payload;
    const slotKey = buildClickSlotKey(deviceName, buttonId, clickType);
    const transactionKey = buildClickCorrelationKey(deviceName, buttonId, clickType, correlationId);
    const commandTopic = this._deviceCommandTopic(deviceName);

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
        this._emitAlert(
          result,
          [{ name: deviceName, reason: `Action failed: ${error.reason}` }],
          "unhealthy",
          "action_failed",
          "action_validation",
          payload,
        );

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
    const result = createEmptyServiceResult();
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
      this._assertActorCanHandleClick(actor, clickType);
    }

    return { actors, otherActors };
  }

  private _assertActorCanHandleClick(actor: Actor, clickType: ClickType): void {
    const device = this.deviceManager.getDevice(actor.name);
    if (!device) {
      throw new ClickValidationError(
        `Target actor '${actor.name}' is unknown to the registry.`,
        "click",
      );
    }

    if (!device.bridgeConnected) {
      throw new ClickValidationError(`Target actor '${actor.name}' bridge is offline.`, "click");
    }

    if (!device.connected) {
      throw new ClickValidationError(
        `Target actor '${actor.name}' controller is offline or not responding.`,
        "click",
      );
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
    if (this._actorRequiresAuthoritativeState(actor, clickType) && device.lastStateTime === 0) {
      throw new ClickValidationError(
        `Target actor '${actor.name}' has no authoritative actuator state yet.`,
        "click",
      );
    }

    if (device.actuatorsIDs.length === 0) {
      throw new ClickValidationError(`Target actor '${actor.name}' has no actuators.`, "click");
    }

    if (actor.allActuators) {
      return;
    }

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

  private _actorRequiresAuthoritativeState(actor: Actor, clickType: ClickType): boolean {
    return clickType === ClickType.Long || !actor.allActuators;
  }

  private _buildActorBooleanStates(
    actor: Actor,
    device: DeviceState,
    stateToSet: boolean,
  ): { states: boolean[] | null; warning?: string } {
    if (actor.allActuators) {
      return {
        states: new Array<boolean>(device.actuatorsIDs.length).fill(stateToSet),
      };
    }

    if (device.lastStateTime === 0) {
      return {
        states: null,
        warning: `Skipping actor '${actor.name}' because its actuator state is not authoritative yet.`,
      };
    }

    const states = device.actuatorStates.slice();
    for (const actuatorId of actor.actuators) {
      const index = device.actuatorIndexes[actuatorId];
      if (index !== undefined) {
        states[index] = stateToSet;
      }
    }

    return { states };
  }

  private _packBooleanStates(booleanStates: boolean[]): number[] {
    const packedBytes = new Array<number>(Math.ceil(booleanStates.length / 8)).fill(0);

    for (let i = 0; i < booleanStates.length; i++) {
      if (booleanStates[i]) {
        const byteIndex = i >> 3; // i / 8
        const bitIndex = i & 7; // i % 8
        packedBytes[byteIndex] |= BIT_MASK_8[bitIndex];
      }
    }

    return packedBytes;
  }

  private _resolveClickState(
    result: Pick<ServiceResult, "logs" | "warnings">,
    actors: Actor[],
    otherActors: string[],
    clickType: ClickType,
  ): boolean | null {
    if (clickType === ClickType.SuperLong) {
      result.logs.push("Executing SLC logic: setting state to OFF.");
      return false;
    }

    const toggleResult = this.deviceManager.getSmartToggleState(actors, otherActors);
    if (toggleResult.warning) {
      result.warnings.push(toggleResult.warning);
    }
    result.logs.push(
      `Smart Toggle: ${toggleResult.active}/${toggleResult.total} active. Decision: ${
        toggleResult.stateToSet ? "ON" : "OFF"
      }`,
    );

    if (toggleResult.total === 0) {
      if (!toggleResult.warning) {
        result.warnings.push("Smart Toggle aborted because no authoritative state is available.");
      }
      result.logs.push(
        "Skipping click execution because no authoritative actor state is available.",
      );
      return null;
    }

    return toggleResult.stateToSet;
  }

  private _emitOtherActorsCommand(
    result: Pick<ServiceResult, "messages">,
    otherActors: string[],
    stateToSet: boolean,
  ): void {
    if (otherActors.length === 0) {
      return;
    }

    const payload: OtherActorsCommandPayload = {
      otherActors,
      stateToSet,
    };

    result.messages[Output.OtherActors] = { payload };
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
    const stateToSet = this._resolveClickState(result, actors, otherActors, clickType);
    if (stateToSet === null) {
      return result;
    }

    const { commands: lshCommands, warnings: commandWarnings } = this.buildStateCommands(
      actors,
      stateToSet,
    );
    result.warnings.push(...commandWarnings);
    if (lshCommands.length > 0) {
      result.messages[Output.Lsh] = lshCommands;
    }

    this._emitOtherActorsCommand(result, otherActors, stateToSet);
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

      const commandTopic = this._deviceCommandTopic(actor.name);
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
        continue;
      }

      const stateBuildResult = this._buildActorBooleanStates(actor, device, stateToSet);
      if (!stateBuildResult.states) {
        warnings.push(stateBuildResult.warning!);
        continue;
      }

      commands.push(
        this._createLshCommand(
          commandTopic,
          {
            p: LshProtocol.SET_STATE,
            s: this._packBooleanStates(stateBuildResult.states),
          } as SetStatePayload,
          2,
        ),
      );
    }
    return { commands, warnings };
  }

  /**
   * Prepares controller-level ping commands for a list of devices.
   * Multiple pings are staggered to avoid command bursts.
   * @internal
   */
  private _prepareControllerPings(devicesToPingSet: Set<string>): {
    commands: NodeMessage | NodeMessage[];
    logs: string[];
    stagger: boolean;
  } {
    const logs: string[] = [];
    const devicesToPing = Array.from(devicesToPingSet);

    logs.push(`Preparing controller-level pings for ${devicesToPing.length} device(s)...`);
    const stagger = devicesToPing.length > 1;
    const pingCommands = this._buildDevicePingCommands(devicesToPing);

    return {
      commands: pingCommands.length === 1 ? pingCommands[0] : pingCommands,
      logs,
      stagger,
    };
  }

  private _emitAlert(
    result: Pick<ServiceResult, "messages">,
    devices: { name: string; reason: string }[],
    status: "healthy" | "unhealthy",
    eventType: AlertEventType,
    eventSource: AlertEventSource,
    details?: unknown,
  ): void {
    const payload: AlertPayload = {
      message: formatAlertMessage(devices, status, details),
      status,
      event_type: eventType,
      event_source: eventSource,
      devices,
      details,
    };
    result.messages[Output.Alerts] = { payload };
  }
}
