/**
 * @file Contains all shared type and interface definitions for the LSH Logic project.
 * This file serves as the single source of truth for data structures,
 * ensuring consistency across different modules. Centralizing type definitions
 * leverages TypeScript's static analysis to prevent common bugs.
 */

import { NodeDef, NodeMessage } from "node-red";

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
  [key in Output]?: NodeMessage | NodeMessage[];
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
}

// --------------------------------------------------------------------------
// LSH Protocol and Payloads
// --------------------------------------------------------------------------

/**
 * Defines the types of network clicks for improved type safety and readability.
 */
export enum ClickType {
  Long = "lc",
  SuperLong = "slc",
}

/**
 * Defines a type-safe enum for LSH protocol identifiers.
 * Using a string enum prevents typos and makes the code more understandable
 * compared to using raw strings like "d_dd" throughout the application.
 */
export enum LshProtocol {
  // Client -> Node (ESP -> Controllino)
  /** (d_dd) Client -> Node: Reports device details like name, actuators, and buttons. */
  DEVICE_DETAILS = "d_dd",
  /** (d_as) Client -> Node: Reports the current state of all actuators. */
  DEVICE_ACTUATORS_STATE = "d_as",
  /** (c_nc) Client -> Node: Network Click request or confirmation. */
  NETWORK_CLICK = "c_nc",
  /** (d_b) Client -> Node: Notification that the device has booted up. */
  DEVICE_BOOT = "d_b",

  // Node -> Client (Controllino -> ESP)
  /** (c_sdd) Node -> Client: Request for the device to send its details. */
  SEND_DEVICE_DETAILS = "c_sdd",
  /** (c_sas) Node -> Client: Request for the device to send its actuator states. */
  SEND_ACTUATORS_STATE = "c_sas",
  /** (c_aas) Node -> Client: Command to set the state of all actuators on a device. */
  APPLY_ALL_ACTUATORS_STATE = "c_aas",
  /** (c_asas) Node -> Client: Command to set the state of a single, specific actuator. */
  APPLY_SINGLE_ACTUATOR_STATE = "c_asas",
  /** (d_nca) Node -> Client: Acknowledgment of a valid Network Click request. */
  NETWORK_CLICK_ACK = "d_nca",
  /** (c_f) Node -> Client: Failover signal for a specific click action that cannot be performed. */
  FAILOVER = "c_f",
  /** (c_gf) Node -> Client: Failover signal for a system-level issue (e.g., config not loaded). */
  GENERAL_FAILOVER = "c_gf",
  /** (rbt) Node -> Client: Command to reboot the ESP device. */
  REBOOT = "rbt",
  /** (rst) Node -> Client: Command to reset the ESP device. */
  RESET = "rst",

  // Bidirectional
  /** (d_p) Node <-> Client: Ping/pong message for health checks. */
  PING = "d_p",
}

// --------------------------------------------------------------------------
// Client -> Node Payloads (ESP -> Controllino)
// These interfaces define the expected structure of messages received from devices.
// --------------------------------------------------------------------------

/** Payload: Data_Device Details (`d_dd`). Sent by a device to report its static configuration via the 'conf' topic. */
export interface DeviceDetailsPayload {
  p: LshProtocol.DEVICE_DETAILS;
  /** The display name of the device (e.g., 'c1'). */
  dn: string;
  /** An array of actuator IDs (e.g., ['A1', 'A2']). */
  ai: string[];
  /** An array of button IDs (e.g., ['B1']). */
  bi: string[];
}

/** Payload: Data_Actuators State (`d_as`). Sent by a device to report the live state of its actuators via the 'state' topic. */
export interface DeviceActuatorsStatePayload {
  p: LshProtocol.DEVICE_ACTUATORS_STATE;
  /** An array representing the ON/OFF state of each actuator. */
  as: boolean[];
}

/** Payload: Command_Network Click (`c_nc`). Sent by a device when a button is long-pressed, via the 'misc' topic. */
export interface NetworkClickPayload {
  p: LshProtocol.NETWORK_CLICK;
  /** The type of click, e.g., long-click or super-long-click. */
  ct: ClickType;
  /** The ID of the button that was pressed (e.g., 'B1'). */
  bi: string;
  /** The phase of the transaction: `false` for the initial request, `true` for the final confirmation. */
  c: boolean;
}

/** Payload: Data_Boot (`d_b`). Sent by a device upon startup, via the 'misc' topic. */
export interface DeviceBootPayload {
  p: LshProtocol.DEVICE_BOOT;
}

/** Payload: Data_Ping (`d_p`). A ping or pong message for health checks, sent via the 'misc' topic. */
export interface PingPayload {
  p: LshProtocol.PING;
}

/**
 * A discriminated union of all possible payloads received on a device's 'misc' topic.
 * This powerful TypeScript pattern allows the type of the payload to be inferred
 * based on the value of the 'p' property.
 */
export type AnyMiscTopicPayload =
  | NetworkClickPayload
  | DeviceBootPayload
  | PingPayload;

// --------------------------------------------------------------------------
// Node -> Client Payloads (Controllino -> ESP)
// These interfaces define the structure of command messages sent to devices.
// --------------------------------------------------------------------------

/** Payload: Command_Send Device Details (`c_sdd`). Sent to request a device's configuration. */
export interface SendDeviceDetailsPayload {
  p: LshProtocol.SEND_DEVICE_DETAILS;
}

/** Payload: Command_Send Actuators State (`c_sas`). Sent to request a device's current actuator states. */
export interface SendActuatorsStatePayload {
  p: LshProtocol.SEND_ACTUATORS_STATE;
}

/** Payload: Command_Apply All Actuators State (`c_aas`). Sent to set all actuator states on a device. */
export interface ApplyAllActuatorsStatePayload {
  p: LshProtocol.APPLY_ALL_ACTUATORS_STATE;
  /** An array representing the desired ON/OFF state for each actuator. */
  as: boolean[];
}

/** Payload: Command_Apply Single Actuator State (`c_asas`). Sent to set a single actuator's state. */
export interface ApplySingleActuatorStatePayload {
  p: LshProtocol.APPLY_SINGLE_ACTUATOR_STATE;
  /** The ID of the target actuator (e.g., 'A1'). */
  ai: string;
  /** The desired state for the actuator. */
  as: boolean;
}

/** Payload: Data_Network Click Ack (`d_nca`). Sent to acknowledge a valid network click request. */
export interface NetworkClickAckPayload {
  p: LshProtocol.NETWORK_CLICK_ACK;
  /** The type of click being acknowledged. */
  ct: ClickType;
  /** The ID of the button whose click is being acknowledged. */
  bi: string;
}
/** Payload: Command_General Failover (`c_gf`). Sent to indicate a system-level failure (e.g., config not loaded). */
export interface GeneralFailoverPayload {
  p: LshProtocol.GENERAL_FAILOVER;
}

/** Payload: Command_Failover (`c_f`). Sent to indicate a click-specific action has failed (e.g., target offline). */
export interface FailoverPayload {
  p: LshProtocol.FAILOVER;
  /** The type of click that failed. */
  ct: ClickType;
  /** The ID of the button whose action failed. */
  bi: string;
}

/** Payload: Reboot (`rbt`). Sent to command the device to reboot. */
export interface RebootPayload {
  p: LshProtocol.REBOOT;
}

/** Payload: Reset (`rst`). Sent to command the device to perform a factory reset. */
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
  actuators: string[];
}

/** Defines an action triggered by a button press. */
export interface ButtonAction {
  /** The ID of the button that triggers this action (e.g., 'B1'). */
  id: string;
  /** A list of primary LSH actors to control. */
  actors: Actor[];
  /** A list of secondary, external actors to control (e.g., Tasmota, Zigbee devices). */
  otherActors: string[];
}

/** A single device's entry from the system configuration file. */
export interface DeviceEntry {
  name: string;
  longClickButtons?: ButtonAction[];
  superLongClickButtons?: ButtonAction[];
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
  [actuatorId: string]: number;
}

/**
 * Represents the complete in-memory state for a single LSH device,
 * including its configuration, connection status, and actuator states.
 */
export interface DeviceState {
  /** The unique name of the device, used as the primary key. */
  name: string;
  /** The Homie connection state (`true` if $state is 'ready'). Managed by Homie messages. */
  connected: boolean;
  /** Overall LSH-level health status (`false` if unresponsive or never seen). Managed by ping/pong and other LSH messages. */
  isHealthy: boolean;
  /** `true` if a ping was sent but not yet answered within the timeout. A temporary warning state. */
  isStale: boolean;
  /** Timestamp of the last message of any kind received from the device. */
  lastSeenTime: number;
  /** Timestamp of the last boot event ('d_b') from the device. */
  lastBootTime: number;
  /** Timestamp of the last 'conf' message from the device. */
  lastDetailsTime: number;
  /** An ordered array of actuator IDs (e.g., ['A1', 'A2']). */
  actuatorsIDs: string[];
  /** An array of button IDs, if any (e.g., ['B1', 'B2']). */
  buttonsIDs: string[];
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
  /** The primary actors (LSH devices) targeted by the click. */
  actors: Actor[];
  /** The secondary actors (external devices) targeted by the click. */
  otherActors: string[];
  /** The timestamp when the transaction was started, used for expiration. */
  timestamp: number;
}

/** A registry for all ongoing click transactions, keyed by a unique identifier. */
export interface ClickTransactionRegistry {
  [transactionKey: string]: PendingClickTransaction;
}