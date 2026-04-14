import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NodeMessage } from "node-red";

import { Output } from "./types";
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

type DiscoveryMessage = NodeMessage & {
  topic: string;
  payload: DiscoveryPayload;
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

type PackageMetadata = {
  version?: string;
};

const readPackageVersion = (): string => {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf8"),
  ) as PackageMetadata;

  return typeof raw.version === "string" ? raw.version : "0.0.0";
};

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

  const normalizedNodes = Object.fromEntries(normalizedNodeEntries) as Record<
    string,
    NormalizedNodeDiscoveryConfig
  >;

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
  private static readonly ORIGIN: HomeAssistantOrigin = {
    name: "node-red-contrib-lsh-logic",
    sw_version: readPackageVersion(),
    support_url: "https://github.com/labodj/node-red-contrib-lsh-logic",
  };

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
  ) {}

  public setDiscoveryConfig(deviceConfigMap: ReadonlyMap<string, DeviceEntry>): void {
    this.discoveryConfigByDevice.clear();

    for (const [deviceId, deviceEntry] of deviceConfigMap) {
      const normalizedConfig = normalizeDeviceDiscoveryConfig(deviceEntry.haDiscovery);
      if (normalizedConfig) {
        this.discoveryConfigByDevice.set(deviceId, normalizedConfig);
      }
    }
  }

  public regenerateDiscoveryPayloads(): ServiceResult {
    const result = this.createEmptyResult();
    const discoveryMessages: DiscoveryMessage[] = [];

    for (const [deviceId, deviceData] of this.discoveryState.entries()) {
      if (!this.isDeviceReady(deviceData)) {
        continue;
      }

      const { messages, componentPlatforms } = this.generateDiscoveryPayloads(deviceId, deviceData);
      discoveryMessages.push(...messages);
      deviceData.last_component_platforms = componentPlatforms;
    }

    if (discoveryMessages.length > 0) {
      result.messages[Output.Lsh] = discoveryMessages;
      result.logs.push(
        `Regenerated HA device discovery config for ${discoveryMessages.length} retained message(s).`,
      );
    }

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
    const result = this.createEmptyResult();

    const deviceData = this.getOrCreateDeviceData(deviceId);
    const updated = this.updateDeviceData(deviceData, topicSuffix, payload);

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

  private createEmptyResult(): ServiceResult {
    return {
      messages: {},
      logs: [],
      warnings: [],
      errors: [],
      stateChanged: false,
    };
  }

  /**
   * Retrieves existing state for a device or creates a new one.
   * @param deviceId - The device identifier.
   * @returns The discovery state object for the device.
   */
  private getOrCreateDeviceData(deviceId: string): DeviceDiscoveryState {
    let deviceData = this.discoveryState.get(deviceId);
    if (!deviceData) {
      deviceData = {};
      this.discoveryState.set(deviceId, deviceData);
    }
    return deviceData;
  }

  /**
   * Updates the device state based on the incoming topic suffix and payload.
   * @param data - The mutable device state object.
   * @param topicSuffix - The specific Homie attribute being updated (e.g., '/$mac').
   * @param payload - The new value for the attribute.
   * @returns True if the state was updated, false otherwise.
   */
  private updateDeviceData(
    data: DeviceDiscoveryState,
    topicSuffix: string,
    payload: string,
  ): boolean {
    switch (topicSuffix) {
      case "/$mac": {
        if (data.mac !== payload) {
          data.mac = payload;
          return true;
        }
        break;
      }
      case "/$fw/version": {
        if (data.fw_version !== payload) {
          data.fw_version = payload;
          return true;
        }
        break;
      }
      case "/$nodes": {
        const newNodes = payload.split(",");
        if (!this.areNodesEqual(data.nodes, newNodes)) {
          data.nodes = newNodes;
          return true;
        }
        break;
      }
    }
    return false;
  }

  /**
   * Compares two arrays of node strings for equality.
   * @param oldNodes - The existing array of nodes.
   * @param newNodes - The new array of nodes.
   * @returns True if both arrays contain the same strings in the same order.
   */
  private areNodesEqual(oldNodes: string[] | undefined, newNodes: string[]): boolean {
    if (!oldNodes) return false;
    if (oldNodes.length !== newNodes.length) return false;
    return oldNodes.every((val, index) => val === newNodes[index]);
  }

  /**
   * Checks if all required properties (mac, fw_version, nodes) are present.
   * @param data - The device state to check.
   * @returns True if the device is ready for discovery generation.
   */
  private isDeviceReady(data: DeviceDiscoveryState): data is ReadyDeviceDiscoveryState {
    return !!(data.mac && data.fw_version && data.nodes);
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
      origin: HomieDiscoveryManager.ORIGIN,
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
      origin: HomieDiscoveryManager.ORIGIN,
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
