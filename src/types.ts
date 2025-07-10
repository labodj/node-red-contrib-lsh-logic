/**
 * @file Contains all shared type and interface definitions for the LSH Logic project.
 * This file serves as the single source of truth for data structures,
 * ensuring consistency across different modules.
 */

import { NodeDef, NodeMessage } from "node-red";

// --------------------------------------------------------------------------
// Node Configuration and Core Types
// --------------------------------------------------------------------------

/**
 * Defines the configuration options for the LSH Logic node, set by the user in the Node-RED editor.
 */
export interface LshLogicNodeDef extends NodeDef {
  // MQTT & Context Prefixes
  /** Base path for Homie device state topics (e.g., 'homie/'). */
  homieBasePath: string;
  /** Base path for LSH device command and state topics (e.g., 'LSH/'). */
  lshBasePath: string;
  /** Broadcast topic for global commands like a system-wide ping. */
  serviceTopic: string;
  /** Prefix for context keys when reading external device states. */
  otherDevicesPrefix: string;

  // File Configuration
  /** Path to the main JSON config, relative to the Node-RED user directory. */
  longClickConfigPath: string;

  // Context Export Settings
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

  // External State Settings
  /** The context (flow or global) from which to read the state of external actors. */
  otherActorsContext: "flow" | "global";

  // Timing Settings
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
}

/**
 * Provides a type-safe mapping of the node's output ports to their corresponding index.
 */
export enum Output {
  Lsh = 0,
  OtherActors = 1,
  Alerts = 2,
  Debug = 3,
}

/**
 * Defines the structure for the object passed to the `send` method,
 * allowing messages to be targeted to specific outputs.
 */
export type OutputMessages = {
  [key in Output]?: NodeMessage;
};

// --------------------------------------------------------------------------
// LSH Protocol and Payloads
// --------------------------------------------------------------------------

/**
 * Defines a type-safe enum for LSH protocol identifiers.
 * Using a string enum provides both the value at runtime and a type at compile time.
 */
export enum LshProtocol {
  /** Client -> Node: Network Click request or confirmation. */
  NETWORK_CLICK = "c_nc",
  /** Node -> Client: Acknowledgment of a valid Network Click request. */
  NETWORK_CLICK_ACK = "d_nca",
  /** Node -> Client: Failover signal for a specific click action that cannot be performed. */
  CLICK_FAILOVER = "c_f",
  /** Node -> Client: Failover signal for a system-level issue (e.g., config not loaded). */
  GENERAL_FAILOVER = "c_gf",
  /** Node -> Client: Command to set the state of all actuators on a device. */
  APPLY_ALL_ACTUATORS_STATE = "c_aas",
  /** Node -> Client: Command to set the state of a single, specific actuator. */
  APPLY_SINGLE_ACTUATOR_STATE = "c_asas",
  /** Client -> Node: Notification that the device has booted up. */
  DEVICE_BOOT = "d_b",
  /** Node <-> Client: Ping/pong message for health checks. */
  PING = "d_p",
}

/** Payload from an LSH device's 'conf' topic. */
export interface DeviceConfPayload {
  /** An array of actuator IDs (e.g., ['A1', 'A2']). */
  ai: string[];
  /** An array of button IDs (e.g., ['B1']). */
  bi: string[];
  /** The display name of the device. */
  dn: string;
}

/** Payload from an LSH device's 'state' topic. */
export interface DeviceStatePayload {
  /** An array representing the ON/OFF state of each actuator. */
  as: boolean[];
}

/** Payload for a Network Click ('c_nc'). */
export interface NetworkClickPayload {
  /** The protocol identifier, must be 'c_nc'. */
  p: LshProtocol.NETWORK_CLICK; // Using the enum member directly for type safety
  /** The ID of the button that was pressed (e.g., 'B1'). */
  bi: string;
  /** The type of click: 'lc' for long-click, 'slc' for super-long-click. */
  ct: "lc" | "slc";
  /** The phase of the transaction: `false` for the initial request, `true` for the final confirmation. */
  c: boolean;
}
/** Payload for a Device Boot ('d_b'). */
export interface DeviceBootPayload {
  p: LshProtocol.DEVICE_BOOT;
}

/** Payload for a Ping ('d_p'). */
export interface PingPayload {
  p: LshProtocol.PING;
}

/**
 * A discriminated union of all possible 'misc' topic payloads.
 */
export type AnyDeviceMiscPayload =
  | NetworkClickPayload
  | DeviceBootPayload
  | PingPayload;

// --------------------------------------------------------------------------
// Configuration File Structure (`longClickConfig.json`)
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
  /** A list of secondary, external actors to control. */
  otherActors: string[];
}

/** A single device's entry from the long-click configuration file. */
export interface DeviceConfigEntry {
  name: string;
  longClickButtons: ButtonAction[];
  superLongClickButtons: ButtonAction[];
}

/** The root structure of the `longClickConfig.json` file. */
export interface LongClickConfig {
  devices: DeviceConfigEntry[];
}

// --------------------------------------------------------------------------
// Internal State Management
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
  /** The Homie connection state (`true` if $state is 'ready'). */
  connected: boolean;
  /** Overall health status (`false` if unresponsive or never seen). */
  isHealthy: boolean;
  /** `true` if a ping was sent but not yet answered within the timeout. */
  isStale: boolean;
  /** Timestamp of the last message received from the device. */
  lastSeenTime: number;
  /** Timestamp of the last boot event ('d_b') from the device. */
  lastBootTime: number;
  /** Timestamp of the last 'conf' message from the device. */
  lastDetailsTime: number;
  /** An ordered array of actuator IDs (e.g., ['A1', 'A2']). */
  actuatorsIDs: string[];
  /** An array of button IDs, if any (e.g., ['B1', 'B2']). */
  buttonsIDs: string[] | undefined;
  /** An ordered array of the current states for each actuator. */
  actuatorStates: boolean[];
  /** A map for O(1) lookup of an actuator's index by its ID. */
  actuatorIndexes: ActuatorIndexMap;
}

/** In-memory database of all known devices and their current states. */
export interface DeviceRegistry {
  [deviceName: string]: DeviceState;
}

/** Defines the data stored for a pending network click transaction. */
export interface PendingClickTransaction {
  /** The primary actors (LSH devices) targeted by the click. */
  actors: Actor[];
  /** The secondary actors (external devices) targeted by the click. */
  otherActors: string[];
  /** The timestamp when the transaction was started. */
  timestamp: number;
}

/** A registry for all ongoing click transactions, keyed by a unique identifier. */
export interface ClickTransactionRegistry {
  [transactionKey: string]: PendingClickTransaction;
}
