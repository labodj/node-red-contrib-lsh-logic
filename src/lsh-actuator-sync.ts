/**
 * @file Node-RED helper that syncs downstream smart-device state back to an LSH actuator.
 *
 * The node is intentionally policy-light: upstream flow nodes translate vendor-specific
 * payloads to a boolean desired state and annotate each message with the LSH device/actuator
 * that powers that downstream device. This helper only reads the selected `lsh-logic`
 * context exports, compares state when available, and emits a Homie `state/set` command.
 */

import type { Node, NodeAPI, NodeMessage } from "node-red";

type ContextName = "flow" | "global";
type CommandQos = 0 | 1 | 2;
type AllowedDirection = "both" | "on-only" | "off-only";

type ContextStore = {
  get(key: string): unknown;
};

type StatusShape = {
  fill: "red" | "green" | "yellow" | "blue" | "grey";
  shape: "dot" | "ring";
  text: string;
};

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

type SendFunction = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type DoneFunction = (err?: Error) => void;

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
const BOOLEAN_TRUE_STRINGS = new Set(["1", "true", "on", "yes"]);
const BOOLEAN_FALSE_STRINGS = new Set(["0", "false", "off", "no"]);

const normalizeRequiredString = (value: unknown, fieldName: string): string => {
  const normalized =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value).trim()
      : "";
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return normalized;
};

const normalizeContextName = (value: unknown, fieldName: string): ContextName => {
  if (value === "flow" || value === "global") {
    return value;
  }
  throw new Error(`${fieldName} must be flow or global.`);
};

const normalizeAllowedDirection = (value: unknown): AllowedDirection => {
  if (value === undefined || value === null || value === "") {
    return "both";
  }
  if (value === "both" || value === "on-only" || value === "off-only") {
    return value;
  }
  throw new Error("Allowed Direction must be both, on-only or off-only.");
};

const normalizeBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (BOOLEAN_TRUE_STRINGS.has(normalized)) {
      return true;
    }
    if (BOOLEAN_FALSE_STRINGS.has(normalized)) {
      return false;
    }
  }
  return Boolean(value);
};

const normalizeQos = (value: unknown): CommandQos => {
  const numericValue = Number(value);
  if (QOS_VALUES.has(numericValue)) {
    return numericValue as CommandQos;
  }
  throw new Error("Command QoS must be 0, 1 or 2.");
};

const normalizeNonNegativeNumber = (
  value: unknown,
  fieldName: string,
  defaultValue: number,
): number => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }
  return numericValue;
};

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

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asStateExport = (value: unknown): StateExportLike | undefined => {
  if (!isObjectRecord(value) || !isObjectRecord(value.devices)) {
    return undefined;
  }
  return { devices: value.devices };
};

const asConfigExport = (value: unknown): ConfigExportLike | undefined => {
  if (!isObjectRecord(value) || typeof value.homieBasePath !== "string") {
    return undefined;
  }
  return { homieBasePath: value.homieBasePath };
};

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

const normalizeMessageString = (value: unknown): string | undefined => {
  const normalized =
    typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeDesiredState = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (BOOLEAN_TRUE_STRINGS.has(normalized)) {
      return true;
    }
    if (BOOLEAN_FALSE_STRINGS.has(normalized)) {
      return false;
    }
  }
  return undefined;
};

const formatState = (state: boolean): string => (state ? "on" : "off");

/**
 * Runtime class attached to a single `lsh-actuator-sync` Node-RED node instance.
 */
export class LshActuatorSyncNode {
  private readonly node: Node;
  private readonly red: NodeAPI;
  private readonly config: NormalizedLshActuatorSyncNodeDef;
  private readonly lastCommandTimes = new Map<string, number>();
  private readonly pendingSyncs = new Map<string, PendingSync>();

  public constructor(node: Node, red: NodeAPI, config: LshActuatorSyncNodeDef) {
    this.node = node;
    this.red = red;
    this.config = normalizeConfig(config);
    this.node.status({ fill: "grey", shape: "ring", text: "Waiting" });
    this.registerNodeEventHandlers();
  }

  private registerNodeEventHandlers(): void {
    this.node.on("input", (msg, send, done) => {
      this.handleInput(msg, send, done);
    });

    this.node.on("close", (done: () => void) => {
      for (const pending of this.pendingSyncs.values()) {
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer);
        }
      }
      this.pendingSyncs.clear();
      done();
    });
  }

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

    const target = { deviceId, actuatorId, desiredState, sourceTopic: msg.topic };
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

  private queuePendingSync(pending: PendingSync): void {
    const targetKey = this.targetKey(pending);
    const existing = this.pendingSyncs.get(targetKey);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }

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

  private readMessageProperty(msg: NodeMessage, propertyPath: string): unknown {
    return this.red.util.getMessageProperty(msg, propertyPath);
  }

  private getContext(contextName: ContextName): ContextStore {
    return this.node.context()[contextName];
  }

  private isCoolingDown(targetKey: string): boolean {
    if (this.config.commandCooldownMs === 0) {
      return false;
    }

    const lastCommandTime = this.lastCommandTimes.get(targetKey);
    return (
      lastCommandTime !== undefined && Date.now() - lastCommandTime < this.config.commandCooldownMs
    );
  }

  private isDirectionAllowed(target: Pick<SyncTarget, "desiredState">): boolean {
    if (this.config.allowedDirection === "both") {
      return true;
    }
    if (this.config.allowedDirection === "on-only") {
      return target.desiredState;
    }
    return !target.desiredState;
  }

  private targetKey(target: Pick<SyncTarget, "deviceId" | "actuatorId">): string {
    return `${target.deviceId}/${target.actuatorId}`;
  }

  private warningForRetryableReason(
    target: Pick<SyncTarget, "deviceId" | "actuatorId">,
    reason: RetryableReason,
  ): string {
    if (reason === "missing-config") {
      return "Effective LSH config export is missing or invalid.";
    }
    return `No authoritative LSH state for ${target.deviceId}/${target.actuatorId}.`;
  }

  private statusForReason(reason: RetryableReason): string {
    return reason === "missing-config" ? "Missing config" : "Unknown LSH state";
  }

  private skip(warning: string, statusText: string): null {
    this.node.warn(warning);
    this.setStatus({ fill: "yellow", shape: "ring", text: statusText });
    return null;
  }

  private setStatus(status: StatusShape): void {
    this.node.status(status);
  }
}

const nodeRedModule = function (RED: NodeAPI) {
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
