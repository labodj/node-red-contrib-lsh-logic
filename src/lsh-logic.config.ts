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

type OptionalContextName = LshLogicNodeDef["exposeStateContext"];
type RequiredContextName = LshLogicNodeDef["otherActorsContext"];

const normalizeRequiredString = (value: string, fieldName: string): string => {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return normalized;
};

const normalizeOptionalContextName = (value: unknown, fieldName: string): OptionalContextName => {
  if (value === "none" || value === "flow" || value === "global") {
    return value;
  }
  throw new Error(`${fieldName} must be none, flow or global.`);
};

const normalizeRequiredContextName = (value: unknown, fieldName: string): RequiredContextName => {
  if (value === "flow" || value === "global") {
    return value;
  }
  throw new Error(`${fieldName} must be flow or global.`);
};

const normalizeContextKey = (
  value: string,
  fieldName: string,
  contextName: OptionalContextName,
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
  const exposeStateContext = normalizeOptionalContextName(
    config.exposeStateContext,
    "State Context",
  );
  const exportTopics = normalizeOptionalContextName(config.exportTopics, "Topic Export Context");
  const exposeConfigContext = normalizeOptionalContextName(
    config.exposeConfigContext,
    "Config Context",
  );
  const otherActorsContext = normalizeRequiredContextName(
    config.otherActorsContext,
    "Other Actors Context",
  );

  return {
    ...config,
    ...coordinatorOptions,
    exposeStateContext,
    exportTopics,
    exposeConfigContext,
    otherActorsContext,
    systemConfigJson: normalizeRequiredString(config.systemConfigJson, "System Config JSON"),
    exposeStateKey: normalizeContextKey(
      config.exposeStateKey,
      "State Context Key",
      exposeStateContext,
    ),
    exportTopicsKey: normalizeContextKey(config.exportTopicsKey, "Topic Context Key", exportTopics),
    exposeConfigKey: normalizeContextKey(
      config.exposeConfigKey,
      "Config Context Key",
      exposeConfigContext,
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
