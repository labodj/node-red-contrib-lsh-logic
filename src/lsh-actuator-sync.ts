/**
 * @file Node-RED helper that syncs downstream smart-device state back to an LSH actuator.
 *
 * The node is intentionally policy-light: upstream flow nodes translate vendor-specific
 * payloads to a boolean desired state and annotate each message with the LSH device/actuator
 * that powers that downstream device. This helper only reads the selected `lsh-logic`
 * context exports, compares state when available, and emits a Homie `state/set` command.
 */

import type { Node, NodeAPI, NodeMessage } from "node-red";

import {
  BASIC_FALSE_TEXT_VALUES,
  BASIC_TRUE_TEXT_VALUES,
  clearPendingTimers,
  formatState,
  getNodeContext,
  isObjectRecord,
  normalizeBoolean,
  normalizeBooleanState,
  normalizeContextName,
  normalizeMessageString,
  normalizeNonNegativeNumber,
  normalizeRequiredString,
  readMessageProperty,
  warnAndSetStatus,
} from "./node-red-runtime";
import type {
  ContextName,
  ContextReader,
  DoneFunction,
  SendFunction,
  StatusShape,
} from "./node-red-runtime";

type CommandQos = 0 | 1 | 2;
type AllowedDirection = "both" | "on-only" | "off-only";

type LshActuatorSyncNodeDef = {
  id: string;
  type: string;
  name: string;
  z: string;
  stateContext: ContextName;
  stateKey: string;
  configContext: ContextName;
  configKey: string;
  desiredStateProperty: string;
  deviceIdProperty: string;
  actuatorIdProperty: string;
  qos: string | number;
  ignoreRetained: boolean | string;
  requireKnownState: boolean | string;
  commandCooldownMs: number | string;
  stateWaitTimeoutMs?: number | string;
  allowedDirection?: AllowedDirection;
};

type NormalizedLshActuatorSyncNodeDef = Omit<
  LshActuatorSyncNodeDef,
  "qos" | "ignoreRetained" | "requireKnownState" | "commandCooldownMs" | "stateWaitTimeoutMs"
> & {
  qos: CommandQos;
  ignoreRetained: boolean;
  requireKnownState: boolean;
  commandCooldownMs: number;
  stateWaitTimeoutMs: number;
  allowedDirection: AllowedDirection;
};

type DeviceStateLike = {
  actuatorIndexes?: Record<string, unknown>;
  actuatorStates?: unknown[];
  lastStateTime?: unknown;
};

type StateExportLike = {
  devices: Record<string, unknown>;
};

type ConfigExportLike = {
  homieBasePath: string;
};

type SyncTarget = {
  deviceId: string;
  actuatorId: string;
  desiredState: boolean;
  sourceTopic?: string;
};

type PendingSync = SyncTarget & {
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
};

type RetryableReason = "missing-config" | "unknown-state";
type CommandBuildResult = NodeMessage | null | RetryableReason;

const STATE_RETRY_INTERVAL_MS = 250;
const QOS_VALUES = new Set([0, 1, 2]);
const DESIRED_TRUE_VALUES: ReadonlySet<string> = new Set(BASIC_TRUE_TEXT_VALUES);
const DESIRED_FALSE_VALUES: ReadonlySet<string> = new Set(BASIC_FALSE_TEXT_VALUES);

/**
 * Normalizes the Direction editor option, defaulting to full bidirectional sync.
 */
const normalizeAllowedDirection = (value: unknown): AllowedDirection => {
  if (value === undefined || value === null || value === "") {
    return "both";
  }
  if (value === "both" || value === "on-only" || value === "off-only") {
    return value;
  }
  throw new Error("Allowed Direction must be both, on-only or off-only.");
};

/**
 * Normalizes the MQTT QoS editor value and rejects invalid levels up front.
 */
const normalizeQos = (value: unknown): CommandQos => {
  const numericValue = Number(value);
  if (QOS_VALUES.has(numericValue)) {
    return numericValue as CommandQos;
  }
  throw new Error("Command QoS must be 0, 1 or 2.");
};

/**
 * Converts the raw Node-RED editor config into a runtime-safe immutable shape.
 */
const normalizeConfig = (config: LshActuatorSyncNodeDef): NormalizedLshActuatorSyncNodeDef => ({
  ...config,
  stateContext: normalizeContextName(config.stateContext, "State Context"),
  stateKey: normalizeRequiredString(config.stateKey, "State Context Key"),
  configContext: normalizeContextName(config.configContext, "Config Context"),
  configKey: normalizeRequiredString(config.configKey, "Config Context Key"),
  desiredStateProperty: normalizeRequiredString(
    config.desiredStateProperty,
    "Desired State Property",
  ),
  deviceIdProperty: normalizeRequiredString(config.deviceIdProperty, "Device ID Property"),
  actuatorIdProperty: normalizeRequiredString(config.actuatorIdProperty, "Actuator ID Property"),
  qos: normalizeQos(config.qos),
  ignoreRetained: normalizeBoolean(config.ignoreRetained, true),
  requireKnownState: normalizeBoolean(config.requireKnownState, true),
  commandCooldownMs: normalizeNonNegativeNumber(config.commandCooldownMs, "Command Cooldown", 0),
  stateWaitTimeoutMs: normalizeNonNegativeNumber(config.stateWaitTimeoutMs, "LSH Ready Wait", 5000),
  allowedDirection: normalizeAllowedDirection(config.allowedDirection),
});

/**
 * Narrows the exported LSH state snapshot to the fields this helper needs.
 */
const asStateExport = (value: unknown): StateExportLike | undefined => {
  if (!isObjectRecord(value) || !isObjectRecord(value.devices)) {
    return undefined;
  }
  return { devices: value.devices };
};

/**
 * Narrows the exported effective config to a valid Homie base path.
 */
const asConfigExport = (value: unknown): ConfigExportLike | undefined => {
  if (!isObjectRecord(value) || typeof value.homieBasePath !== "string") {
    return undefined;
  }
  return { homieBasePath: value.homieBasePath };
};

/**
 * Narrows one device entry from the exported LSH registry.
 */
const asDeviceState = (value: unknown): DeviceStateLike | undefined => {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  return {
    actuatorIndexes: isObjectRecord(value.actuatorIndexes) ? value.actuatorIndexes : undefined,
    actuatorStates: Array.isArray(value.actuatorStates) ? value.actuatorStates : undefined,
    lastStateTime: value.lastStateTime,
  };
};

/**
 * Normalizes the requested downstream state to a boolean command target.
 */
const normalizeDesiredState = (value: unknown): boolean | undefined => {
  return normalizeBooleanState(value, {
    trueValues: DESIRED_TRUE_VALUES,
    falseValues: DESIRED_FALSE_VALUES,
  });
};

/**
 * Runtime class attached to a single `lsh-actuator-sync` Node-RED node instance.
 */
export class LshActuatorSyncNode {
  private readonly node: Node;
  private readonly red: NodeAPI;
  private readonly config: NormalizedLshActuatorSyncNodeDef;
  private readonly lastCommandTimes = new Map<string, number>();
  private readonly pendingSyncs = new Map<string, PendingSync>();

  /**
   * Creates one runtime instance and validates the editor configuration once.
   */
  public constructor(node: Node, red: NodeAPI, config: LshActuatorSyncNodeDef) {
    this.node = node;
    this.red = red;
    this.config = normalizeConfig(config);
    this.node.status({ fill: "grey", shape: "ring", text: "Waiting" });
    this.registerNodeEventHandlers();
  }

  /**
   * Wires Node-RED lifecycle events and guarantees pending timers are cleaned up.
   */
  private registerNodeEventHandlers(): void {
    this.node.on("input", (msg, send, done) => {
      this.handleInput(msg, send, done);
    });

    this.node.on("close", (done: () => void) => {
      clearPendingTimers(this.pendingSyncs);
      done();
    });
  }

  /**
   * Handles one external state message and always completes the Node-RED callback.
   */
  private handleInput(msg: NodeMessage, send: SendFunction, done?: DoneFunction): void {
    try {
      if (this.config.ignoreRetained && msg.retain === true) {
        this.setStatus({ fill: "grey", shape: "ring", text: "Retained ignored" });
        done?.();
        return;
      }

      const command = this.handleSyncRequest(msg);
      if (command !== null) {
        send(command);
      }
      done?.();
    } catch (error) {
      const wrappedError = error instanceof Error ? error : new Error(String(error));
      this.node.error(`Error synchronizing LSH actuator: ${wrappedError.message}`, msg);
      this.setStatus({ fill: "red", shape: "ring", text: "Sync error" });
      done?.(wrappedError);
    }
  }

  /**
   * Parses input into a concrete sync target, applies direction policy, then builds a command.
   */
  private handleSyncRequest(msg: NodeMessage): NodeMessage | null {
    const desiredState = normalizeDesiredState(
      this.readMessageProperty(msg, this.config.desiredStateProperty),
    );
    if (desiredState === undefined) {
      return this.skip(
        "Desired state must be boolean, 1/0, true/false, on/off or yes/no.",
        "Invalid state",
      );
    }

    const deviceId = normalizeMessageString(
      this.readMessageProperty(msg, this.config.deviceIdProperty),
    );
    const actuatorId = normalizeMessageString(
      this.readMessageProperty(msg, this.config.actuatorIdProperty),
    );
    if (deviceId === undefined || actuatorId === undefined) {
      return this.skip(
        "Message must include target LSH deviceId and actuatorId.",
        "Missing target",
      );
    }

    const target = {
      deviceId,
      actuatorId,
      desiredState,
      sourceTopic: normalizeMessageString(msg.topic),
    };
    if (!this.isDirectionAllowed(target)) {
      this.setStatus({
        fill: "grey",
        shape: "ring",
        text: `${this.targetKey(target)} ${formatState(desiredState)} ignored`,
      });
      return null;
    }

    const result = this.tryBuildCommand(target);
    if (result === "missing-config" || result === "unknown-state") {
      return this.deferOrSkip(target, result);
    }
    return result;
  }

  /**
   * Reads current LSH exports and returns either a command, a no-op, or a retryable reason.
   */
  private tryBuildCommand(target: SyncTarget): CommandBuildResult {
    const { deviceId, actuatorId, desiredState, sourceTopic } = target;
    const configExport = asConfigExport(
      this.getContext(this.config.configContext).get(this.config.configKey),
    );
    if (configExport === undefined) {
      return "missing-config";
    }

    const currentState = this.readCurrentState(deviceId, actuatorId);
    if (currentState === "unknown" && this.config.requireKnownState) {
      return "unknown-state";
    }
    if (typeof currentState === "boolean" && currentState === desiredState) {
      this.setStatus({
        fill: "blue",
        shape: "dot",
        text: `${deviceId}/${actuatorId} already ${formatState(desiredState)}`,
      });
      return null;
    }

    const targetKey = `${deviceId}/${actuatorId}`;
    if (this.isCoolingDown(targetKey)) {
      this.setStatus({
        fill: "yellow",
        shape: "ring",
        text: `${targetKey} cooldown`,
      });
      return null;
    }

    this.lastCommandTimes.set(targetKey, Date.now());
    this.setStatus({
      fill: "green",
      shape: "dot",
      text: `${targetKey} -> ${formatState(desiredState)}`,
    });
    return {
      topic: `${configExport.homieBasePath}${deviceId}/${actuatorId}/state/set`,
      payload: desiredState,
      qos: this.config.qos,
      retain: false,
      lshSync: {
        deviceId,
        actuatorId,
        desiredState,
        previousState: currentState === "unknown" ? undefined : currentState,
        sourceTopic,
      },
    };
  }

  /**
   * Queues retryable startup problems or reports them immediately when waiting is disabled.
   */
  private deferOrSkip(target: SyncTarget, reason: RetryableReason): null {
    if (this.config.stateWaitTimeoutMs <= 0) {
      return this.skip(
        this.warningForRetryableReason(target, reason),
        this.statusForReason(reason),
      );
    }

    this.queuePendingSync({
      ...target,
      deadline: Date.now() + this.config.stateWaitTimeoutMs,
    });
    return null;
  }

  /**
   * Stores the latest pending state for a target and schedules the next readiness check.
   */
  private queuePendingSync(pending: PendingSync): void {
    const targetKey = this.targetKey(pending);
    const existing = this.pendingSyncs.get(targetKey);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }

    // The helper keeps only the latest input per actuator. Retrying at a short
    // fixed interval avoids dropping retained startup state while still letting
    // lsh-logic finish exporting authoritative state/config snapshots.
    const delay = Math.max(0, Math.min(STATE_RETRY_INTERVAL_MS, pending.deadline - Date.now()));
    const nextPending = {
      ...pending,
      timer: setTimeout(() => this.retryPendingSync(targetKey), delay),
    };
    this.pendingSyncs.set(targetKey, nextPending);
    this.setStatus({
      fill: "blue",
      shape: "ring",
      text: `${targetKey} waiting LSH`,
    });
  }

  /**
   * Re-checks one queued target and emits a command only after LSH state is safe to trust.
   */
  private retryPendingSync(targetKey: string): void {
    const pending = this.pendingSyncs.get(targetKey);
    if (pending === undefined) {
      return;
    }

    const result = this.tryBuildCommand(pending);
    if (result === "missing-config" || result === "unknown-state") {
      if (Date.now() >= pending.deadline) {
        this.pendingSyncs.delete(targetKey);
        this.skip(this.warningForRetryableReason(pending, result), this.statusForReason(result));
        return;
      }

      this.queuePendingSync(pending);
      return;
    }

    this.pendingSyncs.delete(targetKey);
    if (result !== null) {
      this.node.send(result);
    }
  }

  /**
   * Reads the authoritative actuator state from the exported LSH device registry.
   */
  private readCurrentState(deviceId: string, actuatorId: string): boolean | "unknown" {
    const stateExport = asStateExport(
      this.getContext(this.config.stateContext).get(this.config.stateKey),
    );
    const device = asDeviceState(stateExport?.devices[deviceId]);
    if (device === undefined) {
      return "unknown";
    }

    if (Number(device.lastStateTime ?? 0) <= 0) {
      return "unknown";
    }

    const actuatorIndex = device.actuatorIndexes?.[actuatorId];
    if (typeof actuatorIndex !== "number" || !Number.isInteger(actuatorIndex)) {
      return "unknown";
    }

    const currentState = device.actuatorStates?.[actuatorIndex];
    return typeof currentState === "boolean" ? currentState : "unknown";
  }

  /**
   * Reads a configured Node-RED message property using the runtime utility API.
   */
  private readMessageProperty(msg: NodeMessage, propertyPath: string): unknown {
    return readMessageProperty(this.red, msg, propertyPath);
  }

  /**
   * Selects the configured flow/global context store.
   */
  private getContext(contextName: ContextName): ContextReader {
    return getNodeContext(this.node, contextName);
  }

  /**
   * Enforces a per-actuator command cooldown to avoid feedback loops.
   */
  private isCoolingDown(targetKey: string): boolean {
    if (this.config.commandCooldownMs === 0) {
      return false;
    }

    const lastCommandTime = this.lastCommandTimes.get(targetKey);
    return (
      lastCommandTime !== undefined && Date.now() - lastCommandTime < this.config.commandCooldownMs
    );
  }

  /**
   * Applies the ON-only/OFF-only guard used for powered smart-light edge cases.
   */
  private isDirectionAllowed(target: Pick<SyncTarget, "desiredState">): boolean {
    if (this.config.allowedDirection === "both") {
      return true;
    }
    if (this.config.allowedDirection === "on-only") {
      return target.desiredState;
    }
    return !target.desiredState;
  }

  /**
   * Builds the stable map key used for cooldown and pending-sync tracking.
   */
  private targetKey(target: Pick<SyncTarget, "deviceId" | "actuatorId">): string {
    return `${target.deviceId}/${target.actuatorId}`;
  }

  /**
   * Formats the warning shown when a retryable problem ultimately times out.
   */
  private warningForRetryableReason(
    target: Pick<SyncTarget, "deviceId" | "actuatorId">,
    reason: RetryableReason,
  ): string {
    if (reason === "missing-config") {
      return "Effective LSH config export is missing or invalid.";
    }
    return `No authoritative LSH state for ${target.deviceId}/${target.actuatorId}.`;
  }

  /**
   * Formats compact status text for retryable startup problems.
   */
  private statusForReason(reason: RetryableReason): string {
    return reason === "missing-config" ? "Missing config" : "Unknown LSH state";
  }

  /**
   * Reports an intentional no-op without throwing or failing the Node-RED message.
   */
  private skip(warning: string, statusText: string): null {
    return warnAndSetStatus(this.node, warning, {
      fill: "yellow",
      shape: "ring",
      text: statusText,
    });
  }

  /**
   * Updates the Node-RED node status with the package-wide status shape.
   */
  private setStatus(status: StatusShape): void {
    this.node.status(status);
  }
}

/**
 * Node-RED module entry point; registers the runtime class with the editor type.
 */
const nodeRedModule = function (RED: NodeAPI) {
  /**
   * Node-RED constructor wrapper that translates editor config into runtime state.
   */
  function LshActuatorSyncNodeWrapper(this: Node, config: LshActuatorSyncNodeDef) {
    RED.nodes.createNode(this, config);
    try {
      new LshActuatorSyncNode(this, RED, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(`Invalid node configuration: ${message}`);
      this.status({ fill: "red", shape: "ring", text: "Node Config Error" });
    }
  }

  RED.nodes.registerType("lsh-actuator-sync", LshActuatorSyncNodeWrapper);
};

module.exports = Object.assign(nodeRedModule, { LshActuatorSyncNode });
