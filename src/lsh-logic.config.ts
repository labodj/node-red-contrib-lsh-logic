/**
 * @file Node-RED editor configuration normalization.
 *
 * Static coordinator options are delegated to `labo-smart-home-coordinator` so
 * the wrapper cannot drift from the standalone CLI/library validation rules.
 * Node-RED-only fields stay here because they describe context exports and
 * editor storage rather than LSH runtime behavior.
 */

import { normalizeCoordinatorOptions } from "labo-smart-home-coordinator";
import type { SystemConfig } from "labo-smart-home-coordinator";

import type { LshLogicNodeDef } from "./types";

const normalizeRequiredString = (value: string, fieldName: string): string => {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return normalized;
};

const normalizeContextKey = (
  value: string,
  fieldName: string,
  contextName: "none" | "flow" | "global",
): string => {
  const normalized = String(value ?? "").trim();
  if (contextName !== "none" && normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty when its context export is enabled.`);
  }
  return normalized;
};

/**
 * Normalizes the Node-RED configuration object saved by the editor.
 */
export const normalizeNodeConfig = (config: LshLogicNodeDef): LshLogicNodeDef => {
  const coordinatorOptions = normalizeCoordinatorOptions({
    homieBasePath: config.homieBasePath,
    lshBasePath: config.lshBasePath,
    serviceTopic: config.serviceTopic,
    protocol: config.protocol,
    otherDevicesPrefix: config.otherDevicesPrefix,
    clickTimeout: config.clickTimeout,
    clickCleanupInterval: config.clickCleanupInterval,
    watchdogInterval: config.watchdogInterval,
    interrogateThreshold: config.interrogateThreshold,
    pingTimeout: config.pingTimeout,
    initialStateTimeout: config.initialStateTimeout,
  });

  return {
    ...config,
    ...coordinatorOptions,
    systemConfigJson: normalizeRequiredString(config.systemConfigJson, "System Config JSON"),
    exposeStateKey: normalizeContextKey(
      config.exposeStateKey,
      "State Context Key",
      config.exposeStateContext,
    ),
    exportTopicsKey: normalizeContextKey(
      config.exportTopicsKey,
      "Topic Context Key",
      config.exportTopics,
    ),
    exposeConfigKey: normalizeContextKey(
      config.exposeConfigKey,
      "Config Context Key",
      config.exposeConfigContext,
    ),
  };
};

/**
 * Parses the inline JSON edited in Node-RED.
 */
export const parseSystemConfigJson = (jsonText: string): SystemConfig => {
  try {
    return JSON.parse(jsonText) as SystemConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`System Config JSON is not valid JSON: ${message}`, { cause: error });
  }
};
