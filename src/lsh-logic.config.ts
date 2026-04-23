import type { LshLogicNodeDef } from "./types";

type NumericConfigKey =
  | "clickTimeout"
  | "clickCleanupInterval"
  | "watchdogInterval"
  | "interrogateThreshold"
  | "pingTimeout"
  | "initialStateTimeout";

const MQTT_WILDCARD_PATTERN = /[+#]/;

const normalizeRequiredString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return normalized;
};

const validateConcreteTopic = (
  value: string,
  fieldName: string,
  { requireTrailingSlash }: { requireTrailingSlash: boolean },
): string => {
  const normalized = normalizeRequiredString(value, fieldName);

  if (MQTT_WILDCARD_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must not contain MQTT wildcards ('+' or '#').`);
  }

  if (requireTrailingSlash && !normalized.endsWith("/")) {
    throw new Error(`${fieldName} must end with '/'.`);
  }

  if (!requireTrailingSlash && normalized.endsWith("/")) {
    throw new Error(`${fieldName} must not end with '/'.`);
  }

  const topicBody = requireTrailingSlash ? normalized.slice(0, -1) : normalized;
  if (topicBody.length === 0) {
    throw new Error(`${fieldName} must contain at least one non-empty topic segment.`);
  }

  const segments = topicBody.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`${fieldName} must not contain empty MQTT topic segments.`);
  }

  return normalized;
};

const validateTopicBase = (value: string, fieldName: string): string => {
  return validateConcreteTopic(value, fieldName, { requireTrailingSlash: true });
};

const normalizePositiveNumber = (value: number, fieldName: string): number => {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return normalized;
};

/**
 * Normalizes and validates the static Node-RED editor config for the adapter.
 * This keeps all runtime-only logic out of the boundary validation concerns.
 */
export const normalizeNodeConfig = (config: LshLogicNodeDef): LshLogicNodeDef => {
  const normalizedConfig = {
    ...config,
    homieBasePath: validateTopicBase(config.homieBasePath, "Homie Base Path"),
    lshBasePath: validateTopicBase(config.lshBasePath, "LSH Base Path"),
    serviceTopic: validateConcreteTopic(config.serviceTopic, "Service Topic", {
      requireTrailingSlash: false,
    }),
    otherDevicesPrefix: normalizeRequiredString(config.otherDevicesPrefix, "External State Prefix"),
    systemConfigPath: normalizeRequiredString(config.systemConfigPath, "System Config"),
    exposeStateKey: config.exposeStateKey.trim(),
    exportTopicsKey: config.exportTopicsKey.trim(),
    exposeConfigKey: config.exposeConfigKey.trim(),
    haDiscoveryPrefix: config.haDiscovery
      ? validateConcreteTopic(config.haDiscoveryPrefix, "Discovery Prefix", {
          requireTrailingSlash: false,
        })
      : config.haDiscoveryPrefix.trim(),
  };

  const numericFields: Record<NumericConfigKey, string> = {
    clickTimeout: "Click Confirm Timeout",
    clickCleanupInterval: "Click Cleanup",
    watchdogInterval: "Watchdog Interval",
    interrogateThreshold: "Ping Threshold",
    pingTimeout: "Ping Timeout",
    initialStateTimeout: "Initial Replay Window",
  };

  for (const [key, label] of Object.entries(numericFields) as Array<[NumericConfigKey, string]>) {
    normalizedConfig[key] = normalizePositiveNumber(normalizedConfig[key], label);
  }

  return normalizedConfig;
};
