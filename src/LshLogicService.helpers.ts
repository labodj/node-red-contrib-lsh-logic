/**
 * @file Shared pure helpers for `LshLogicService`.
 * The service is intentionally stateful, but a few operations are mechanical:
 * topic parsing, click key building, `ServiceResult` merging and small type
 * guards. Keeping those helpers here makes the main service easier to scan
 * without hiding any business logic.
 */

import { Output } from "./types";
import type {
  AnyBridgeTopicPayload,
  BridgeDiagnosticPayload,
  ClickType,
  HomieLifecycleState,
  MqttSubscribeMsg,
  MqttUnsubscribeMsg,
  ServiceResult,
} from "./types";
import type { NodeMessage } from "node-red";

/**
 * Bit masks used to unpack the compact actuator-state byte array sent by the
 * firmware. Index 0 matches bit 0, index 7 matches bit 7.
 */
export const BIT_MASK_8 = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80] as const;

/**
 * Parsed representation of a device-scoped MQTT topic.
 * `suffix` always starts with `/`, for example `/state` or `/bridge`.
 */
export type DeviceScopedTopic = {
  deviceName: string;
  suffix: string;
};

/**
 * Builds the stable slot key used for click transaction tracking before the
 * correlation id is known.
 */
export function buildClickSlotKey(
  deviceName: string,
  buttonId: number,
  clickType: ClickType,
): string {
  return `${deviceName}.${buttonId}.${clickType}`;
}

/**
 * Builds the fully qualified click transaction key including correlation id.
 */
export function buildClickCorrelationKey(
  deviceName: string,
  buttonId: number,
  clickType: ClickType,
  correlationId: number,
): string {
  return `${buildClickSlotKey(deviceName, buttonId, clickType)}.${correlationId}`;
}

/**
 * Returns true for Homie lifecycle states that are informative only and should
 * not be treated as online or offline transitions.
 */
export function isDiagnosticOnlyHomieState(
  homieState: HomieLifecycleState,
): homieState is "init" | "sleeping" {
  return homieState === "init" || homieState === "sleeping";
}

/**
 * Narrows a validated bridge payload to the diagnostic-only envelope.
 */
export function isBridgeDiagnosticPayload(
  payload: AnyBridgeTopicPayload,
): payload is BridgeDiagnosticPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "event" in payload &&
    payload.event === "diagnostic" &&
    "kind" in payload &&
    typeof payload.kind === "string"
  );
}

/**
 * Creates an empty `ServiceResult` with the exact shape expected by the rest
 * of the node. Centralizing it keeps every early return consistent.
 */
export function createEmptyServiceResult(): ServiceResult {
  return {
    messages: {},
    logs: [],
    warnings: [],
    errors: [],
    stateChanged: false,
    registryChanged: false,
  };
}

type ConfigurationMessage = MqttSubscribeMsg | MqttUnsubscribeMsg;

/**
 * Normalizes a node output slot to an array so merge logic can stay linear and
 * type-safe without widening the public `OutputMessages` contract.
 */
function toMessageArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Merges a child `ServiceResult` into a parent one without dropping messages,
 * warnings or the stagger hint.
 */
export function mergeServiceResults(target: ServiceResult, source: ServiceResult): void {
  const mergeOutputSlot = <T>(
    targetValue: T | T[] | undefined,
    sourceValue: T | T[] | undefined,
  ): T | T[] | undefined => {
    if (sourceValue === undefined) {
      return targetValue;
    }

    if (targetValue === undefined) {
      return sourceValue;
    }

    return [...toMessageArray(targetValue), ...toMessageArray(sourceValue)];
  };

  target.messages[Output.Lsh] = mergeOutputSlot<NodeMessage>(
    target.messages[Output.Lsh],
    source.messages[Output.Lsh],
  );
  target.messages[Output.OtherActors] = mergeOutputSlot<NodeMessage>(
    target.messages[Output.OtherActors],
    source.messages[Output.OtherActors],
  );
  target.messages[Output.Alerts] = mergeOutputSlot<NodeMessage>(
    target.messages[Output.Alerts],
    source.messages[Output.Alerts],
  );
  target.messages[Output.Configuration] = mergeOutputSlot<ConfigurationMessage>(
    target.messages[Output.Configuration],
    source.messages[Output.Configuration],
  );
  target.messages[Output.Debug] = mergeOutputSlot<NodeMessage>(
    target.messages[Output.Debug],
    source.messages[Output.Debug],
  );
  target.logs.push(...source.logs);
  target.warnings.push(...source.warnings);
  target.errors.push(...source.errors);
  target.stateChanged = target.stateChanged || source.stateChanged;
  target.registryChanged = Boolean(target.registryChanged || source.registryChanged);
  if (source.staggerLshMessages) {
    target.staggerLshMessages = true;
  }
}

/**
 * Parses topics shaped like `<basePath><deviceName>/<suffix>`.
 * Returns `null` when the topic does not contain a device segment followed by
 * another `/`.
 */
export function parseDeviceScopedTopic(topic: string, basePath: string): DeviceScopedTopic | null {
  const baseLen = basePath.length;
  const slashIndex = topic.indexOf("/", baseLen);
  if (slashIndex === -1 || slashIndex === baseLen) {
    return null;
  }

  return {
    deviceName: topic.substring(baseLen, slashIndex),
    suffix: topic.substring(slashIndex),
  };
}

/**
 * Appends one or more LSH messages to the `ServiceResult`, preserving the
 * existing message shape: a single message stays a single object, multiple
 * messages become an array.
 */
export function appendLshMessages(
  result: ServiceResult,
  messages: NodeMessage | NodeMessage[],
): void {
  const nextMessages = Array.isArray(messages) ? messages : [messages];
  const existingMessages = result.messages[Output.Lsh];

  if (!existingMessages) {
    result.messages[Output.Lsh] = nextMessages.length === 1 ? nextMessages[0] : nextMessages;
    return;
  }

  const mergedMessages = [
    ...(Array.isArray(existingMessages) ? existingMessages : [existingMessages]),
    ...nextMessages,
  ];
  result.messages[Output.Lsh] = mergedMessages.length === 1 ? mergedMessages[0] : mergedMessages;
}

/**
 * Prepends one or more LSH messages to the `ServiceResult`. This is used for
 * recovery commands that must run before already prepared outbound traffic.
 */
export function prependLshMessages(
  result: ServiceResult,
  messages: NodeMessage | NodeMessage[],
): void {
  const nextMessages = Array.isArray(messages) ? messages : [messages];
  const existingMessages = result.messages[Output.Lsh];

  if (!existingMessages) {
    result.messages[Output.Lsh] = nextMessages.length === 1 ? nextMessages[0] : nextMessages;
    return;
  }

  const mergedMessages = [
    ...nextMessages,
    ...(Array.isArray(existingMessages) ? existingMessages : [existingMessages]),
  ];
  result.messages[Output.Lsh] = mergedMessages.length === 1 ? mergedMessages[0] : mergedMessages;
}
