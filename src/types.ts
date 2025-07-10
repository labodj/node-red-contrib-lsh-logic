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
  otherDevicesPrefix: string;
  homieBasePath: string;
  lshBasePath: string;
  serviceTopic: string;

  // File Configuration
  longClickConfigPath: string;

  // Context Export Settings
  exposeStateContext: "none" | "flow" | "global";
  exposeStateKey: string;
  exportTopics: "none" | "flow" | "global";
  exportTopicsKey: string;
  exposeConfigContext: "none" | "flow" | "global";
  exposeConfigKey: string;

  // External State Settings
  otherActorsContext: "flow" | "global";

  // Timing Settings
  clickTimeout: number;
  watchdogInterval: number;
  interrogateThreshold: number;
  pingTimeout: number;
  clickCleanupInterval: number;
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
 * Defines a set of constant strings for LSH protocol identifiers.
 */
export const LshProtocol = {
  NETWORK_CLICK: "c_nc",
  NETWORK_CLICK_ACK: "d_nca",
  CLICK_FAILOVER: "c_f",
  GENERAL_FAILOVER: "c_gf",
  APPLY_ALL_ACTUATORS_STATE: "c_aas",
  APPLY_SINGLE_ACTUATOR_STATE: "c_asas",
  DEVICE_BOOT: "d_b",
  PING: "d_p",
} as const;

/** Payload from an LSH device's 'conf' topic. */
export interface DeviceConfPayload {
  ai: string[];
  bi: string[];
  dn: string;
}

/** Payload from an LSH device's 'state' topic. */
export interface DeviceStatePayload {
  as: boolean[];
}

/** Payload for a Network Click ('c_nc'). */
export interface NetworkClickPayload {
  p: typeof LshProtocol.NETWORK_CLICK;
  bi: string;
  ct: "lc" | "slc";
  c: boolean;
}

/** Payload for a Device Boot ('d_b'). */
export interface DeviceBootPayload {
  p: typeof LshProtocol.DEVICE_BOOT;
}

/** Payload for a Ping ('d_p'). */
export interface PingPayload {
  p: typeof LshProtocol.PING;
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
  name: string;
  allActuators: boolean;
  actuators: string[];
}

/** Defines an action triggered by a button press. */
export interface ButtonAction {
  id: string;
  actors: Actor[];
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
  name: string;
  connected: boolean;
  isHealthy: boolean;
  isStale: boolean;
  lastSeenTime: number;
  lastBootTime: number;
  lastDetailsTime: number;
  actuatorsIDs: string[];
  buttonsIDs: string[] | undefined;
  actuatorStates: boolean[];
  actuatorIndexes: ActuatorIndexMap;
}

/** In-memory database of all known devices and their current states. */
export interface DeviceRegistry {
  [deviceName: string]: DeviceState;
}

/** Defines the data stored for a pending network click transaction. */
export interface PendingClickTransaction {
  actors: Actor[];
  otherActors: string[];
  timestamp: number;
}

/** A registry for all ongoing click transactions, keyed by a unique identifier. */
export interface ClickTransactionRegistry {
  [transactionKey: string]: PendingClickTransaction;
}
