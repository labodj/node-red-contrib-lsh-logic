/**
 * @file Contains all shared type and interface definitions for the LSH Logic project.
 * This file serves as the single source of truth for data structures,
 * ensuring consistency across different modules. Centralizing type definitions
 * leverages TypeScript's static analysis to prevent common bugs.
 */

import type { NodeDef, NodeMessage } from "node-red";
import type { ClickType, LshProtocol } from "./generated/protocol";

export {
  ClickType,
  LshProtocol,
  LSH_PROTOCOL_KEYS,
  LSH_PROTOCOL_SPEC_REVISION,
  LSH_WIRE_PROTOCOL_MAJOR,
} from "./generated/protocol";

// --------------------------------------------------------------------------
// Node Configuration and Core Types
// --------------------------------------------------------------------------

/**
 * Defines the configuration options for the LSH Logic node, as set by the user
 * in the Node-RED editor. Each property directly corresponds to a field in the
 * node's configuration panel.
 */
export interface LshLogicNodeDef extends NodeDef {
  /** Base path for Homie device state topics (e.g., 'homie/'). */
  homieBasePath: string;
  /** Base path for LSH device command and state topics (e.g., 'LSH/'). */
  lshBasePath: string;
  /** Broadcast topic for global commands like a system-wide ping. */
  serviceTopic: string;
  /** The protocol to use for LSH command payloads. */
  protocol: "json" | "msgpack";
  /** Prefix for context keys when reading external device states. */
  otherDevicesPrefix: string;
  /** Path to the main JSON config, relative to the Node-RED user directory. */
  systemConfigPath: string;
  /** The context (flow or global) to store the full device state registry in, or 'none'. */
  exposeStateContext: "none" | "flow" | "global";
  /** The context key to use for the exposed state registry. */
  exposeStateKey: string;
  /** The context (flow or global) to store the generated MQTT topic list in, or 'none'. */
  exportTopics: "none" | "flow" | "global";
  /** The context key to use for the exported topic list. */
  exportTopicsKey: string;
  /** The context (flow or global) to store the node's own configuration in, or 'none'. */
  exposeConfigContext: "none" | "flow" | "global";
  /** The context key to use for the exposed configuration. */
  exposeConfigKey: string;
  /** The context (flow or global) from which to read the state of external actors. */
  otherActorsContext: "flow" | "global";
  /** Seconds to wait for a network click confirmation before it expires. */
  clickTimeout: number;
  /** Frequency in seconds for checking and cleaning up expired click transactions. */
  clickCleanupInterval: number;
  /** Frequency in seconds of the main device health check loop. */
  watchdogInterval: number;
  /** Seconds of device silence before sending an interrogation ping. */
  interrogateThreshold: number;
  /** Seconds to wait for a ping response before marking a device as 'stale'. */
  pingTimeout: number;
  /** Seconds to wait for initial Homie states before running active verification. */
  initialStateTimeout: number;
  /** Enable Home Assistant Auto-Discovery for Homie devices. */
  haDiscovery: boolean;
  /** Prefix for Home Assistant discovery topics (default: 'homeassistant'). */
  haDiscoveryPrefix: string;
}

/**
 * Provides a type-safe mapping of the node's physical output ports to their
 * corresponding index. Using an enum makes the code self-documenting.
 */
export enum Output {
  /** Output for commands to LSH protocol devices. */
  Lsh = 0,
  /** Output for commands to other (non-LSH) devices. */
  OtherActors = 1,
  /** Output for system health alerts (e.g., for Telegram). */
  Alerts = 2,
  /** Output for dynamic MQTT topic configuration messages. */
  Configuration = 3,
  /** Output for forwarding the original, unprocessed input message. */
  Debug = 4,
}

/**
 * Defines the structure for the object passed to the `send` method,
 * allowing messages to be targeted to specific outputs by their enum key.
 */
export type OutputMessages = {
  [Output.Lsh]?: NodeMessage | NodeMessage[];
  [Output.OtherActors]?: NodeMessage | NodeMessage[];
  [Output.Alerts]?: NodeMessage | NodeMessage[];
  [Output.Configuration]?:
    | MqttSubscribeMsg
    | MqttUnsubscribeMsg
    | Array<MqttSubscribeMsg | MqttUnsubscribeMsg>;
  [Output.Debug]?: NodeMessage | NodeMessage[];
};

/**
 * @internal
 * @description Describes the set of actions for the Node-RED adapter to perform
 * based on the result of a service layer operation. This is a crucial part of the
 * architecture, allowing the service to remain pure by describing *what* should
 * happen (e.g., send messages, log warnings) without actually performing I/O.
 */
export interface ServiceResult {
  /** Messages to be sent to the node's outputs. */
  messages: OutputMessages;
  /** Informational messages to be logged. */
  logs: string[];
  /** Warning messages to be logged. */
  warnings: string[];
  /** Error messages to be logged. */
  errors: string[];
  /** Flag indicating if the public-facing state has changed and should be exposed. */
  stateChanged: boolean;
  /** If true, indicates that an array of LSH messages should be sent with a delay between them. */
  staggerLshMessages?: boolean;
}

/**
 * Optional metadata about the MQTT envelope that carried an incoming payload.
 * This lets the service distinguish freshly published traffic from retained
 * broker replays without coupling it to Node-RED internals.
 */
export interface ProcessMessageOptions {
  /** `true` when the MQTT broker marked this delivery as retained. */
  retained?: boolean;
}

export type HomieLifecycleState = "init" | "ready" | "lost" | "sleeping";

// --------------------------------------------------------------------------
// LSH Protocol and Payloads
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Client -> Node Payloads (ESP -> Controllino)
// These interfaces define the expected structure of messages received from devices.
// --------------------------------------------------------------------------

/** Payload: Device Details. Sent by a device to report its static configuration via the 'conf' topic. */
export interface DeviceDetailsPayload {
  p: LshProtocol.DEVICE_DETAILS;
  /** Handshake-only protocol major used for compatibility checks. */
  v: number;
  /** The display name of the device (e.g., 'c1'). */
  n: string;
  /** An array of actuator IDs (e.g., ['1', '5']). */
  a: number[];
  /** An array of button IDs (e.g., ['1']). */
  b: number[];
}

/** Payload: Actuators State. Sent by a device to report the live state of its actuators via the 'state' topic.
 * @description The state is bitpacked into an array of bytes where each byte contains 8 actuator states.
 *              Byte 0, bit 0 = actuator 0; Byte 0, bit 7 = actuator 7; Byte 1, bit 0 = actuator 8, etc.
 *              Example: s=[90,3] for 10 actuators (90 = 0b01011010, 3 = 0b00000011).
 */
export interface DeviceActuatorsStatePayload {
  p: LshProtocol.ACTUATORS_STATE;
  /** An array of bitpacked bytes representing the ON/OFF state of each actuator. */
  s: number[];
}

/** Payload: Network Click Request. Initial request when a button is long-pressed. */
export interface NetworkClickRequestPayload {
  p: LshProtocol.NETWORK_CLICK_REQUEST;
  /** The type of click, e.g., long-click or super-long-click. */
  t: ClickType;
  /** The ID of the button that was pressed (e.g., 7). */
  i: number;
  /** Correlates request, ACK, failover and confirm across the same click lifecycle. */
  c: number;
}

/** Payload: Ping. A ping message for health checks, sent via the 'misc' topic. */
export interface PingPayload {
  p: LshProtocol.PING;
}

/**
 * Defines the structure of the message payload sent to the 'OtherActors' output.
 */
export interface OtherActorsCommandPayload {
  /** The list of target actor names (e.g., Tasmota, Zigbee devices). */
  otherActors: string[];
  /** The desired boolean state to set. */
  stateToSet: boolean;
}

/**
 * A discriminated union of all possible payloads received on a device's 'misc' topic.
 * This powerful TypeScript pattern allows the type of the payload to be inferred
 * based on the value of the 'p' property.
 */
export type AnyMiscTopicPayload =
  | NetworkClickRequestPayload
  | NetworkClickConfirmPayload
  | PingPayload;

// --------------------------------------------------------------------------
// Node -> Client Payloads (Controllino -> ESP)
// These interfaces define the structure of command messages sent to devices.
// --------------------------------------------------------------------------

/** Payload: Request Device Details. Sent to request a device's configuration. */
export interface RequestDetailsPayload {
  p: LshProtocol.REQUEST_DETAILS;
}

/** Payload: Request Actuators State. Sent to request a device's current actuator states. */
export interface RequestStatePayload {
  p: LshProtocol.REQUEST_STATE;
}

/** Payload: Apply All Actuators State. Sent to set all actuator states on a device. */
export interface SetStatePayload {
  p: LshProtocol.SET_STATE;
  /** An array of bitpacked bytes representing the desired ON/OFF state for each actuator. */
  s: number[];
}

/** Payload: Apply Single Actuator State. Sent to set a single actuator's state. */
export interface SetSingleActuatorPayload {
  p: LshProtocol.SET_SINGLE_ACTUATOR;
  /** The ID of the target actuator (e.g., '7'). */
  i: number;
  /** The desired state for the actuator. */
  s: 0 | 1;
}

/** Payload: Network Click Ack. Sent to acknowledge a valid network click request. */
export interface NetworkClickAckPayload {
  p: LshProtocol.NETWORK_CLICK_ACK;
  /** The type of click being acknowledged. */
  t: ClickType;
  /** The ID of the button whose click is being acknowledged. */
  i: number;
  /** Correlates request, ACK, failover and confirm across the same click lifecycle. */
  c: number;
}

/** Payload: Network Click Confirm. Sent by the device after receiving an ACK to confirm logic execution. */
export interface NetworkClickConfirmPayload {
  p: LshProtocol.NETWORK_CLICK_CONFIRM;
  /** The type of click being confirmed. */
  t: ClickType;
  /** The ID of the button whose click is being confirmed. */
  i: number;
  /** Correlates request, ACK, failover and confirm across the same click lifecycle. */
  c: number;
}
/** Payload: General Failover. Sent to indicate a system-level failure (e.g., config not loaded). */
export interface FailoverPayload {
  p: LshProtocol.FAILOVER;
}

/** Payload: Failover. Sent to indicate a click-specific action has failed (e.g., target offline). */
export interface FailoverClickPayload {
  p: LshProtocol.FAILOVER_CLICK;
  /** The type of click that failed. */
  t: ClickType;
  /** The ID of the button whose action failed. */
  i: number;
  /** Correlates request, ACK, failover and confirm across the same click lifecycle. */
  c: number;
}

/** Payload: Reboot. Sent to command the device to reboot. */
export interface RebootPayload {
  p: LshProtocol.REBOOT;
}

/** Payload: Reset. Sent to command the device to perform a factory reset. */
export interface ResetPayload {
  p: LshProtocol.RESET;
}

// --------------------------------------------------------------------------
// Configuration File Structure (`system-config.json`)
// These interfaces define the structure of the main configuration file.
// --------------------------------------------------------------------------

/** Configuration for a target actor within a button action. */
export interface Actor {
  /** The name of the target device. */
  name: string;
  /** If true, the action applies to all actuators on the target device. */
  allActuators: boolean;
  /** If `allActuators` is false, this specifies which actuator IDs to target. */
  actuators: number[];
}

/** Defines an action triggered by a button press. */
export interface ButtonAction {
  /** The ID of the button that triggers this action (e.g., '7'). */
  id: number;
  /** A list of primary LSH actors to control. */
  actors: Actor[];
  /** A list of secondary, external actors to control (e.g., Tasmota, Zigbee devices). */
  otherActors: string[];
}

export type HomeAssistantActuatorPlatform = "light" | "switch" | "fan";

export interface HomeAssistantNodeDiscoveryConfig {
  /** Optional Home Assistant entity platform override for this Homie node. */
  platform?: HomeAssistantActuatorPlatform;
  /** Optional friendly entity name override shown in Home Assistant. */
  name?: string;
  /** Optional Home Assistant default entity ID override. */
  defaultEntityId?: string;
  /** Optional Home Assistant icon override. */
  icon?: string;
}

export interface DeviceHomeAssistantDiscoveryConfig {
  /** Optional Home Assistant device name override. */
  deviceName?: string;
  /** Optional default platform for all actuator nodes of the device. */
  defaultPlatform?: HomeAssistantActuatorPlatform;
  /** Optional per-node discovery overrides keyed by the Homie node ID. */
  nodes?: Record<string, HomeAssistantNodeDiscoveryConfig>;
}

/** A single device's entry from the system configuration file. */
export interface DeviceEntry {
  name: string;
  longClickButtons?: ButtonAction[];
  superLongClickButtons?: ButtonAction[];
  haDiscovery?: DeviceHomeAssistantDiscoveryConfig;
}

/** The root structure of the `system-config.json` file. */
export interface SystemConfig {
  devices: DeviceEntry[];
}

// --------------------------------------------------------------------------
// Internal State Management
// These interfaces define the structure of the in-memory state.
// --------------------------------------------------------------------------

/** A map for O(1) lookup of an actuator's index by its ID. */
export interface ActuatorIndexMap {
  [actuatorId: number]: number;
}

/**
 * Represents the complete in-memory state for a single LSH device,
 * including its configuration, connection status, and actuator states.
 */
export interface DeviceState {
  /** The unique name of the device, used as the primary key. */
  name: string;
  /** The last known MQTT/bridge reachability state, proven by Homie `$state=ready` or live LSH traffic from the device. */
  connected: boolean;
  /** Overall LSH-level health status (`false` if unresponsive or never seen). Snapshot authoritativeness is tracked separately via `lastDetailsTime` and `lastStateTime`. */
  isHealthy: boolean;
  /** `true` if a ping was sent but not yet answered within the timeout. A temporary warning state. */
  isStale: boolean;
  /** Timestamp of the last message of any kind received from the device. */
  lastSeenTime: number;
  /** Last raw Homie `$state` observed for the device, independent of availability semantics. */
  lastHomieState: HomieLifecycleState | null;
  /** Timestamp of the last observed raw Homie `$state` message. */
  lastHomieStateTime: number;
  /** Timestamp of the last 'conf' message from the device. */
  lastDetailsTime: number;
  /** Timestamp of the last authoritative 'state' message from the device. `0` means the current topology has no confirmed state snapshot yet. */
  lastStateTime: number;
  /** An ordered array of actuator IDs (e.g., ['A1', 'A2']). */
  actuatorsIDs: number[];
  /** An array of button IDs, if any (e.g., ['B1', 'B2']). */
  buttonsIDs: number[];
  /** An ordered array of the current boolean states for each actuator. */
  actuatorStates: boolean[];
  /** A map for O(1) lookup of an actuator's index by its ID. Pre-computed for performance. */
  actuatorIndexes: ActuatorIndexMap;
  /** `true` if an alert for this device being offline has already been sent, to prevent alert spam. */
  alertSent: boolean;
}

/** The in-memory "database" of all known devices and their current states. */
export interface DeviceRegistry {
  [deviceName: string]: DeviceState;
}

/** Defines the data stored for a pending network click transaction. */
export interface PendingClickTransaction {
  /** Slot key that uniquely identifies the logical click source (device + button + type). */
  slotKey: string;
  /** The primary actors (LSH devices) targeted by the click. */
  actors: Actor[];
  /** The secondary actors (external devices) targeted by the click. */
  otherActors: string[];
  /** The timestamp when the transaction was started, used for expiration. */
  timestamp: number;
}

export interface MqttSubscribeMsg {
  topic: string | string[];
  action: "subscribe";
  qos: 0 | 1 | 2;
}

export interface MqttUnsubscribeMsg {
  topic: boolean | string | string[];
  action: "unsubscribe";
}

/**
 * Defines the structure of the message payload sent to the 'Alerts' output.
 */
export interface AlertPayload {
  /** The formatted, human-readable alert message. */
  message: string;
  /** The health status that triggered the alert. */
  status: "unhealthy" | "healthy";
  /** The list of devices involved in the alert. */
  devices: { name: string; reason: string }[];
  /** Optional raw details of the event that triggered the alert. */
  details?: unknown;
}
