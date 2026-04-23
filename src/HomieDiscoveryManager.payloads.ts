import type { NodeMessage } from "node-red";

import {
  resolveNodeDiscoveryShape,
  type DiscoveryNodeRuntimeMetadata,
  type DiscoveryPlatform,
  type NormalizedDeviceDiscoveryConfig,
  type ToggleDiscoveryPlatform,
} from "./HomieDiscoveryManager.helpers";
import { PACKAGE_VERSION } from "./version";

type DiscoveryCategory = "diagnostic";
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

export type DiscoveryMessage = NodeMessage & {
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

export interface DiscoveryBuildArgs {
  canonicalDeviceId: string;
  runtimeDeviceId: string;
  homieBasePath: string;
  discoveryPrefix: string;
  mac: string;
  fwVersion: string;
  nodes: string[];
  nodeMetadata: Record<string, DiscoveryNodeRuntimeMetadata>;
  lastComponentPlatforms?: Record<string, DiscoveryPlatform>;
  discoveryConfig?: NormalizedDeviceDiscoveryConfig;
}

const SENSORS_DEF: readonly DeviceDiscoveryDefinition[] = [
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

const BINARY_SENSORS_DEF: readonly DeviceDiscoveryDefinition[] = [
  {
    name: "OTA Enabled",
    topic: "$implementation/ota/enabled",
    icon: "mdi:cellphone-arrow-down-cog",
    cat: "diagnostic",
  },
];

let cachedOrigin: HomeAssistantOrigin | null = null;

const getOrigin = (): HomeAssistantOrigin => {
  if (!cachedOrigin) {
    cachedOrigin = {
      name: "node-red-contrib-lsh-logic",
      sw_version: PACKAGE_VERSION,
      support_url: "https://github.com/labodj/node-red-contrib-lsh-logic",
    };
  }

  return cachedOrigin;
};

const buildDiscoveryMessagesSignature = (messages: DiscoveryMessage[]): string => {
  return JSON.stringify(
    messages.map((message) => ({
      topic: message.topic,
      payload: message.payload,
    })),
  );
};

const buildPayload = (
  deviceId: string,
  baseTopic: string,
  type: Exclude<DiscoveryPlatform, ToggleDiscoveryPlatform>,
  definition: DeviceDiscoveryDefinition,
  extras: Partial<Pick<BinarySensorDiscoveryComponent, "payload_on" | "payload_off">> = {},
): DiscoveryComponentEntry => {
  const nameLc = definition.name.toLowerCase().replace(/ /g, "_");
  const componentId = `lsh_${deviceId.toLowerCase()}_${nameLc}`;

  const config: DiscoveryComponent =
    type === "binary_sensor"
      ? {
          platform: "binary_sensor",
          name: `${deviceId.toUpperCase()} ${definition.name}`,
          unique_id: componentId,
          default_entity_id: `${type}.${componentId}`,
          state_topic: `${baseTopic}/${definition.topic}`,
          icon: definition.icon,
          entity_category: definition.cat,
          payload_on: extras.payload_on ?? "true",
          payload_off: extras.payload_off ?? "false",
        }
      : {
          platform: "sensor",
          name: `${deviceId.toUpperCase()} ${definition.name}`,
          unique_id: componentId,
          default_entity_id: `${type}.${componentId}`,
          state_topic: `${baseTopic}/${definition.topic}`,
          icon: definition.icon,
          entity_category: definition.cat,
        };

  if (definition.class) config.device_class = definition.class;
  if (definition.unit) config.unit_of_measurement = definition.unit;
  if (definition.state_class) config.state_class = definition.state_class;

  return {
    id: componentId,
    platform: type,
    config,
  };
};

const generateSensors = ({ deviceId, baseTopic }: DiscoveryContext): DiscoveryComponentEntry[] => {
  return SENSORS_DEF.map((definition) => buildPayload(deviceId, baseTopic, "sensor", definition));
};

const generateBinarySensors = ({
  deviceId,
  baseTopic,
}: DiscoveryContext): DiscoveryComponentEntry[] => {
  return BINARY_SENSORS_DEF.map((definition) =>
    buildPayload(deviceId, baseTopic, "binary_sensor", definition, {
      payload_on: "true",
      payload_off: "false",
    }),
  );
};

const generateNodeEntities = (
  nodes: string[],
  nodeMetadata: Record<string, DiscoveryNodeRuntimeMetadata>,
  { deviceId, baseTopic }: DiscoveryContext,
  discoveryConfig: NormalizedDeviceDiscoveryConfig | undefined,
): DiscoveryComponentEntry[] => {
  return nodes.reduce<DiscoveryComponentEntry[]>((entries, node) => {
    if (!node) {
      return entries;
    }

    const { platform, commandable, nodeConfig } = resolveNodeDiscoveryShape(
      node,
      nodeMetadata[node.toLowerCase()],
      discoveryConfig,
    );
    const componentId = `lsh_${deviceId.toLowerCase()}_${node.toLowerCase()}`;

    if (commandable) {
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
    }

    entries.push({
      id: componentId,
      platform,
      config:
        platform === "binary_sensor"
          ? {
              platform: "binary_sensor",
              name: nodeConfig?.name ?? `${deviceId.toUpperCase()} ${node.toUpperCase()}`,
              unique_id: componentId,
              default_entity_id: nodeConfig?.defaultEntityId ?? `${platform}.${componentId}`,
              state_topic: `${baseTopic}/${node}/state`,
              icon: nodeConfig?.icon,
              payload_on: "true",
              payload_off: "false",
            }
          : {
              platform: "sensor",
              name: nodeConfig?.name ?? `${deviceId.toUpperCase()} ${node.toUpperCase()}`,
              unique_id: componentId,
              default_entity_id: nodeConfig?.defaultEntityId ?? `${platform}.${componentId}`,
              state_topic: `${baseTopic}/${node}/state`,
              icon: nodeConfig?.icon,
            },
    });

    return entries;
  }, []);
};

const buildComponents = (
  nodes: string[],
  nodeMetadata: Record<string, DiscoveryNodeRuntimeMetadata>,
  discoveryContext: DiscoveryContext,
  discoveryConfig: NormalizedDeviceDiscoveryConfig | undefined,
): DiscoveryComponentEntry[] => {
  return [
    ...generateNodeEntities(nodes, nodeMetadata, discoveryContext, discoveryConfig),
    ...generateSensors(discoveryContext),
    ...generateBinarySensors(discoveryContext),
  ];
};

const toComponentPlatformMap = (
  entries: DiscoveryComponentEntry[],
): Record<string, DiscoveryPlatform> => {
  return Object.fromEntries(entries.map((entry) => [entry.id, entry.platform]));
};

const findRemovedComponents = (
  previous: Record<string, DiscoveryPlatform> | undefined,
  current: Record<string, DiscoveryPlatform>,
): Record<string, DiscoveryPlatform> => {
  if (!previous) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(previous).filter(
      ([componentId, previousPlatform]) =>
        !(componentId in current) || current[componentId] !== previousPlatform,
    ),
  );
};

const buildDeviceDiscoveryMessage = (
  discoveryPrefix: string,
  { deviceObjectId, baseTopic, baseDevice }: DiscoveryContext,
  entries: DiscoveryComponentEntry[],
  removedComponents: Record<string, DiscoveryPlatform> = {},
): DiscoveryMessage => {
  const payload: DeviceDiscoveryPayload = {
    device: baseDevice,
    origin: getOrigin(),
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
    topic: `${discoveryPrefix}/device/${deviceObjectId}/config`,
    payload,
    qos: 1,
    retain: true,
  };
};

const buildHomieStateSensorMessage = (
  discoveryPrefix: string,
  { deviceId, baseTopic, baseDevice }: DiscoveryContext,
): DiscoveryMessage => {
  const componentId = `lsh_${deviceId.toLowerCase()}_homie_state`;
  const payload: SingleSensorDiscoveryPayload = {
    name: `${deviceId.toUpperCase()} Homie State`,
    unique_id: componentId,
    default_entity_id: `sensor.${componentId}`,
    state_topic: `${baseTopic}/$state`,
    icon: "mdi:state-machine",
    entity_category: "diagnostic",
    device: baseDevice,
    origin: getOrigin(),
  };

  return {
    topic: `${discoveryPrefix}/sensor/${componentId}/config`,
    payload,
    qos: 1,
    retain: true,
  };
};

/**
 * Centralized Home Assistant discovery planner for a single ready device.
 * The manager owns scheduling/debounce/state, while this helper owns payload shape.
 */
export const buildDiscoveryPayloads = ({
  canonicalDeviceId,
  runtimeDeviceId,
  homieBasePath,
  discoveryPrefix,
  mac,
  fwVersion,
  nodes,
  nodeMetadata,
  lastComponentPlatforms,
  discoveryConfig,
}: DiscoveryBuildArgs): {
  messages: DiscoveryMessage[];
  componentPlatforms: Record<string, DiscoveryPlatform>;
  signature: string;
} => {
  const baseDevice: HomeAssistantDevice = {
    name: discoveryConfig?.deviceName ?? `LSH ${runtimeDeviceId.toUpperCase()}`,
    manufacturer: "Jacopo Labardi",
    identifiers: [`LSH_${canonicalDeviceId}`],
    model: "Labo Smart Home",
    connections: [["mac", mac]],
    sw_version: fwVersion,
  };

  const discoveryContext: DiscoveryContext = {
    deviceId: runtimeDeviceId,
    deviceObjectId: `lsh_${canonicalDeviceId}`,
    baseTopic: `${homieBasePath}${runtimeDeviceId}`,
    baseDevice,
  };

  const componentEntries = buildComponents(nodes, nodeMetadata, discoveryContext, discoveryConfig);
  const componentPlatforms = toComponentPlatformMap(componentEntries);
  const removedComponents = findRemovedComponents(lastComponentPlatforms, componentPlatforms);

  const messages: DiscoveryMessage[] = [];
  if (Object.keys(removedComponents).length > 0) {
    messages.push(
      buildDeviceDiscoveryMessage(
        discoveryPrefix,
        discoveryContext,
        componentEntries,
        removedComponents,
      ),
    );
  }

  messages.push(buildDeviceDiscoveryMessage(discoveryPrefix, discoveryContext, componentEntries));
  messages.push(buildHomieStateSensorMessage(discoveryPrefix, discoveryContext));

  return {
    messages,
    componentPlatforms,
    signature: buildDiscoveryMessagesSignature(messages),
  };
};

export const buildDeviceCleanupMessages = (
  discoveryPrefix: string,
  canonicalDeviceId: string,
): DiscoveryMessage[] => {
  const deviceObjectId = `lsh_${canonicalDeviceId.toLowerCase()}`;
  const homieStateComponentId = `${deviceObjectId}_homie_state`;

  return [
    {
      topic: `${discoveryPrefix}/device/${deviceObjectId}/config`,
      payload: "",
      qos: 1,
      retain: true,
    },
    {
      topic: `${discoveryPrefix}/sensor/${homieStateComponentId}/config`,
      payload: "",
      qos: 1,
      retain: true,
    },
  ];
};
