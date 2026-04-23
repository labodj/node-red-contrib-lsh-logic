import type {
  DeviceHomeAssistantDiscoveryConfig,
  HomeAssistantActuatorPlatform,
  HomeAssistantNodeDiscoveryConfig,
} from "./types";

export type DiscoveryPlatform = HomeAssistantActuatorPlatform | "sensor" | "binary_sensor";
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
  stateDatatype?: string;
  stateSettable?: boolean;
}

export type ParsedDiscoveryStateMetadataTopic = {
  nodeId: string;
  field: "stateDatatype" | "stateSettable";
};

const DISCOVERY_STATE_METADATA_TOPIC_REGEX = /^\/([^/]+)\/state\/\$(datatype|settable)$/;
const VALID_DISCOVERY_OVERRIDE_NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
        `Home Assistant discovery override key '${nodeId}' is not a valid Homie node id.`,
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

/**
 * Parses Homie metadata topics for the canonical `state` property of a node.
 * The discovery manager only needs enough metadata to decide whether a node is
 * writable and whether its `state` payload is boolean-like.
 */
export function parseDiscoveryStateMetadataTopic(
  topicSuffix: string,
): ParsedDiscoveryStateMetadataTopic | null {
  const match = topicSuffix.match(DISCOVERY_STATE_METADATA_TOPIC_REGEX);
  if (!match) {
    return null;
  }

  return {
    nodeId: match[1],
    field: match[2] === "datatype" ? "stateDatatype" : "stateSettable",
  };
}

export function normalizeDiscoveryStateDatatype(payload: string): string | null {
  const normalized = payload.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function parseDiscoveryStateSettable(payload: string): boolean | null {
  const normalized = payload.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return null;
}

/**
 * Resolves the Home Assistant entity shape for a Homie node.
 * Only boolean nodes that explicitly report `state/$settable=true` are exposed
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

  return { platform: "sensor", commandable: false, nodeConfig };
}
