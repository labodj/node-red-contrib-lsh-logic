/**
 * @file Node-RED wrapper-specific type definitions.
 *
 * The LSH business logic lives in `labo-smart-home-coordinator`. This module
 * deliberately keeps only the editor/runtime settings that are unique to the
 * Node-RED node, so the wrapper stays small and does not duplicate protocol
 * contracts owned by the standalone package.
 */

import type { NodeDef } from "node-red";

/**
 * Node configuration as stored by the Node-RED editor.
 */
export interface LshLogicNodeDef extends NodeDef {
  /** Base path for Homie v5 lifecycle topics, for example `homie/5/`. */
  homieBasePath: string;
  /** Base path for LSH device topics, for example `LSH/`. */
  lshBasePath: string;
  /** Bridge service topic used for hop-local BOOT/PING commands. */
  serviceTopic: string;
  /** LSH payload protocol used on device command/state/event topics. */
  protocol: "json" | "msgpack";
  /** Prefix used when reading external actor states from Node-RED context. */
  otherDevicesPrefix: string;
  /** Inline coordinator system config JSON edited in the Node-RED dialog. */
  systemConfigJson: string;
  /** Where to expose the live device registry, or `none`. */
  exposeStateContext: "none" | "flow" | "global";
  /** Context key for the live device registry export. */
  exposeStateKey: string;
  /** Where to expose generated MQTT topic sets, or `none`. */
  exportTopics: "none" | "flow" | "global";
  /** Context key for generated MQTT topic exports. */
  exportTopicsKey: string;
  /** Where to expose the effective coordinator config, or `none`. */
  exposeConfigContext: "none" | "flow" | "global";
  /** Context key for the effective coordinator config export. */
  exposeConfigKey: string;
  /** Node-RED context store used to read non-LSH actor states. */
  otherActorsContext: "flow" | "global";
  /** Seconds to wait for a distributed click confirmation. */
  clickTimeout: number;
  /** Seconds between stale click transaction cleanup runs. */
  clickCleanupInterval: number;
  /** Seconds between watchdog cycles. */
  watchdogInterval: number;
  /** Seconds of silence before a device is actively pinged. */
  interrogateThreshold: number;
  /** Seconds to wait for a ping reply before marking the target stale. */
  pingTimeout: number;
  /** Seconds to wait after startup BOOT before active verification. */
  initialStateTimeout: number;
}

/**
 * Physical Node-RED output order. Keep this local to the wrapper; the
 * standalone coordinator only emits semantic events.
 */
export enum NodeOutput {
  /** MQTT commands for LSH devices and the bridge service topic. */
  LshCommands = 0,
  /** External actor intents for user flows. */
  OtherActorCommands = 1,
  /** Structured health alerts. */
  Alerts = 2,
  /** Dynamic subscription control messages for the upstream mqtt-in node. */
  Configuration = 3,
  /** Original input message passthrough after successful processing. */
  Debug = 4,
}
