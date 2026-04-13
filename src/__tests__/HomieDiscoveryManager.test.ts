/**
 * @file Unit tests for the HomieDiscoveryManager class.
 */
import { HomieDiscoveryManager } from "../HomieDiscoveryManager";
import { Output } from "../types";
import type { NodeMessage } from "node-red";

type DiscoveryPlatform = "light" | "sensor" | "binary_sensor";

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
};

type DiscoveryPayload = {
  device: {
    sw_version: string;
  };
  origin: {
    support_url: string;
  };
  availability_topic?: string;
  payload_available?: string;
  payload_not_available?: string;
  components?: Record<string, DiscoveryComponent>;
  name?: string;
  unique_id?: string;
  default_entity_id?: string;
  state_topic?: string;
  entity_category?: string;
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

describe("HomieDiscoveryManager", () => {
  let manager: HomieDiscoveryManager;
  const homieBasePath = "homie/";
  const discoveryPrefix = "homeassistant";

  beforeEach(() => {
    manager = new HomieDiscoveryManager(homieBasePath, discoveryPrefix);
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

  it("should accumulate state and generate a device discovery payload when all data is present", () => {
    const deviceId = "device01";

    expect(
      manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF").messages[Output.Lsh],
    ).toBeUndefined();
    expect(
      manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0").messages[Output.Lsh],
    ).toBeUndefined();

    const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "light1,light2");
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device01/config");
    const homieStateMessage = getMessageByTopic(
      messages,
      "homeassistant/sensor/lsh_device01_homie_state/config",
    );

    expect(messages).toHaveLength(2);
    expect(deviceMessage.payload).not.toHaveProperty("~");
    expect(deviceMessage.payload.availability_topic).toBe("homie/device01/$state");
    expect(deviceMessage.payload.payload_available).toBe("ready");
    expect(deviceMessage.payload.payload_not_available).toBe("lost");
    expect(deviceMessage.payload.origin.support_url).toBe(
      "https://github.com/labodj/node-red-contrib-lsh-logic",
    );

    expect(deviceMessage.payload.components?.lsh_device01_light1).toEqual(
      expect.objectContaining({
        platform: "light",
        name: "DEVICE01 LIGHT1",
        unique_id: "lsh_device01_light1",
        default_entity_id: "light.lsh_device01_light1",
        state_topic: "homie/device01/light1/state",
        command_topic: "homie/device01/light1/state/set",
        payload_on: "true",
        payload_off: "false",
      }),
    );

    expect(deviceMessage.payload.components?.lsh_device01_mac_address).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 MAC Address",
        unique_id: "lsh_device01_mac_address",
        entity_category: "diagnostic",
        state_topic: "homie/device01/$mac",
      }),
    );

    expect(deviceMessage.payload.components?.lsh_device01_uptime).toEqual(
      expect.objectContaining({
        platform: "sensor",
        name: "DEVICE01 Uptime",
        unique_id: "lsh_device01_uptime",
        state_topic: "homie/device01/$stats/uptime",
        device_class: "duration",
        unit_of_measurement: "s",
        state_class: "measurement",
      }),
    );

    expect(deviceMessage.payload.components?.lsh_device01_ota_enabled).toEqual(
      expect.objectContaining({
        platform: "binary_sensor",
        name: "DEVICE01 OTA Enabled",
        unique_id: "lsh_device01_ota_enabled",
        state_topic: "homie/device01/$implementation/ota/enabled",
        payload_on: "true",
        payload_off: "false",
      }),
    );

    expect(homieStateMessage.payload).toEqual(
      expect.objectContaining({
        name: "DEVICE01 Homie State",
        unique_id: "lsh_device01_homie_state",
        default_entity_id: "sensor.lsh_device01_homie_state",
        state_topic: "homie/device01/$state",
        entity_category: "diagnostic",
      }),
    );
    expect(homieStateMessage.payload).not.toHaveProperty("availability_topic");
  });

  it("should be idempotent and not regenerate config if data has not changed", () => {
    const deviceId = "device02";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");

    expect(
      manager.processDiscoveryMessage(deviceId, "/$nodes", "led").messages[Output.Lsh],
    ).toBeDefined();

    const repeatedNodes = manager.processDiscoveryMessage(deviceId, "/$nodes", "led");
    const repeatedMac = manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");

    expect(repeatedNodes.messages[Output.Lsh]).toBeUndefined();
    expect(repeatedMac.messages[Output.Lsh]).toBeUndefined();
    expect(repeatedMac.stateChanged).toBe(false);
  });

  it("should regenerate device discovery payload if discovery data changes", () => {
    const deviceId = "device03";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "led");

    const result = manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.1");
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device03/config");

    expect(messages).toHaveLength(2);
    expect(deviceMessage.payload.device.sw_version).toBe("1.0.1");
  });

  it("should ignore a repeated firmware version after discovery has already been generated", () => {
    const deviceId = "device03b";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "led");

    const repeatedFirmware = manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");

    expect(repeatedFirmware.messages[Output.Lsh]).toBeUndefined();
    expect(repeatedFirmware.logs).toEqual([]);
  });

  it("should normalize mixed-case device IDs and node names into stable component ids", () => {
    const deviceId = "MyDevice";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "KitchenLight");

    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_mydevice/config");

    expect(deviceMessage.payload.components?.lsh_mydevice_kitchenlight).toEqual(
      expect.objectContaining({
        platform: "light",
        unique_id: "lsh_mydevice_kitchenlight",
        name: "MYDEVICE KITCHENLIGHT",
      }),
    );
  });

  it("should use the default discovery prefix and ignore empty node names", () => {
    const defaultPrefixManager = new HomieDiscoveryManager(homieBasePath);
    const deviceId = "device04";

    defaultPrefixManager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    defaultPrefixManager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    const result = defaultPrefixManager.processDiscoveryMessage(deviceId, "/$nodes", "light1,");

    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device04/config");
    const lightComponents = Object.entries(deviceMessage.payload.components ?? {}).filter(
      ([, component]) => component.platform === "light",
    );

    expect(messages).toHaveLength(2);
    expect(lightComponents).toHaveLength(1);
    expect(lightComponents[0][0]).toBe("lsh_device04_light1");
  });

  it("should emit a component-removal update before the final payload when the node list shrinks", () => {
    const deviceId = "device05";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "led,relay");

    const ignored = manager.processDiscoveryMessage(deviceId, "/$localip", "192.168.1.5");
    const changed = manager.processDiscoveryMessage(deviceId, "/$nodes", "led");
    const messages = getDiscoveryMessages(changed.messages[Output.Lsh]);
    const deviceMessages = messages.filter(
      (message) => message.topic === "homeassistant/device/lsh_device05/config",
    );
    const homieStateMessage = getMessageByTopic(
      messages,
      "homeassistant/sensor/lsh_device05_homie_state/config",
    );

    expect(ignored.messages[Output.Lsh]).toBeUndefined();
    expect(ignored.logs).toEqual([]);
    expect(messages).toHaveLength(3);
    expect(deviceMessages).toHaveLength(2);

    expect(deviceMessages[0].payload.components?.lsh_device05_led).toEqual(
      expect.objectContaining({
        platform: "light",
        unique_id: "lsh_device05_led",
      }),
    );
    expect(deviceMessages[0].payload.components?.lsh_device05_relay).toEqual({
      platform: "light",
    });

    expect(deviceMessages[1].payload.components?.lsh_device05_led).toEqual(
      expect.objectContaining({
        platform: "light",
        unique_id: "lsh_device05_led",
      }),
    );
    expect(deviceMessages[1].payload.components).not.toHaveProperty("lsh_device05_relay");
    expect(homieStateMessage.payload.state_topic).toBe("homie/device05/$state");
  });

  it("should expand all device discovery topics instead of using the single-component '~' shorthand", () => {
    const deviceId = "device06";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "led");
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device06/config");
    const homieStateMessage = getMessageByTopic(
      messages,
      "homeassistant/sensor/lsh_device06_homie_state/config",
    );
    const componentTopics = Object.values(deviceMessage.payload.components ?? {})
      .flatMap((component) => [component.state_topic, component.command_topic])
      .filter((topic): topic is string => typeof topic === "string");

    expect(deviceMessage.payload).not.toHaveProperty("~");
    expect(deviceMessage.payload.availability_topic?.startsWith("~/")).toBe(false);
    expect(componentTopics.some((topic) => topic.startsWith("~/"))).toBe(false);
    expect(componentTopics).toContain("homie/device06/led/state");
    expect(componentTopics).toContain("homie/device06/led/state/set");
    expect(homieStateMessage.payload.state_topic).toBe("homie/device06/$state");
    expect(homieStateMessage.payload).not.toHaveProperty("availability_topic");
  });
});
