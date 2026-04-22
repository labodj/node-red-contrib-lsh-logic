import type { NodeMessage } from "node-red";

import { Output } from "./types";
import { appendLshMessages, createEmptyServiceResult } from "./LshLogicService.helpers";
import { PACKAGE_VERSION } from "./version";
import type {
  DeviceEntry,
  DeviceHomeAssistantDiscoveryConfig,
  HomeAssistantNodeDiscoveryConfig,
  HomeAssistantActuatorPlatform,
  ServiceResult,
} from "./types";

type DiscoveryCategory = "diagnostic";
type DiscoveryPlatform = HomeAssistantActuatorPlatform | "sensor" | "binary_sensor";
type ToggleDiscoveryPlatform = HomeAssistantActuatorPlatform;
type AvailabilityPayload = "ready" | "lost";
type BooleanLiteral = "true" | "false";

interface DeviceDiscoveryDefinition {
  name: string;
  topic: string;
  icon: string;
  cat: DiscoveryCategory;
  class?: string;
  unit?: string;
  state_class?: "measurement";
}

interface HomeAssistantOrigin {
  name: string;
  sw_version: string;
  support_url: string;
}

interface HomeAssistantDevice {
  name: string;
  manufacturer: string;
  identifiers: [string];
  model: string;
  connections: [["mac", string]];
  sw_version: string;
}

interface DiscoveryContext {
  deviceId: string;
  deviceObjectId: string;
  baseTopic: string;
  baseDevice: HomeAssistantDevice;
}

interface NormalizedNodeDiscoveryConfig {
  platform?: ToggleDiscoveryPlatform;
  name?: string;
  defaultEntityId?: string;
  icon?: string;
}

interface NormalizedDeviceDiscoveryConfig {
  deviceName?: string;
  defaultPlatform?: ToggleDiscoveryPlatform;
  nodes: Readonly<Record<string, NormalizedNodeDiscoveryConfig>>;
}

interface DiscoveryComponentBase {
  name: string;
  unique_id: string;
  default_entity_id: string;
  state_topic: string;
  icon?: string;
  entity_category?: DiscoveryCategory;
  device_class?: string;
  unit_of_measurement?: string;
  state_class?: "measurement";
}

interface ToggleDiscoveryComponent extends DiscoveryComponentBase {
  platform: ToggleDiscoveryPlatform;
  command_topic: string;
  payload_on: BooleanLiteral;
  payload_off: BooleanLiteral;
}

interface SensorDiscoveryComponent extends DiscoveryComponentBase {
  platform: "sensor";
}

interface BinarySensorDiscoveryComponent extends DiscoveryComponentBase {
  platform: "binary_sensor";
  payload_on: BooleanLiteral;
  payload_off: BooleanLiteral;
}

interface RemovedDiscoveryComponent {
  platform: DiscoveryPlatform;
}

type DiscoveryComponent =
  | ToggleDiscoveryComponent
  | SensorDiscoveryComponent
  | BinarySensorDiscoveryComponent;

type DiscoveryComponentUpdate = DiscoveryComponent | RemovedDiscoveryComponent;

interface DeviceDiscoveryPayload {
  device: HomeAssistantDevice;
  origin: HomeAssistantOrigin;
  availability_topic: string;
  payload_available: AvailabilityPayload;
  payload_not_available: AvailabilityPayload;
  qos: 2;
  components: Record<string, DiscoveryComponentUpdate>;
}

interface SingleSensorDiscoveryPayload {
  name: string;
  unique_id: string;
  default_entity_id: string;
  state_topic: string;
  icon: string;
  entity_category: DiscoveryCategory;
  device: HomeAssistantDevice;
  origin: HomeAssistantOrigin;
}

type DiscoveryPayload = DeviceDiscoveryPayload | SingleSensorDiscoveryPayload;
type DiscoveryMessagePayload = DiscoveryPayload | "";

type DiscoveryMessage = NodeMessage & {
  topic: string;
  payload: DiscoveryMessagePayload;
  qos: 1;
  retain: true;
};

interface DiscoveryComponentEntry {
  id: string;
  platform: DiscoveryPlatform;
  config: DiscoveryComponent;
}

/**
 * State definitions for the Homie Discovery Manager.
 */
interface DeviceDiscoveryState {
  lastSeenAt: number;
  mac?: string;
  fw_version?: string;
  nodes?: string[];
  last_component_platforms?: Record<string, DiscoveryPlatform>;
}

interface ReadyDeviceDiscoveryState extends DeviceDiscoveryState {
  mac: string;
  fw_version: string;
  nodes: string[];
}

const normalizeOptionalString = (value: string | undefined): string | undefined => {
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

const normalizeDeviceDiscoveryConfig = (
  config: DeviceHomeAssistantDiscoveryConfig | undefined,
): NormalizedDeviceDiscoveryConfig | undefined => {
  if (!config) {
    return undefined;
  }

  const normalizedNodeEntries = Object.entries(config.nodes ?? {})
    .map(([nodeId, nodeConfig]): [string, NormalizedNodeDiscoveryConfig] => [
      nodeId.toLowerCase(),
      normalizeNodeDiscoveryConfig(nodeConfig),
    ])
    .sort(([left], [right]) => left.localeCompare(right));

  const normalizedNodes: Record<string, NormalizedNodeDiscoveryConfig> =
    Object.fromEntries(normalizedNodeEntries);

  return {
    deviceName: normalizeOptionalString(config.deviceName),
    defaultPlatform: config.defaultPlatform,
    nodes: normalizedNodes,
  };
};

/**
 * Manages the conversion of Homie devices to Home Assistant MQTT device discovery payloads.
 * It keeps enough in-memory state to emit an explicit component-removal update before the
 * final retained payload whenever the Homie node list shrinks.
 */
export class HomieDiscoveryManager {
  private readonly discoveryState: Map<string, DeviceDiscoveryState> = new Map();
  private readonly discoveryConfigByDevice: Map<string, NormalizedDeviceDiscoveryConfig> =
    new Map();
  private readonly configuredDeviceIds: Set<string> = new Set();
  private readonly pendingCleanupDeviceIds: Set<string> = new Set();
  private static originCache: HomeAssistantOrigin | null = null;
  private static readonly UNCONFIGURED_DEVICE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly VALID_NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

  private static readonly SENSORS_DEF: readonly DeviceDiscoveryDefinition[] = [
    { name: "MAC Address", topic: "$mac", icon: "mdi:ethernet", cat: "diagnostic" },
    { name: "Local IP", topic: "$localip", icon: "mdi:ip-network", cat: "diagnostic" },
    { name: "Homie Version", topic: "$homie", icon: "mdi:tag", cat: "diagnostic" },
    {
      name: "Firmware Version",
      topic: "$fw/version",
      icon: "mdi:cellphone-arrow-down",
      cat: "diagnostic",
    },
    { name: "Firmware Name", topic: "$fw/name", icon: "mdi:label", cat: "diagnostic" },
    {
      name: "Firmware Checksum",
      topic: "$fw/checksum",
      icon: "mdi:shield-check-outline",
      cat: "diagnostic",
    },
    {
      name: "Uptime",
      topic: "$stats/uptime",
      icon: "mdi:timer-sand",
      class: "duration",
      unit: "s",
      cat: "diagnostic",
      state_class: "measurement",
    },
    {
      name: "WiFi Uptime",
      topic: "$stats/uptimewifi",
      icon: "mdi:wifi-clock",
      class: "duration",
      unit: "s",
      cat: "diagnostic",
      state_class: "measurement",
    },
    {
      name: "MQTT Uptime",
      topic: "$stats/uptimemqtt",
      icon: "mdi:network-outline-clock",
      class: "duration",
      unit: "s",
      cat: "diagnostic",
      state_class: "measurement",
    },
    {
      name: "Signal Strength",
      topic: "$stats/signal",
      icon: "mdi:wifi",
      unit: "%",
      cat: "diagnostic",
      state_class: "measurement",
    },
    {
      name: "Free Heap",
      topic: "$stats/freeheap",
      icon: "mdi:memory",
      class: "data_size",
      unit: "B",
      cat: "diagnostic",
      state_class: "measurement",
    },
    {
      name: "Stats Interval",
      topic: "$stats/interval",
      icon: "mdi:timer-sync-outline",
      unit: "s",
      cat: "diagnostic",
      state_class: "measurement",
    },
    {
      name: "Implementation",
      topic: "$implementation",
      icon: "mdi:code-braces",
      cat: "diagnostic",
    },
    {
      name: "Implementation Version",
      topic: "$implementation/version",
      icon: "mdi:tag-outline",
      cat: "diagnostic",
    },
    {
      name: "Implementation Config",
      topic: "$implementation/config",
      icon: "mdi:code-json",
      cat: "diagnostic",
    },
    {
      name: "OTA Status",
      topic: "$implementation/ota/status",
      icon: "mdi:update",
      cat: "diagnostic",
    },
  ];

  private static readonly BINARY_SENSORS_DEF: readonly DeviceDiscoveryDefinition[] = [
    {
      name: "OTA Enabled",
      topic: "$implementation/ota/enabled",
      icon: "mdi:cellphone-arrow-down-cog",
      cat: "diagnostic",
    },
  ];

  constructor(
    private readonly homieBasePath: string,
    private readonly discoveryPrefix: string = "homeassistant",
    private readonly now: () => number = Date.now,
  ) {}

  private static getOrigin(): HomeAssistantOrigin {
    if (!this.originCache) {
      this.originCache = {
        name: "node-red-contrib-lsh-logic",
        sw_version: PACKAGE_VERSION,
        support_url: "https://github.com/labodj/node-red-contrib-lsh-logic",
      };
    }

    return this.originCache;
  }

  public setDiscoveryConfig(deviceConfigMap: ReadonlyMap<string, DeviceEntry>): void {
    const previouslyConfiguredDeviceIds = new Set(this.configuredDeviceIds);
    this.configuredDeviceIds.clear();
    this.discoveryConfigByDevice.clear();

    for (const [deviceId, deviceEntry] of deviceConfigMap) {
      this.configuredDeviceIds.add(deviceId);
      const normalizedConfig = normalizeDeviceDiscoveryConfig(deviceEntry.haDiscovery);
      if (normalizedConfig) {
        this.discoveryConfigByDevice.set(deviceId, normalizedConfig);
      }
    }

    for (const deviceId of previouslyConfiguredDeviceIds) {
      if (!this.configuredDeviceIds.has(deviceId)) {
        this.pendingCleanupDeviceIds.add(deviceId);
        this.discoveryState.delete(deviceId);
      }
    }

    this.pruneStaleWildcardDiscoveryState(this.now());
  }

  public reset(): ServiceResult {
    for (const [deviceId, deviceData] of this.discoveryState.entries()) {
      if (deviceData.last_component_platforms !== undefined) {
        this.pendingCleanupDeviceIds.add(deviceId);
      }
    }

    const result = createEmptyServiceResult();
    this.appendPendingCleanupMessages(result);
    this.configuredDeviceIds.clear();
    this.discoveryConfigByDevice.clear();
    this.discoveryState.clear();
    return result;
  }

  public regenerateDiscoveryPayloads(): ServiceResult {
    const result = createEmptyServiceResult();
    const discoveryMessages: DiscoveryMessage[] = [];
    this.pruneStaleWildcardDiscoveryState(this.now());
    this.appendPendingCleanupMessages(result);

    for (const [deviceId, deviceData] of this.discoveryState.entries()) {
      if (!this.isDeviceReady(deviceData)) {
        continue;
      }

      const { messages, componentPlatforms } = this.generateDiscoveryPayloads(deviceId, deviceData);
      discoveryMessages.push(...messages);
      deviceData.last_component_platforms = componentPlatforms;
    }

    if (discoveryMessages.length > 0) {
      appendLshMessages(result, discoveryMessages);
      result.logs.push(
        `Regenerated HA device discovery config for ${discoveryMessages.length} retained message(s).`,
      );
    }

    return result;
  }

  public pruneExpiredDiscoveryState(now: number = this.now()): ServiceResult {
    this.pruneStaleWildcardDiscoveryState(now);
    const result = createEmptyServiceResult();
    this.appendPendingCleanupMessages(result);
    return result;
  }

  /**
   * Processes incoming Homie attribute messages to build up device state
   * and generate discovery payloads when ready.
   */
  public processDiscoveryMessage(
    deviceId: string,
    topicSuffix: string,
    payload: string,
  ): ServiceResult {
    const result = createEmptyServiceResult();
    const now = this.now();
    this.pruneStaleWildcardDiscoveryState(now);

    const deviceData = this.getOrCreateDeviceData(deviceId, now);
    deviceData.lastSeenAt = now;
    const { changed: updated, warnings } = this.updateDeviceData(
      deviceId,
      deviceData,
      topicSuffix,
      payload,
    );
    result.warnings.push(...warnings);

    if (updated && this.isDeviceReady(deviceData)) {
      const { messages, componentPlatforms } = this.generateDiscoveryPayloads(deviceId, deviceData);
      result.messages[Output.Lsh] = messages;
      result.logs.push(
        `Generated HA device discovery config for ${deviceId} (${messages.length} messages)`,
      );
      deviceData.last_component_platforms = componentPlatforms;
    }

    return result;
  }

  /**
   * Retrieves existing state for a device or creates a new one.
   * @param deviceId - The device identifier.
   * @returns The discovery state object for the device.
   */
  private getOrCreateDeviceData(deviceId: string, now: number): DeviceDiscoveryState {
    let deviceData = this.discoveryState.get(deviceId);
    if (!deviceData) {
      // A wildcard device may legitimately reappear after its transient state
      // was pruned but before the retained cleanup queue is flushed. In that
      // case the pending tombstones must be cancelled so the renewed discovery
      // config is not deleted by a stale cleanup batch.
      this.pendingCleanupDeviceIds.delete(deviceId);
      deviceData = { lastSeenAt: now };
      this.discoveryState.set(deviceId, deviceData);
    }
    return deviceData;
  }

  /**
   * Wildcard discovery intentionally accepts devices that are not yet present
   * in the system config, but their transient state must remain bounded when
   * IDs churn over time.
   */
  private pruneStaleWildcardDiscoveryState(now: number): void {
    for (const [deviceId, deviceData] of this.discoveryState.entries()) {
      if (this.configuredDeviceIds.has(deviceId)) {
        continue;
      }

      if (now - deviceData.lastSeenAt > HomieDiscoveryManager.UNCONFIGURED_DEVICE_STATE_TTL_MS) {
        this.pendingCleanupDeviceIds.add(deviceId);
        this.discoveryState.delete(deviceId);
      }
    }
  }

  private appendPendingCleanupMessages(result: ServiceResult): void {
    const removedDeviceIds = Array.from(this.pendingCleanupDeviceIds).sort((left, right) =>
      left.localeCompare(right),
    );
    if (removedDeviceIds.length === 0) {
      return;
    }

    this.pendingCleanupDeviceIds.clear();
    const cleanupMessages = removedDeviceIds.flatMap((deviceId) =>
      this.buildDeviceCleanupMessages(deviceId),
    );
    appendLshMessages(result, cleanupMessages);
    result.logs.push(
      `Removed HA discovery config for ${removedDeviceIds.length} device(s) using ${cleanupMessages.length} retained cleanup message(s).`,
    );
  }

  private buildDeviceCleanupMessages(deviceId: string): DiscoveryMessage[] {
    const deviceObjectId = `lsh_${deviceId.toLowerCase()}`;
    const homieStateComponentId = `${deviceObjectId}_homie_state`;

    return [
      {
        topic: `${this.discoveryPrefix}/device/${deviceObjectId}/config`,
        payload: "",
        qos: 1,
        retain: true,
      },
      {
        topic: `${this.discoveryPrefix}/sensor/${homieStateComponentId}/config`,
        payload: "",
        qos: 1,
        retain: true,
      },
    ];
  }

  /**
   * Updates the device state based on the incoming topic suffix and payload.
   * @param data - The mutable device state object.
   * @param topicSuffix - The specific Homie attribute being updated (e.g., '/$mac').
   * @param payload - The new value for the attribute.
   * @returns True if the state was updated, false otherwise.
   */
  private updateDeviceData(
    deviceId: string,
    data: DeviceDiscoveryState,
    topicSuffix: string,
    payload: string,
  ): { changed: boolean; warnings: string[] } {
    switch (topicSuffix) {
      case "/$mac": {
        if (data.mac !== payload) {
          data.mac = payload;
          return { changed: true, warnings: [] };
        }
        break;
      }
      case "/$fw/version": {
        if (data.fw_version !== payload) {
          data.fw_version = payload;
          return { changed: true, warnings: [] };
        }
        break;
      }
      case "/$nodes": {
        const {
          nodes: newNodes,
          rejectedNodes,
          caseCollidingNodes,
        } = this.normalizeDiscoveryNodes(payload);
        const warnings: string[] = [];
        if (rejectedNodes.length > 0) {
          warnings.push(
            `Ignored invalid Homie node id(s) for '${deviceId}': ${rejectedNodes.join(", ")}.`,
          );
        }
        if (caseCollidingNodes.length > 0) {
          warnings.push(
            `Ignored Homie node id(s) for '${deviceId}' because they collide case-insensitively with another node id: ${caseCollidingNodes.join(", ")}.`,
          );
        }
        if (newNodes.length === 0) {
          warnings.push(
            `Ignored Homie $nodes payload for '${deviceId}' because it contained no valid node ids.`,
          );
          return { changed: false, warnings };
        }
        if (!this.areNodesEqual(data.nodes, newNodes)) {
          data.nodes = newNodes;
          return { changed: true, warnings };
        }
        return { changed: false, warnings };
      }
    }
    return { changed: false, warnings: [] };
  }

  private normalizeDiscoveryNodes(payload: string): {
    nodes: string[];
    rejectedNodes: string[];
    caseCollidingNodes: string[];
  } {
    const nodesByCanonicalId = new Map<string, string>();
    const rejectedNodes: string[] = [];
    const caseCollidingNodes: string[] = [];

    for (const token of payload.split(",")) {
      const normalized = token.trim();
      if (!normalized) {
        continue;
      }

      if (!HomieDiscoveryManager.VALID_NODE_ID_PATTERN.test(normalized)) {
        rejectedNodes.push(normalized);
        continue;
      }

      const canonicalNodeId = normalized.toLowerCase();
      const existingNodeId = nodesByCanonicalId.get(canonicalNodeId);

      if (!existingNodeId) {
        nodesByCanonicalId.set(canonicalNodeId, normalized);
        continue;
      }

      if (existingNodeId !== normalized) {
        // Home Assistant entity IDs and config overrides are lowercased, so two
        // node ids that differ only by case would collapse onto the same entity.
        // Keep the first spelling we saw and surface the ambiguity explicitly.
        caseCollidingNodes.push(normalized);
      }
    }

    return {
      nodes: Array.from(nodesByCanonicalId.values()).sort(
        (left, right) =>
          left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right),
      ),
      rejectedNodes,
      caseCollidingNodes,
    };
  }

  /**
   * Compares two arrays of node strings for equality after canonicalization.
   * @param oldNodes - The existing array of nodes.
   * @param newNodes - The new array of nodes.
   * @returns True if both arrays contain the same canonical node set.
   */
  private areNodesEqual(oldNodes: string[] | undefined, newNodes: string[]): boolean {
    if (!oldNodes) return false;
    const canonicalOldNodes = Array.from(
      new Set(oldNodes.map((nodeId) => nodeId.toLowerCase())),
    ).sort((left, right) => left.localeCompare(right));
    const canonicalNewNodes = Array.from(
      new Set(newNodes.map((nodeId) => nodeId.toLowerCase())),
    ).sort((left, right) => left.localeCompare(right));
    if (canonicalOldNodes.length !== canonicalNewNodes.length) return false;
    return canonicalOldNodes.every((val, index) => val === canonicalNewNodes[index]);
  }

  /**
   * Checks if all required properties (mac, fw_version, nodes) are present.
   * @param data - The device state to check.
   * @returns True if the device is ready for discovery generation.
   */
  private isDeviceReady(data: DeviceDiscoveryState): data is ReadyDeviceDiscoveryState {
    return Boolean(data.mac && data.fw_version && data.nodes && data.nodes.length > 0);
  }

  /**
   * Main orchestrator for generating retained device discovery messages for a device.
   * When components disappear, HA expects a transitional update that carries only the
   * platform for each removed component before the final payload omits it entirely.
   */
  private generateDiscoveryPayloads(
    deviceId: string,
    data: ReadyDeviceDiscoveryState,
  ): {
    messages: DiscoveryMessage[];
    componentPlatforms: Record<string, DiscoveryPlatform>;
  } {
    const discoveryConfig = this.discoveryConfigByDevice.get(deviceId);
    const baseDevice: HomeAssistantDevice = {
      name: discoveryConfig?.deviceName ?? `LSH ${deviceId.toUpperCase()}`,
      manufacturer: "Jacopo Labardi",
      identifiers: [`LSH_${deviceId}`],
      model: "Labo Smart Home",
      connections: [["mac", data.mac]],
      sw_version: data.fw_version,
    };

    const discoveryContext: DiscoveryContext = {
      deviceId,
      deviceObjectId: `lsh_${deviceId.toLowerCase()}`,
      baseTopic: `${this.homieBasePath}${deviceId}`,
      baseDevice,
    };

    const componentEntries = this.buildComponents(data.nodes, discoveryContext, discoveryConfig);
    const componentPlatforms = this.toComponentPlatformMap(componentEntries);
    const removedComponents = this.findRemovedComponents(
      data.last_component_platforms,
      componentPlatforms,
    );

    const messages: DiscoveryMessage[] = [];
    if (Object.keys(removedComponents).length > 0) {
      messages.push(
        this.buildDeviceDiscoveryMessage(discoveryContext, componentEntries, removedComponents),
      );
    }

    messages.push(this.buildDeviceDiscoveryMessage(discoveryContext, componentEntries));
    messages.push(this.buildHomieStateSensorMessage(discoveryContext));

    return { messages, componentPlatforms };
  }

  private buildComponents(
    nodes: string[],
    discoveryContext: DiscoveryContext,
    discoveryConfig: NormalizedDeviceDiscoveryConfig | undefined,
  ): DiscoveryComponentEntry[] {
    return [
      ...this.generateActuatorEntities(nodes, discoveryContext, discoveryConfig),
      ...this.generateSensors(discoveryContext),
      ...this.generateBinarySensors(discoveryContext),
    ];
  }

  private toComponentPlatformMap(
    entries: DiscoveryComponentEntry[],
  ): Record<string, DiscoveryPlatform> {
    return Object.fromEntries(entries.map((entry) => [entry.id, entry.platform]));
  }

  private findRemovedComponents(
    previous: Record<string, DiscoveryPlatform> | undefined,
    current: Record<string, DiscoveryPlatform>,
  ): Record<string, DiscoveryPlatform> {
    if (!previous) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(previous).filter(
        ([componentId, previousPlatform]) =>
          !(componentId in current) || current[componentId] !== previousPlatform,
      ),
    );
  }

  private buildDeviceDiscoveryMessage(
    { deviceObjectId, baseTopic, baseDevice }: DiscoveryContext,
    entries: DiscoveryComponentEntry[],
    removedComponents: Record<string, DiscoveryPlatform> = {},
  ): DiscoveryMessage {
    const payload: DeviceDiscoveryPayload = {
      device: baseDevice,
      origin: HomieDiscoveryManager.getOrigin(),
      availability_topic: `${baseTopic}/$state`,
      payload_available: "ready",
      payload_not_available: "lost",
      qos: 2,
      components: Object.fromEntries(entries.map((entry) => [entry.id, entry.config])),
    };

    for (const [componentId, platform] of Object.entries(removedComponents)) {
      payload.components[componentId] = { platform };
    }

    return {
      topic: `${this.discoveryPrefix}/device/${deviceObjectId}/config`,
      payload,
      qos: 1,
      retain: true,
    };
  }

  /**
   * Publishes the raw Homie `$state` as a standalone diagnostic sensor.
   * This intentionally avoids shared availability so Home Assistant can
   * record values like `lost` in history instead of marking the sensor
   * unavailable at the same moment.
   */
  private buildHomieStateSensorMessage({
    deviceId,
    baseTopic,
    baseDevice,
  }: DiscoveryContext): DiscoveryMessage {
    const componentId = `lsh_${deviceId.toLowerCase()}_homie_state`;
    const payload: SingleSensorDiscoveryPayload = {
      name: `${deviceId.toUpperCase()} Homie State`,
      unique_id: componentId,
      default_entity_id: `sensor.${componentId}`,
      state_topic: `${baseTopic}/$state`,
      icon: "mdi:state-machine",
      entity_category: "diagnostic",
      device: baseDevice,
      origin: HomieDiscoveryManager.getOrigin(),
    };

    return {
      topic: `${this.discoveryPrefix}/sensor/${componentId}/config`,
      payload,
      qos: 1,
      retain: true,
    };
  }

  /**
   * Generates device-discovery component definitions for 'light' entities based on nodes.
   * @param nodes - List of node names (e.g., 'light1', 'light2').
   * @param ctx - Context object containing deviceId and base topic information.
   * @returns Array of component definitions.
   */
  private generateActuatorEntities(
    nodes: string[],
    { deviceId, baseTopic }: DiscoveryContext,
    discoveryConfig: NormalizedDeviceDiscoveryConfig | undefined,
  ): DiscoveryComponentEntry[] {
    return nodes.reduce<DiscoveryComponentEntry[]>((entries, node) => {
      if (!node) {
        return entries;
      }

      const nodeConfig = discoveryConfig?.nodes[node.toLowerCase()];
      const platform = nodeConfig?.platform ?? discoveryConfig?.defaultPlatform ?? "light";
      const componentId = `lsh_${deviceId.toLowerCase()}_${node.toLowerCase()}`;
      entries.push({
        id: componentId,
        platform,
        config: {
          platform,
          name: nodeConfig?.name ?? `${deviceId.toUpperCase()} ${node.toUpperCase()}`,
          unique_id: componentId,
          default_entity_id: nodeConfig?.defaultEntityId ?? `${platform}.${componentId}`,
          state_topic: `${baseTopic}/${node}/state`,
          command_topic: `${baseTopic}/${node}/state/set`,
          icon: nodeConfig?.icon,
          payload_on: "true",
          payload_off: "false",
        },
      });

      return entries;
    }, []);
  }

  /**
   * Generates discovery component definitions for standard diagnostic sensors.
   * @param ctx - Context object containing deviceId and base topic information.
   * @returns Array of component definitions.
   */
  private generateSensors({ deviceId, baseTopic }: DiscoveryContext): DiscoveryComponentEntry[] {
    return HomieDiscoveryManager.SENSORS_DEF.map((definition) =>
      this.buildPayload(deviceId, baseTopic, "sensor", definition),
    );
  }

  /**
   * Generates discovery component definitions for binary sensors.
   * @param ctx - Context object containing deviceId and base topic information.
   * @returns Array of component definitions.
   */
  private generateBinarySensors({
    deviceId,
    baseTopic,
  }: DiscoveryContext): DiscoveryComponentEntry[] {
    return HomieDiscoveryManager.BINARY_SENSORS_DEF.map((definition) =>
      this.buildPayload(deviceId, baseTopic, "binary_sensor", definition, {
        payload_on: "true",
        payload_off: "false",
      }),
    );
  }

  /**
   * Helper to construct a single Home Assistant discovery component definition.
   * @param deviceId - The device identifier.
   * @param type - The component type (e.g., 'sensor', 'binary_sensor').
   * @param def - The definition object for the specific entity.
   * @param extras - Additional payload properties to merge.
   * @returns A component definition keyed by a stable component ID.
   */
  private buildPayload(
    deviceId: string,
    baseTopic: string,
    type: Exclude<DiscoveryPlatform, ToggleDiscoveryPlatform>,
    def: DeviceDiscoveryDefinition,
    extras: Partial<Pick<BinarySensorDiscoveryComponent, "payload_on" | "payload_off">> = {},
  ): DiscoveryComponentEntry {
    const nameLc = def.name.toLowerCase().replace(/ /g, "_");
    const componentId = `lsh_${deviceId.toLowerCase()}_${nameLc}`;

    const config: DiscoveryComponent =
      type === "binary_sensor"
        ? {
            platform: "binary_sensor",
            name: `${deviceId.toUpperCase()} ${def.name}`,
            unique_id: componentId,
            default_entity_id: `${type}.${componentId}`,
            state_topic: `${baseTopic}/${def.topic}`,
            icon: def.icon,
            entity_category: def.cat,
            payload_on: extras.payload_on ?? "true",
            payload_off: extras.payload_off ?? "false",
          }
        : {
            platform: "sensor",
            name: `${deviceId.toUpperCase()} ${def.name}`,
            unique_id: componentId,
            default_entity_id: `${type}.${componentId}`,
            state_topic: `${baseTopic}/${def.topic}`,
            icon: def.icon,
            entity_category: def.cat,
          };

    if (def.class) config.device_class = def.class;
    if (def.unit) config.unit_of_measurement = def.unit;
    if (def.state_class) config.state_class = def.state_class;

    return {
      id: componentId,
      platform: type,
      config,
    };
  }
}
