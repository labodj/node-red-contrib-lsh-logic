/**
 * @file Shared runtime helpers for the Node-RED nodes in this package.
 *
 * Keep this module deliberately small and dependency-free. The helpers here are
 * the cross-node primitives that must behave identically in `lsh-logic`,
 * `lsh-actuator-sync` and `lsh-external-state`: context selection, Node-RED
 * status shapes, defensive config normalization and boolean state parsing.
 */

import type { Node, NodeAPI, NodeMessage } from "node-red";

/** Node-RED context stores supported by these nodes. */
export type ContextName = "flow" | "global";

/** Read-only view used when a node only needs to inspect context. */
export type ContextReader = {
  get(key: string): unknown;
};

/** Read/write view used by helpers that persist state into context. */
export type ContextStore = ContextReader & {
  set(key: string, value: unknown): void;
};

/** Compact status shape accepted by `node.status`. */
export type StatusShape = {
  fill: "red" | "green" | "yellow" | "blue" | "grey";
  shape: "dot" | "ring";
  text: string;
};

/** Node-RED 1.0+ input `send` callback shape used by synchronous helpers. */
export type SendFunction = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;

/** Node-RED 1.0+ input `done` callback shape used by synchronous helpers. */
export type DoneFunction = (err?: Error) => void;

/** Minimal shape required by `clearPendingTimers`. */
type PendingWithTimer = {
  timer?: ReturnType<typeof setTimeout>;
};

/** Conservative boolean text values shared by LSH command-facing helpers. */
export const BASIC_TRUE_TEXT_VALUES = ["1", "true", "on", "yes"] as const;

/** Conservative boolean text values shared by LSH command-facing helpers. */
export const BASIC_FALSE_TEXT_VALUES = ["0", "false", "off", "no"] as const;

const BASIC_TRUE_VALUE_SET: ReadonlySet<string> = new Set(BASIC_TRUE_TEXT_VALUES);
const BASIC_FALSE_VALUE_SET: ReadonlySet<string> = new Set(BASIC_FALSE_TEXT_VALUES);

/**
 * Normalizes a required string-like config value and rejects empty values early.
 */
export const normalizeRequiredString = (value: unknown, fieldName: string): string => {
  const normalized =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value).trim()
      : "";
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return normalized;
};

/**
 * Normalizes an optional string-like value; blank and unsupported values become undefined.
 */
export const normalizeOptionalString = (value: unknown): string | undefined => {
  const normalized =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value).trim()
      : "";
  return normalized.length > 0 ? normalized : undefined;
};

/**
 * Normalizes message identifiers where booleans would be accidental, not useful.
 */
export const normalizeMessageString = (value: unknown): string | undefined => {
  const normalized =
    typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return normalized.length > 0 ? normalized : undefined;
};

/**
 * Validates a context-store selector from the Node-RED editor.
 */
export const normalizeContextName = (value: unknown, fieldName: string): ContextName => {
  if (value === "flow" || value === "global") {
    return value;
  }
  throw new Error(`${fieldName} must be flow or global.`);
};

/**
 * Normalizes checkbox-like editor values while preserving explicit defaults.
 */
export const normalizeBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (BASIC_TRUE_VALUE_SET.has(normalized)) {
      return true;
    }
    if (BASIC_FALSE_VALUE_SET.has(normalized)) {
      return false;
    }
  }
  return Boolean(value);
};

/**
 * Normalizes a numeric editor field that cannot be negative.
 */
export const normalizeNonNegativeNumber = (
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

/**
 * Checks that an unknown value is a plain object record, not null or an array.
 */
export const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Normalizes a token before matching it against configured boolean text values.
 */
export const normalizeStateToken = (value: string, caseSensitive: boolean): string =>
  caseSensitive ? value.trim() : value.trim().toLowerCase();

/**
 * Parses comma/newline-separated text values into a normalized lookup set.
 */
export const parseBooleanTextSet = (
  value: unknown,
  defaultValues: readonly string[],
  caseSensitive: boolean,
): ReadonlySet<string> => {
  const rawValues = normalizeOptionalString(value)
    ?.split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const values = rawValues && rawValues.length > 0 ? rawValues : defaultValues;
  return new Set(values.map((entry) => normalizeStateToken(entry, caseSensitive)));
};

/**
 * Normalizes external/device state values to a boolean without guessing.
 */
export const normalizeBooleanState = (
  value: unknown,
  options: {
    trueValues: ReadonlySet<string>;
    falseValues: ReadonlySet<string>;
    caseSensitive?: boolean;
    invert?: boolean;
  },
): boolean | undefined => {
  let normalizedState: boolean | undefined;

  if (typeof value === "boolean") {
    normalizedState = value;
  } else if (typeof value === "number") {
    if (value === 1) {
      normalizedState = true;
    } else if (value === 0) {
      normalizedState = false;
    }
  } else if (typeof value === "string") {
    const token = normalizeStateToken(value, options.caseSensitive ?? false);
    if (options.trueValues.has(token)) {
      normalizedState = true;
    } else if (options.falseValues.has(token)) {
      normalizedState = false;
    }
  }

  return normalizedState === undefined
    ? undefined
    : options.invert === true
      ? !normalizedState
      : normalizedState;
};

/**
 * Human-readable on/off text used in statuses across helper nodes.
 */
export const formatState = (state: boolean): string => (state ? "on" : "off");

/**
 * Reads a Node-RED message property using the runtime utility implementation.
 */
export const readMessageProperty = (
  red: NodeAPI,
  msg: NodeMessage,
  propertyPath: string,
): unknown => red.util.getMessageProperty(msg, propertyPath);

/**
 * Selects a flow/global context store from a Node-RED node instance.
 */
export const getNodeContext = (node: Node, contextName: ContextName): ContextStore =>
  node.context()[contextName];

/**
 * Clears timer-backed pending work and empties the owning map.
 */
export const clearPendingTimers = <TValue extends PendingWithTimer>(
  pendingItems: Map<string, TValue>,
): void => {
  for (const pending of pendingItems.values()) {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
  }
  pendingItems.clear();
};

/**
 * Emits a Node-RED warning and status for intentionally skipped input.
 */
export const warnAndSetStatus = (node: Node, warning: string, status: StatusShape): null => {
  node.warn(warning);
  node.status(status);
  return null;
};
