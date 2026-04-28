/**
 * @file Unit tests for the Homie v5 to Home Assistant discovery bridge.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { HomieDiscoveryManager } from "../HomieDiscoveryManager";
import { Output } from "../types";
import { PACKAGE_VERSION } from "../version";
import type { NodeMessage } from "node-red";

type DiscoveryPlatform =
  | "light"
  | "switch"
  | "fan"
  | "sensor"
  | "binary_sensor"
  | "number"
  | "select"
  | "text";
const UNCONFIGURED_DISCOVERY_STATE_TTL_MS = 24 * 60 * 60 * 1000;

type DiscoveryComponent = {
  platform: DiscoveryPlatform;
  unique_id?: string;
  name?: string;
  default_entity_id?: string;
  entity_category?: string;
  state_topic?: string;
  command_topic?: string;
  payload_on?: string;
  payload_off?: string;
  force_update?: boolean;
  max?: number;
  min?: number;
  mode?: string;
  options?: string[];
  state_class?: string;
  step?: number;
  unit_of_measurement?: string;
  value_template?: string;
  json_attributes_topic?: string;
};

type DiscoveryPayload = {
  device: {
    name?: string;
    connections?: [["mac", string]];
    sw_version?: string;
  };
  origin: {
    sw_version: string;
    support_url: string;
  };
  availability_topic?: string;
  availability_template?: string;
  payload_available?: string;
  payload_not_available?: string;
  components?: Record<string, DiscoveryComponent>;
  name?: string;
  unique_id?: string;
  default_entity_id?: string;
  state_topic?: string;
  entity_category?: string;
};

type StatePropertySpec = {
  datatype?: string;
  settable?: boolean;
  name?: string;
  nodeName?: string;
  includeState?: boolean;
  format?: string;
  retained?: boolean;
  rawSettable?: unknown;
  unit?: string;
};

const getDiscoveryMessages = (
  messages: NodeMessage[] | NodeMessage | undefined,
): Array<
  NodeMessage & {
    topic: string;
    payload: DiscoveryPayload;
  }
> => {
  if (!messages) {
    throw new Error("Expected discovery messages to be defined.");
  }
  const normalized = Array.isArray(messages) ? messages : [messages];
  return normalized as Array<NodeMessage & { topic: string; payload: DiscoveryPayload }>;
};

const buildHomieV5Description = (
  nodes: Record<string, StatePropertySpec>,
  deviceName = "Kitchen Board",
): string => {
  const descriptionNodes: Record<string, unknown> = {};

  for (const [nodeId, spec] of Object.entries(nodes)) {
    const node: Record<string, unknown> = {
      name: spec.nodeName,
      type: "actuator",
      properties: {},
    };
    const properties = node.properties as Record<string, unknown>;

    if (spec.includeState !== false) {
      const state: Record<string, unknown> = {
        name: spec.name,
        datatype: spec.datatype ?? "boolean",
      };
      if (spec.rawSettable !== undefined) {
        state.settable = spec.rawSettable;
      } else if (spec.settable !== undefined) {
        state.settable = spec.settable;
      }
      if (spec.format !== undefined) state.format = spec.format;
      if (spec.retained !== undefined) state.retained = spec.retained;
      if (spec.unit !== undefined) state.unit = spec.unit;
      properties.state = state;
    }

    descriptionNodes[nodeId] = node;
  }

  return JSON.stringify({
    homie: "5.0",
    version: 5,
    name: deviceName,
    nodes: descriptionNodes,
  });
};

describe("HomieDiscoveryManager", () => {
  let manager: HomieDiscoveryManager;
  let now: number;
  const homieBasePath = "homie/5/";
  const discoveryPrefix = "homeassistant";

  beforeEach(() => {
    now = 0;
    manager = new HomieDiscoveryManager(homieBasePath, discoveryPrefix, () => now);
  });

  const getMessageByTopic = (
    messages: Array<NodeMessage & { topic: string; payload: DiscoveryPayload }>,
    topic: string,
  ): NodeMessage & { topic: string; payload: DiscoveryPayload } => {
    const message = messages.find((entry) => entry.topic === topic);
    if (!message) {
      throw new Error(`Expected discovery message for topic '${topic}'.`);
    }

    return message;
  };

  const publishDescription = (
    deviceId: string,
    nodes: Record<string, StatePropertySpec>,
    deviceName?: string,
  ) => {
    const result = manager.processDiscoveryMessage(
      deviceId,
      "/$description",
      buildHomieV5Description(nodes, deviceName),
    );
    return result.discoveryFlushDelayMs === undefined ? result : manager.flushPendingDiscovery();
  };

  it("generates Home Assistant discovery from the atomic Homie v5 description", () => {
    const deviceId = "device01";

    expect(
      manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF").messages[Output.Lsh],
    ).toBeUndefined();
    expect(
      manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0").messages[Output.Lsh],
    ).toBeUndefined();

    const result = publishDescription(deviceId, {
      light1: { settable: true, nodeName: "Main Light" },
      temperature: { datatype: "float", nodeName: "Temperature" },
    });
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device01/config");
    const homieStateMessage = getMessageByTopic(
      messages,
      "homeassistant/sensor/lsh_device01_homie_state/config",
    );

    expect(messages).toHaveLength(2);
    expect(deviceMessage.payload).not.toHaveProperty("~");
    expect(deviceMessage.payload.availability_topic).toBe("homie/5/device01/$state");
    expect(deviceMessage.payload.availability_template).toBe(
      "{{ 'online' if value == 'ready' else 'offline' }}",
    );
    expect(deviceMessage.payload.payload_available).toBe("online");
    expect(deviceMessage.payload.payload_not_available).toBe("offline");
    expect(deviceMessage.payload.device.connections).toEqual([["mac", "AA:BB:CC:DD:EE:FF"]]);
    expect(deviceMessage.payload.device.sw_version).toBe("1.0.0");
    expect(deviceMessage.payload.origin.support_url).toBe(
      "https://github.com/labodj/node-red-contrib-lsh-logic",
    );
    expect(deviceMessage.payload.origin.sw_version).toBe(PACKAGE_VERSION);

    expect(deviceMessage.payload.components?.lsh_device01_light1).toEqual(
      expect.objectContaining({
        platform: "light",
        name: "DEVICE01 Main Light",
        unique_id: "lsh_device01_light1",
        default_entity_id: "light.lsh_device01_light1",
        state_topic: "homie/5/device01/light1/state",
        command_topic: "homie/5/device01/light1/state/set",
        payload_on: "true",
        payload_off: "false",
      }),
    );

    expect(deviceMessage.payload.components?.lsh_device01_temperature).toEqual(
      expect.objectContaining({
        platform: "sensor",
        state_topic: "homie/5/device01/temperature/state",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_temperature).not.toHaveProperty(
      "command_topic",
    );

    expect(deviceMessage.payload.components?.lsh_device01_mac_address).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 MAC Address",
        unique_id: "lsh_device01_mac_address",
        entity_category: "diagnostic",
        state_topic: "homie/5/device01/$mac",
      }),
    );

    expect(deviceMessage.payload.components?.lsh_device01_ota_enabled).toEqual(
      expect.objectContaining({
        platform: "binary_sensor",
        name: "DEVICE01 OTA Enabled",
        unique_id: "lsh_device01_ota_enabled",
        state_topic: "homie/5/device01/$implementation/ota/enabled",
        payload_on: "true",
        payload_off: "false",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_homie_description_version).toEqual(
      expect.objectContaining({
        platform: "sensor",
        state_topic: "homie/5/device01/$description",
        value_template: "{{ value_json.version }}",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_implementation_config).toEqual(
      expect.objectContaining({
        platform: "sensor",
        state_topic: "homie/5/device01/$implementation/config",
        value_template: "{{ 'configured' }}",
        json_attributes_topic: "homie/5/device01/$implementation/config",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_reset_reason).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 Reset Reason",
        unique_id: "lsh_device01_reset_reason",
        default_entity_id: "sensor.lsh_device01_reset_reason",
        state_topic: "homie/5/device01/$implementation/reset/reason",
        entity_category: "diagnostic",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_wifi_last_disconnect_reason).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 WiFi Last Disconnect Reason",
        unique_id: "lsh_device01_wifi_last_disconnect_reason",
        default_entity_id: "sensor.lsh_device01_wifi_last_disconnect_reason",
        state_topic: "homie/5/device01/$implementation/wifi/last_disconnect_reason",
        entity_category: "diagnostic",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_mqtt_last_disconnect_reason).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 MQTT Last Disconnect Reason",
        unique_id: "lsh_device01_mqtt_last_disconnect_reason",
        default_entity_id: "sensor.lsh_device01_mqtt_last_disconnect_reason",
        state_topic: "homie/5/device01/$implementation/mqtt/last_disconnect_reason",
        entity_category: "diagnostic",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_mqtt_inbound_dropped).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 MQTT Inbound Dropped Since Boot",
        unique_id: "lsh_device01_mqtt_inbound_dropped",
        default_entity_id: "sensor.lsh_device01_mqtt_inbound_dropped",
        state_topic: "homie/5/device01/$stats/mqttinbounddropped",
        entity_category: "diagnostic",
        state_class: "total_increasing",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_mqtt_ack_dropped).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 MQTT Ack Dropped Since Boot",
        unique_id: "lsh_device01_mqtt_ack_dropped",
        default_entity_id: "sensor.lsh_device01_mqtt_ack_dropped",
        state_topic: "homie/5/device01/$stats/mqttackdropped",
        entity_category: "diagnostic",
        state_class: "total_increasing",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_mqtt_inbound_max_depth).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 MQTT Inbound Max Queue Depth",
        unique_id: "lsh_device01_mqtt_inbound_max_depth",
        default_entity_id: "sensor.lsh_device01_mqtt_inbound_max_depth",
        state_topic: "homie/5/device01/$stats/mqttinboundmaxdepth",
        entity_category: "diagnostic",
        state_class: "measurement",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01_mqtt_ack_max_depth).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 MQTT Ack Max Queue Depth",
        unique_id: "lsh_device01_mqtt_ack_max_depth",
        default_entity_id: "sensor.lsh_device01_mqtt_ack_max_depth",
        state_topic: "homie/5/device01/$stats/mqttackmaxdepth",
        entity_category: "diagnostic",
        state_class: "measurement",
      }),
    );

    expect(homieStateMessage.payload).toEqual(
      expect.objectContaining({
        name: "DEVICE01 Homie State",
        unique_id: "lsh_device01_homie_state",
        default_entity_id: "sensor.lsh_device01_homie_state",
        state_topic: "homie/5/device01/$state",
        entity_category: "diagnostic",
      }),
    );
    expect(homieStateMessage.payload).not.toHaveProperty("availability_topic");
  });

  it("uses Home Assistant state classes that match fork diagnostic semantics", () => {
    const result = publishDescription("device14", {
      relay: { settable: true },
    });
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device14/config");
    const components = deviceMessage.payload.components ?? {};

    expect(components.lsh_device14_uptime).toEqual(
      expect.objectContaining({
        platform: "sensor",
        device_class: "duration",
        unit_of_measurement: "s",
        state_class: "measurement",
      }),
    );
    expect(components.lsh_device14_wifi_uptime).toEqual(
      expect.objectContaining({
        platform: "sensor",
        device_class: "duration",
        unit_of_measurement: "s",
        state_class: "measurement",
      }),
    );
    expect(components.lsh_device14_mqtt_uptime).toEqual(
      expect.objectContaining({
        platform: "sensor",
        device_class: "duration",
        unit_of_measurement: "s",
        state_class: "measurement",
      }),
    );
    expect(components.lsh_device14_free_heap).toEqual(
      expect.objectContaining({
        platform: "sensor",
        device_class: "data_size",
        unit_of_measurement: "B",
        state_class: "measurement",
      }),
    );
    expect(components.lsh_device14_stats_interval).toEqual(
      expect.objectContaining({
        platform: "sensor",
        unit_of_measurement: "s",
      }),
    );
    expect(components.lsh_device14_stats_interval).not.toHaveProperty("state_class");
    expect(components.lsh_device14_mqtt_inbound_dropped).toEqual(
      expect.objectContaining({
        platform: "sensor",
        state_class: "total_increasing",
      }),
    );
    expect(components.lsh_device14_mqtt_ack_dropped).toEqual(
      expect.objectContaining({
        platform: "sensor",
        state_class: "total_increasing",
      }),
    );
  });

  it("debounces retained Homie metadata bursts into one complete discovery publication", () => {
    const deviceId = "device13";
    const description = buildHomieV5Description({ led: { settable: true } });

    const descriptionResult = manager.processDiscoveryMessage(
      deviceId,
      "/$description",
      description,
    );
    const macResult = manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:13");
    const firmwareResult = manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.3.0");

    expect(descriptionResult.messages[Output.Lsh]).toBeUndefined();
    expect(macResult.messages[Output.Lsh]).toBeUndefined();
    expect(firmwareResult.messages[Output.Lsh]).toBeUndefined();
    expect(descriptionResult.discoveryFlushDelayMs).toBe(250);
    expect(macResult.discoveryFlushDelayMs).toBe(250);
    expect(firmwareResult.discoveryFlushDelayMs).toBe(250);

    const flushed = manager.flushPendingDiscovery();
    const messages = getDiscoveryMessages(flushed.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device13/config");

    expect(messages).toHaveLength(2);
    expect(flushed.logs).toEqual([
      "Generated HA device discovery config for device13 (2 messages)",
    ]);
    expect(deviceMessage.payload.device.connections).toEqual([["mac", "AA:BB:CC:DD:EE:13"]]);
    expect(deviceMessage.payload.device.sw_version).toBe("1.3.0");
  });

  it("does not require optional fork metadata before publishing discovery", () => {
    const result = publishDescription("standards-device", {
      relay: { settable: true },
    });
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(
      messages,
      "homeassistant/device/lsh_standards-device/config",
    );

    expect(deviceMessage.payload.device.name).toBe("Kitchen Board");
    expect(deviceMessage.payload.device.connections).toBeUndefined();
    expect(deviceMessage.payload.device.sw_version).toBeUndefined();
  });

  it("maps read-only boolean state to binary sensors and non-boolean state to sensors", () => {
    const result = publishDescription("device02", {
      door: { datatype: "boolean", settable: false },
      voltage: { datatype: "float" },
    });
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device02/config");

    expect(deviceMessage.payload.components?.lsh_device02_door).toEqual(
      expect.objectContaining({
        platform: "binary_sensor",
        state_topic: "homie/5/device02/door/state",
        payload_on: "true",
        payload_off: "false",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device02_door).not.toHaveProperty("command_topic");

    expect(deviceMessage.payload.components?.lsh_device02_voltage).toEqual(
      expect.objectContaining({
        platform: "sensor",
        state_topic: "homie/5/device02/voltage/state",
      }),
    );
  });

  it("uses Homie v5 datatype, format, unit and retained metadata for richer HA entities", () => {
    const result = publishDescription("device12", {
      mode: { datatype: "enum", settable: true, format: "auto,manual,off" },
      threshold: { datatype: "float", settable: true, format: "0:100:0.5", unit: "%" },
      label: { datatype: "string", settable: true },
      temperature: { datatype: "float", unit: "°C" },
      pulse: { datatype: "boolean", retained: false },
    });
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device12/config");

    expect(deviceMessage.payload.components?.lsh_device12_mode).toEqual(
      expect.objectContaining({
        platform: "select",
        command_topic: "homie/5/device12/mode/state/set",
        options: ["auto", "manual", "off"],
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device12_threshold).toEqual(
      expect.objectContaining({
        platform: "number",
        command_topic: "homie/5/device12/threshold/state/set",
        mode: "box",
        min: 0,
        max: 100,
        step: 0.5,
        unit_of_measurement: "%",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device12_label).toEqual(
      expect.objectContaining({
        platform: "text",
        command_topic: "homie/5/device12/label/state/set",
        mode: "text",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device12_temperature).toEqual(
      expect.objectContaining({
        platform: "sensor",
        state_class: "measurement",
        unit_of_measurement: "°C",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device12_pulse).toEqual(
      expect.objectContaining({
        platform: "binary_sensor",
        force_update: true,
      }),
    );
  });

  it("is idempotent for unchanged descriptions and regenerates when optional metadata changes", () => {
    const deviceId = "device03";
    const description = buildHomieV5Description({ led: { settable: true } });

    expect(
      manager.processDiscoveryMessage(deviceId, "/$description", description).messages[Output.Lsh],
    ).toBeUndefined();
    expect(manager.flushPendingDiscovery().messages[Output.Lsh]).toBeDefined();

    const repeated = manager.processDiscoveryMessage(deviceId, "/$description", description);
    const firmware = manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.1");
    const flushed = manager.flushPendingDiscovery();
    const messages = getDiscoveryMessages(flushed.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device03/config");

    expect(repeated.messages[Output.Lsh]).toBeUndefined();
    expect(repeated.logs).toEqual([]);
    expect(firmware.messages[Output.Lsh]).toBeUndefined();
    expect(deviceMessage.payload.device.sw_version).toBe("1.0.1");
  });

  it("warns when the advertised effective Homie root differs from the node config", () => {
    const result = manager.processDiscoveryMessage(
      "device11",
      "/$implementation/config",
      JSON.stringify({ mqtt: { base_topic: "homie/", effective_base_topic: "custom/5/" } }),
    );

    expect(result.warnings).toContain(
      "Homie device 'device11' advertises effective_base_topic='custom/5/', but this node is configured for homieBasePath='homie/5/'.",
    );
  });

  it("rejects malformed or non-v5 descriptions without corrupting existing discovery", () => {
    manager.processDiscoveryMessage(
      "device04",
      "/$description",
      buildHomieV5Description({ relay: { settable: true } }),
    );

    const malformed = manager.processDiscoveryMessage("device04", "/$description", "{");
    const wrongConvention = manager.processDiscoveryMessage(
      "device04",
      "/$description",
      JSON.stringify({ homie: "4.0", version: 4, name: "Wrong", nodes: {} }),
    );
    const noState = manager.processDiscoveryMessage(
      "device04",
      "/$description",
      buildHomieV5Description({ metadata: { includeState: false } }),
    );
    const regenerated = manager.regenerateDiscoveryPayloads();
    const messages = getDiscoveryMessages(regenerated.messages[Output.Lsh]);

    expect(malformed.warnings).toContain(
      "Ignored Homie v5 $description for 'device04' because it is not valid JSON.",
    );
    expect(wrongConvention.warnings).toContain(
      "Ignored Homie $description for 'device04' because homie='4.0' is not supported; expected '5.0'.",
    );
    expect(noState.warnings).toContain(
      "Ignored Homie v5 $description for 'device04' because it contains no valid state properties.",
    );
    expect(
      getMessageByTopic(messages, "homeassistant/device/lsh_device04/config").payload.components,
    ).toHaveProperty("lsh_device04_relay");
  });

  it("emits a component-removal update before the final payload when the node list shrinks", () => {
    const deviceId = "device05";

    publishDescription(deviceId, {
      led: { settable: true },
      relay: { settable: true },
    });

    const ignored = manager.processDiscoveryMessage(deviceId, "/$localip", "192.168.1.5");
    const changed = publishDescription(deviceId, {
      led: { settable: true },
    });
    const messages = getDiscoveryMessages(changed.messages[Output.Lsh]);
    const deviceMessages = messages.filter(
      (message) => message.topic === "homeassistant/device/lsh_device05/config",
    );

    expect(ignored.messages[Output.Lsh]).toBeUndefined();
    expect(ignored.logs).toEqual([]);
    expect(messages).toHaveLength(3);
    expect(deviceMessages).toHaveLength(2);
    expect(deviceMessages[0].payload.components?.lsh_device05_relay).toEqual({
      platform: "light",
    });
    expect(deviceMessages[1].payload.components).not.toHaveProperty("lsh_device05_relay");
  });

  it("applies config-driven platform and naming overrides for actuator discovery", () => {
    const deviceId = "device07";

    manager.setDiscoveryConfig(
      new Map([
        [
          deviceId,
          {
            name: deviceId,
            haDiscovery: {
              deviceName: "Configured Board",
              defaultPlatform: "switch",
              nodes: {
                relay: {
                  platform: "fan",
                  name: "Kitchen Extractor",
                  defaultEntityId: "fan.kitchen_extractor",
                },
              },
            },
          },
        ],
      ]),
    );

    const result = publishDescription(deviceId, {
      led: { settable: true },
      relay: { settable: true },
    });

    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device07/config");

    expect(deviceMessage.payload.device.name).toBe("Configured Board");
    expect(deviceMessage.payload.components?.lsh_device07_led).toEqual(
      expect.objectContaining({
        platform: "switch",
        default_entity_id: "switch.lsh_device07_led",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device07_relay).toEqual(
      expect.objectContaining({
        platform: "fan",
        name: "Kitchen Extractor",
        default_entity_id: "fan.kitchen_extractor",
      }),
    );
  });

  it("emits a removal update before switching a component platform", () => {
    const deviceId = "device08";

    publishDescription(deviceId, { relay: { settable: true } });
    manager.setDiscoveryConfig(
      new Map([
        [
          deviceId,
          {
            name: deviceId,
            haDiscovery: {
              nodes: {
                relay: {
                  platform: "switch",
                },
              },
            },
          },
        ],
      ]),
    );

    const result = manager.regenerateDiscoveryPayloads();
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessages = messages.filter(
      (message) => message.topic === "homeassistant/device/lsh_device08/config",
    );

    expect(deviceMessages).toHaveLength(2);
    expect(deviceMessages[0].payload.components?.lsh_device08_relay).toEqual({
      platform: "light",
    });
    expect(deviceMessages[1].payload.components?.lsh_device08_relay).toEqual(
      expect.objectContaining({
        platform: "switch",
      }),
    );
  });

  it("validates configured override ids with Homie v5 node syntax", () => {
    expect(() =>
      manager.setDiscoveryConfig(
        new Map([
          [
            "device09",
            {
              name: "device09",
              haDiscovery: {
                nodes: {
                  relay: { platform: "switch" },
                  Relay: { platform: "fan" },
                },
              },
            },
          ],
        ]),
      ),
    ).toThrow(/not a valid Homie v5 node id/);

    expect(() =>
      manager.setDiscoveryConfig(
        new Map([
          [
            "device09",
            {
              name: "device09",
              haDiscovery: {
                nodes: {
                  bad_node: {
                    platform: "switch",
                  },
                },
              },
            },
          ],
        ]),
      ),
    ).toThrow(/not a valid Homie v5 node id/);
  });

  it("publishes retained cleanup messages when configured devices disappear", () => {
    manager.setDiscoveryConfig(new Map([["device09", { name: "device09" }]]));
    publishDescription("device09", { relay: { settable: true } });

    manager.setDiscoveryConfig(new Map());
    const regenerated = manager.regenerateDiscoveryPayloads();
    const messages = Array.isArray(regenerated.messages[Output.Lsh])
      ? regenerated.messages[Output.Lsh]
      : regenerated.messages[Output.Lsh]
        ? [regenerated.messages[Output.Lsh]]
        : [];

    expect(messages).toEqual([
      expect.objectContaining({
        topic: "homeassistant/device/lsh_device09/config",
        payload: "",
        qos: 1,
        retain: true,
      }),
      expect.objectContaining({
        topic: "homeassistant/sensor/lsh_device09_homie_state/config",
        payload: "",
        qos: 1,
        retain: true,
      }),
    ]);
  });

  it("prunes stale wildcard discovery state after the retention window", () => {
    publishDescription("wildcard-device", { relay: { settable: true } });

    now += UNCONFIGURED_DISCOVERY_STATE_TTL_MS + 1;
    const regenerated = manager.regenerateDiscoveryPayloads();
    const messages = Array.isArray(regenerated.messages[Output.Lsh])
      ? regenerated.messages[Output.Lsh]
      : regenerated.messages[Output.Lsh]
        ? [regenerated.messages[Output.Lsh]]
        : [];

    expect(messages).toEqual([
      expect.objectContaining({
        topic: "homeassistant/device/lsh_wildcard-device/config",
        payload: "",
        qos: 1,
        retain: true,
      }),
      expect.objectContaining({
        topic: "homeassistant/sensor/lsh_wildcard-device_homie_state/config",
        payload: "",
        qos: 1,
        retain: true,
      }),
    ]);
  });

  it("cancels pending cleanup when a wildcard device reappears", () => {
    publishDescription("wildcard-device", { relay: { settable: true } });

    now += UNCONFIGURED_DISCOVERY_STATE_TTL_MS + 1;
    publishDescription("wildcard-device", { relay: { settable: true } });

    const regenerated = manager.regenerateDiscoveryPayloads();
    const messages = getDiscoveryMessages(regenerated.messages[Output.Lsh]);

    expect(messages).toHaveLength(2);
    expect(messages).toEqual([
      expect.objectContaining({
        topic: "homeassistant/device/lsh_wildcard-device/config",
        payload: expect.any(Object),
        qos: 1,
        retain: true,
      }),
      expect.objectContaining({
        topic: "homeassistant/sensor/lsh_wildcard-device_homie_state/config",
        payload: expect.any(Object),
        qos: 1,
        retain: true,
      }),
    ]);
  });

  it("keeps the published discovery origin version aligned with package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as { version: string };

    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });

  it("resets both discovery overrides and discovery state", () => {
    manager.setDiscoveryConfig(new Map([["device10", { name: "device10" }]]));
    publishDescription("device10", { relay: { settable: true } });

    manager.reset();
    const regenerated = manager.regenerateDiscoveryPayloads();

    expect(regenerated.messages[Output.Lsh]).toBeUndefined();
  });
});
