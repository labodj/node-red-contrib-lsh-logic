import type {
  DeviceHomeAssistantDiscoveryConfig,
  HomeAssistantActuatorPlatform,
  HomeAssistantNodeDiscoveryConfig,
} from "./types";

export type DiscoveryPlatform =
  | HomeAssistantActuatorPlatform
  | "sensor"
  | "binary_sensor"
  | "number"
  | "select"
  | "text";
export type ToggleDiscoveryPlatform = HomeAssistantActuatorPlatform;

export interface NormalizedNodeDiscoveryConfig {
  platform?: ToggleDiscoveryPlatform;
  name?: string;
  defaultEntityId?: string;
  icon?: string;
}

export interface NormalizedDeviceDiscoveryConfig {
  deviceName?: string;
  defaultPlatform?: ToggleDiscoveryPlatform;
  nodes: Readonly<Record<string, NormalizedNodeDiscoveryConfig>>;
}

export interface DiscoveryNodeRuntimeMetadata {
  displayName?: string;
  nodeType?: string;
  stateDatatype?: string;
  stateFormat?: string;
  stateRetained?: boolean;
  stateSettable?: boolean;
  stateUnit?: string;
}

export type ParsedHomieV5Description = {
  deviceName?: string;
  deviceType?: string;
  version?: number;
  children?: string[];
  extensions?: string[];
  parent?: string;
  root?: string;
  nodes: string[];
  nodeMetadata: Record<string, DiscoveryNodeRuntimeMetadata>;
};

export type HomieV5DescriptionParseResult =
  | { ok: true; description: ParsedHomieV5Description; warnings: string[] }
  | { ok: false; warnings: string[] };

const HOMIE_V5_CONVENTION_VERSION = "5.0";
const HOMIE_V5_ID_PATTERN = /^[a-z0-9-]+$/;
const VALID_DISCOVERY_OVERRIDE_NODE_ID_PATTERN = HOMIE_V5_ID_PATTERN;
const HOMIE_V5_DATATYPES = new Set([
  "integer",
  "float",
  "boolean",
  "string",
  "enum",
  "color",
  "datetime",
  "duration",
  "json",
]);

export const normalizeOptionalString = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const normalizeNodeDiscoveryConfig = (
  config: HomeAssistantNodeDiscoveryConfig,
): NormalizedNodeDiscoveryConfig => ({
  platform: config.platform,
  name: normalizeOptionalString(config.name),
  defaultEntityId: normalizeOptionalString(config.defaultEntityId),
  icon: normalizeOptionalString(config.icon),
});

const assertCaseInsensitiveUniqueNodeIds = (
  nodes: Record<string, HomeAssistantNodeDiscoveryConfig> | undefined,
): void => {
  if (!nodes) {
    return;
  }

  const seenNodeIds = new Map<string, string>();
  for (const nodeId of Object.keys(nodes)) {
    const normalizedNodeId = nodeId.toLowerCase();
    const previousNodeId = seenNodeIds.get(normalizedNodeId);
    if (previousNodeId) {
      throw new Error(
        `Home Assistant discovery override keys '${previousNodeId}' and '${nodeId}' collide after case-insensitive normalization.`,
      );
    }
    seenNodeIds.set(normalizedNodeId, nodeId);
  }
};

const assertValidDiscoveryNodeIds = (
  nodes: Record<string, HomeAssistantNodeDiscoveryConfig> | undefined,
): void => {
  if (!nodes) {
    return;
  }

  for (const nodeId of Object.keys(nodes)) {
    if (!VALID_DISCOVERY_OVERRIDE_NODE_ID_PATTERN.test(nodeId)) {
      throw new Error(
        `Home Assistant discovery override key '${nodeId}' is not a valid Homie v5 node id.`,
      );
    }
  }
};

export const normalizeDeviceDiscoveryConfig = (
  config: DeviceHomeAssistantDiscoveryConfig | undefined,
): NormalizedDeviceDiscoveryConfig | undefined => {
  if (!config) {
    return undefined;
  }

  assertValidDiscoveryNodeIds(config.nodes);
  assertCaseInsensitiveUniqueNodeIds(config.nodes);

  const normalizedNodeEntries = Object.entries(config.nodes ?? {})
    .map(([nodeId, nodeConfig]): [string, NormalizedNodeDiscoveryConfig] => [
      nodeId.toLowerCase(),
      normalizeNodeDiscoveryConfig(nodeConfig),
    ])
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    deviceName: normalizeOptionalString(config.deviceName),
    defaultPlatform: config.defaultPlatform,
    nodes: Object.fromEntries(normalizedNodeEntries),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parses the Homie v5 `$description` document into the small discovery model
 * needed by Home Assistant. Homie v5 intentionally makes discovery atomic:
 * the retained JSON document carries the device name, nodes and property
 * metadata, so the runtime manager no longer waits for scattered `$nodes` and
 * `state/$datatype` attributes to arrive in a specific order.
 */
export function parseHomieV5Description(
  deviceId: string,
  payload: string,
): HomieV5DescriptionParseResult {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payload);
  } catch {
    return {
      ok: false,
      warnings: [`Ignored Homie v5 $description for '${deviceId}' because it is not valid JSON.`],
    };
  }

  if (!isRecord(parsedPayload)) {
    return {
      ok: false,
      warnings: [
        `Ignored Homie v5 $description for '${deviceId}' because the payload is not a JSON object.`,
      ],
    };
  }

  if (parsedPayload.homie !== HOMIE_V5_CONVENTION_VERSION) {
    return {
      ok: false,
      warnings: [
        `Ignored Homie $description for '${deviceId}' because homie='${String(
          parsedPayload.homie,
        )}' is not supported; expected '${HOMIE_V5_CONVENTION_VERSION}'.`,
      ],
    };
  }

  if (!isRecord(parsedPayload.nodes)) {
    return {
      ok: false,
      warnings: [
        `Ignored Homie v5 $description for '${deviceId}' because nodes is missing or not an object.`,
      ],
    };
  }

  const warnings: string[] = [];
  const nodeEntries: Array<[string, DiscoveryNodeRuntimeMetadata]> = [];
  const version =
    typeof parsedPayload.version === "number" && Number.isInteger(parsedPayload.version)
      ? parsedPayload.version
      : undefined;
  if (version === undefined) {
    warnings.push(
      `Accepted Homie v5 $description for '${deviceId}' without a valid integer version.`,
    );
  }

  for (const [nodeId, rawNode] of Object.entries(parsedPayload.nodes)) {
    if (!HOMIE_V5_ID_PATTERN.test(nodeId)) {
      warnings.push(
        `Ignored Homie v5 node '${deviceId}/${nodeId}' because the node id is not lower-case Homie v5 syntax.`,
      );
      continue;
    }

    if (!isRecord(rawNode) || !isRecord(rawNode.properties)) {
      continue;
    }

    const stateProperty = rawNode.properties.state;
    if (!isRecord(stateProperty)) {
      continue;
    }

    const datatype = normalizeDiscoveryStateDatatype(stateProperty.datatype);
    if (datatype === null) {
      warnings.push(
        `Ignored Homie v5 node '${deviceId}/${nodeId}' because its state property has no valid datatype.`,
      );
      continue;
    }

    const metadata: DiscoveryNodeRuntimeMetadata = {
      stateDatatype: datatype,
    };
    const nodeName = normalizeUnknownString(rawNode.name);
    const stateName = normalizeUnknownString(stateProperty.name);
    metadata.displayName = nodeName ?? stateName;
    metadata.nodeType = normalizeUnknownString(rawNode.type);
    metadata.stateFormat = normalizeUnknownString(stateProperty.format);
    metadata.stateUnit = normalizeUnknownString(stateProperty.unit);

    if (stateProperty.settable !== undefined) {
      if (typeof stateProperty.settable === "boolean") {
        metadata.stateSettable = stateProperty.settable;
      } else {
        warnings.push(
          `Treated Homie v5 node '${deviceId}/${nodeId}' as read-only because state.settable is not boolean.`,
        );
      }
    }
    if (stateProperty.retained === undefined) {
      metadata.stateRetained = true;
    } else if (typeof stateProperty.retained === "boolean") {
      metadata.stateRetained = stateProperty.retained;
    } else {
      metadata.stateRetained = true;
      warnings.push(
        `Treated Homie v5 node '${deviceId}/${nodeId}' as retained because state.retained is not boolean.`,
      );
    }

    nodeEntries.push([nodeId, metadata]);
  }

  if (nodeEntries.length === 0) {
    return {
      ok: false,
      warnings: [
        ...warnings,
        `Ignored Homie v5 $description for '${deviceId}' because it contains no valid state properties.`,
      ],
    };
  }

  nodeEntries.sort(([left], [right]) => left.localeCompare(right));

  return {
    ok: true,
    description: {
      deviceName: normalizeUnknownString(parsedPayload.name),
      deviceType: normalizeUnknownString(parsedPayload.type),
      version,
      children: normalizeStringArray(parsedPayload.children),
      extensions: normalizeStringArray(parsedPayload.extensions),
      parent: normalizeUnknownString(parsedPayload.parent),
      root: normalizeUnknownString(parsedPayload.root),
      nodes: nodeEntries.map(([nodeId]) => nodeId),
      nodeMetadata: Object.fromEntries(nodeEntries),
    },
    warnings,
  };
}

export function normalizeUnknownString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry) => normalizeUnknownString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeDiscoveryStateDatatype(payload: unknown): string | null {
  if (typeof payload !== "string") {
    return null;
  }

  const normalized = payload.trim().toLowerCase();
  return HOMIE_V5_DATATYPES.has(normalized) ? normalized : null;
}

/**
 * Resolves the Home Assistant entity shape for a Homie node.
 * Only boolean nodes whose Homie v5 `state` property is explicitly settable are exposed
 * as writable toggle entities. Read-only booleans become binary sensors and all
 * other nodes fall back to plain sensors.
 */
export function resolveNodeDiscoveryShape(
  nodeId: string,
  metadata: DiscoveryNodeRuntimeMetadata | undefined,
  discoveryConfig: NormalizedDeviceDiscoveryConfig | undefined,
): {
  platform: DiscoveryPlatform;
  commandable: boolean;
  nodeConfig: NormalizedNodeDiscoveryConfig | undefined;
} {
  const nodeConfig = discoveryConfig?.nodes[nodeId.toLowerCase()];

  if (metadata?.stateDatatype === "boolean") {
    if (metadata.stateSettable === true) {
      return {
        platform: nodeConfig?.platform ?? discoveryConfig?.defaultPlatform ?? "light",
        commandable: true,
        nodeConfig,
      };
    }

    return { platform: "binary_sensor", commandable: false, nodeConfig };
  }

  if (metadata?.stateSettable === true) {
    if (metadata.stateDatatype === "enum" && metadata.stateFormat) {
      return { platform: "select", commandable: true, nodeConfig };
    }

    if (metadata.stateDatatype === "integer" || metadata.stateDatatype === "float") {
      return { platform: "number", commandable: true, nodeConfig };
    }

    if (metadata.stateDatatype === "string") {
      return { platform: "text", commandable: true, nodeConfig };
    }
  }

  return { platform: "sensor", commandable: false, nodeConfig };
}
