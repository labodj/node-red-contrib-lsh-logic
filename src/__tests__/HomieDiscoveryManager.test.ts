/**
 * @file Unit tests for the HomieDiscoveryManager class.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { HomieDiscoveryManager } from "../HomieDiscoveryManager";
import { Output } from "../types";
import { PACKAGE_VERSION } from "../version";
import type { NodeMessage } from "node-red";

type DiscoveryPlatform = "light" | "switch" | "fan" | "sensor" | "binary_sensor";
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
};

type DiscoveryPayload = {
  device: {
    sw_version: string;
    name?: string;
  };
  origin: {
    sw_version: string;
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
  let now: number;
  const homieBasePath = "homie/";
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

  const markNodeStateMetadata = (
    deviceId: string,
    nodeId: string,
    { datatype, settable }: { datatype?: string; settable?: boolean },
  ): void => {
    if (datatype !== undefined) {
      manager.processDiscoveryMessage(deviceId, `/${nodeId}/state/$datatype`, datatype);
    }
    if (settable !== undefined) {
      manager.processDiscoveryMessage(
        deviceId,
        `/${nodeId}/state/$settable`,
        settable ? "true" : "false",
      );
    }
  };

  const markWritableBooleanNodes = (deviceId: string, ...nodeIds: string[]): void => {
    for (const nodeId of nodeIds) {
      markNodeStateMetadata(deviceId, nodeId, { datatype: "boolean", settable: true });
    }
  };

  it("should accumulate state and generate a device discovery payload when all data is present", () => {
    const deviceId = "device01";

    expect(
      manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF").messages[Output.Lsh],
    ).toBeUndefined();
    expect(
      manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0").messages[Output.Lsh],
    ).toBeUndefined();
    markWritableBooleanNodes(deviceId, "light1", "light2");

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
    expect(deviceMessage.payload.origin.sw_version).toBe(PACKAGE_VERSION);

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
    expect(deviceMessage.payload.components).not.toHaveProperty("lsh_device01_ota_state");

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

  it("should defer discovery publication until retained node metadata settles", () => {
    const deviceId = "device01defer";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");

    const nodesResult = manager.processDiscoveryMessage(deviceId, "/$nodes", "relay");
    expect(nodesResult.messages[Output.Lsh]).toBeUndefined();
    expect(nodesResult.discoveryFlushDelayMs).toBeGreaterThan(0);

    const datatypeResult = manager.processDiscoveryMessage(
      deviceId,
      "/relay/state/$datatype",
      "boolean",
    );
    expect(datatypeResult.messages[Output.Lsh]).toBeUndefined();

    const settableResult = manager.processDiscoveryMessage(
      deviceId,
      "/relay/state/$settable",
      "true",
    );
    expect(settableResult.messages[Output.Lsh]).toBeUndefined();

    now += 149;
    expect(manager.flushPendingDiscovery().messages[Output.Lsh]).toBeUndefined();

    now += 1;
    const flushed = manager.flushPendingDiscovery();
    const messages = getDiscoveryMessages(flushed.messages[Output.Lsh]);

    expect(messages).toHaveLength(2);
    expect(
      getMessageByTopic(messages, "homeassistant/device/lsh_device01defer/config"),
    ).toBeDefined();
    expect(
      getMessageByTopic(messages, "homeassistant/sensor/lsh_device01defer_homie_state/config"),
    ).toBeDefined();
  });

  it("should expose read-only boolean state nodes as binary sensors without a command topic", () => {
    const deviceId = "device01b";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markNodeStateMetadata(deviceId, "door", { datatype: "boolean", settable: false });

    const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "door");
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device01b/config");

    expect(deviceMessage.payload.components?.lsh_device01b_door).toEqual(
      expect.objectContaining({
        platform: "binary_sensor",
        state_topic: "homie/device01b/door/state",
        payload_on: "true",
        payload_off: "false",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01b_door).not.toHaveProperty(
      "command_topic",
    );
  });

  it("should expose non-boolean state nodes as plain sensors without a command topic", () => {
    const deviceId = "device01c";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markNodeStateMetadata(deviceId, "temperature", { datatype: "float" });

    const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "temperature");
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device01c/config");

    expect(deviceMessage.payload.components?.lsh_device01c_temperature).toEqual(
      expect.objectContaining({
        platform: "sensor",
        state_topic: "homie/device01c/temperature/state",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device01c_temperature).not.toHaveProperty(
      "command_topic",
    );
  });

  it("should be idempotent and not regenerate config if data has not changed", () => {
    const deviceId = "device02";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markWritableBooleanNodes(deviceId, "led");

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
    markWritableBooleanNodes(deviceId, "led");
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
    markWritableBooleanNodes(deviceId, "led");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "led");

    const repeatedFirmware = manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");

    expect(repeatedFirmware.messages[Output.Lsh]).toBeUndefined();
    expect(repeatedFirmware.logs).toEqual([]);
  });

  it("should normalize mixed-case device IDs and node names into stable component ids", () => {
    const deviceId = "MyDevice";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markWritableBooleanNodes(deviceId, "KitchenLight");
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
    defaultPrefixManager.processDiscoveryMessage(deviceId, "/light1/state/$datatype", "boolean");
    defaultPrefixManager.processDiscoveryMessage(deviceId, "/light1/state/$settable", "true");
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

  it("should trim valid node IDs and warn when invalid $nodes entries are discarded", () => {
    const deviceId = "device04b";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markWritableBooleanNodes(deviceId, "relay", "KitchenLight", "valid_2");
    const result = manager.processDiscoveryMessage(
      deviceId,
      "/$nodes",
      " relay ,bad node,@oops,KitchenLight,valid_2,topic/evil ",
    );

    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device04b/config");

    expect(result.warnings).toContain(
      "Ignored invalid Homie node id(s) for 'device04b': bad node, @oops, topic/evil.",
    );
    expect(deviceMessage.payload.components).toHaveProperty("lsh_device04b_relay");
    expect(deviceMessage.payload.components).toHaveProperty("lsh_device04b_kitchenlight");
    expect(deviceMessage.payload.components).toHaveProperty("lsh_device04b_valid_2");
    expect(deviceMessage.payload.components).not.toHaveProperty("lsh_device04b_bad node");
    expect(deviceMessage.payload.components?.lsh_device04b_relay).toEqual(
      expect.objectContaining({
        state_topic: "homie/device04b/relay/state",
        command_topic: "homie/device04b/relay/state/set",
      }),
    );
  });

  it("should ignore empty or fully invalid $nodes payloads without removing existing actuator discovery", () => {
    const deviceId = "device04c";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markWritableBooleanNodes(deviceId, "relay");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "relay");

    const malformed = manager.processDiscoveryMessage(deviceId, "/$nodes", "bad node,@oops");
    const empty = manager.processDiscoveryMessage(deviceId, "/$nodes", "   ,  ");
    const regenerated = manager.regenerateDiscoveryPayloads();
    const regeneratedMessages = getDiscoveryMessages(regenerated.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(
      regeneratedMessages,
      "homeassistant/device/lsh_device04c/config",
    );

    expect(malformed.messages[Output.Lsh]).toBeUndefined();
    expect(malformed.warnings).toEqual([
      "Ignored invalid Homie node id(s) for 'device04c': bad node, @oops.",
      "Ignored Homie $nodes payload for 'device04c' because it contained no valid node ids.",
    ]);
    expect(empty.messages[Output.Lsh]).toBeUndefined();
    expect(empty.warnings).toEqual([
      "Ignored Homie $nodes payload for 'device04c' because it contained no valid node ids.",
    ]);
    expect(deviceMessage.payload.components).toHaveProperty("lsh_device04c_relay");
  });

  it("should canonicalize $nodes ordering and duplicates to avoid redundant discovery regeneration", () => {
    const deviceId = "device04d";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markWritableBooleanNodes(deviceId, "relay", "lamp");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "relay,lamp");

    const reordered = manager.processDiscoveryMessage(deviceId, "/$nodes", "lamp,relay,relay");

    expect(reordered.messages[Output.Lsh]).toBeUndefined();
    expect(reordered.warnings).toEqual([]);
  });

  it("should emit a component-removal update before the final payload when the node list shrinks", () => {
    const deviceId = "device05";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markWritableBooleanNodes(deviceId, "led", "relay");
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
    markWritableBooleanNodes(deviceId, "led");
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

  it("should apply config-driven platform and naming overrides for actuator discovery", () => {
    const deviceId = "device07";

    manager.setDiscoveryConfig(
      new Map([
        [
          deviceId,
          {
            name: deviceId,
            haDiscovery: {
              deviceName: "Kitchen Board",
              defaultPlatform: "switch",
              nodes: {
                "2": {
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

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markWritableBooleanNodes(deviceId, "1", "2");
    const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "1,2");

    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const deviceMessage = getMessageByTopic(messages, "homeassistant/device/lsh_device07/config");

    expect(deviceMessage.payload.device.name).toBe("Kitchen Board");
    expect(deviceMessage.payload.components?.lsh_device07_1).toEqual(
      expect.objectContaining({
        platform: "switch",
        name: "DEVICE07 1",
        default_entity_id: "switch.lsh_device07_1",
      }),
    );
    expect(deviceMessage.payload.components?.lsh_device07_2).toEqual(
      expect.objectContaining({
        platform: "fan",
        name: "Kitchen Extractor",
        default_entity_id: "fan.kitchen_extractor",
      }),
    );
  });

  it("should emit a removal update before switching a component platform", () => {
    const deviceId = "device08";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    markWritableBooleanNodes(deviceId, "1");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "1");

    manager.setDiscoveryConfig(
      new Map([
        [
          deviceId,
          {
            name: deviceId,
            haDiscovery: {
              nodes: {
                "1": {
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
    expect(deviceMessages[0].payload.components?.lsh_device08_1).toEqual({
      platform: "light",
    });
    expect(deviceMessages[1].payload.components?.lsh_device08_1).toEqual(
      expect.objectContaining({
        platform: "switch",
      }),
    );
  });

  it("should reject discovery override node ids that collide case-insensitively", () => {
    expect(() =>
      manager.setDiscoveryConfig(
        new Map([
          [
            "device09",
            {
              name: "device09",
              haDiscovery: {
                nodes: {
                  Relay: {
                    platform: "switch",
                  },
                  relay: {
                    platform: "fan",
                  },
                },
              },
            },
          ],
        ]),
      ),
    ).toThrow(/collide after case-insensitive normalization/);
  });

  it("should reject discovery override node ids that are not valid Homie node ids", () => {
    expect(() =>
      manager.setDiscoveryConfig(
        new Map([
          [
            "device09",
            {
              name: "device09",
              haDiscovery: {
                nodes: {
                  "bad node": {
                    platform: "switch",
                  },
                },
              },
            },
          ],
        ]),
      ),
    ).toThrow(/not a valid Homie node id/);
  });

  it("should reject configured device ids that collide after lowercase normalization", () => {
    expect(() =>
      manager.setDiscoveryConfig(
        new Map([
          ["Foo", { name: "Foo" }],
          ["foo", { name: "foo" }],
        ]),
      ),
    ).toThrow(/collide after case-insensitive normalization/);
  });

  it("prunes discovery state for devices removed from configured overrides", () => {
    manager.setDiscoveryConfig(
      new Map([
        [
          "device09",
          {
            name: "device09",
            haDiscovery: {
              deviceName: "Configured Device",
            },
          },
        ],
      ]),
    );

    manager.processDiscoveryMessage("device09", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("device09", "/$fw/version", "1.0.0");
    markWritableBooleanNodes("device09", "relay");
    manager.processDiscoveryMessage("device09", "/$nodes", "relay");

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

  it("keeps the published discovery origin version aligned with package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as { version: string };

    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });

  it("prunes stale wildcard discovery state after the retention window", () => {
    manager.processDiscoveryMessage("wildcard-device", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("wildcard-device", "/$fw/version", "1.0.0");
    markWritableBooleanNodes("wildcard-device", "relay");
    manager.processDiscoveryMessage("wildcard-device", "/$nodes", "relay");

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

  it("cancels pending cleanup when a wildcard device reappears before cleanup is flushed", () => {
    manager.processDiscoveryMessage("wildcard-device", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("wildcard-device", "/$fw/version", "1.0.0");
    markWritableBooleanNodes("wildcard-device", "relay");
    manager.processDiscoveryMessage("wildcard-device", "/$nodes", "relay");

    now += UNCONFIGURED_DISCOVERY_STATE_TTL_MS + 1;
    manager.processDiscoveryMessage("wildcard-device", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("wildcard-device", "/$fw/version", "1.1.0");
    markWritableBooleanNodes("wildcard-device", "relay");
    manager.processDiscoveryMessage("wildcard-device", "/$nodes", "relay");

    const regenerated = manager.regenerateDiscoveryPayloads();
    const messages = Array.isArray(regenerated.messages[Output.Lsh])
      ? regenerated.messages[Output.Lsh]
      : regenerated.messages[Output.Lsh]
        ? [regenerated.messages[Output.Lsh]]
        : [];

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

  it("cancels pending cleanup when a wildcard device reappears with only a case change", () => {
    manager.processDiscoveryMessage("Foo", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("Foo", "/$fw/version", "1.0.0");
    markWritableBooleanNodes("Foo", "relay");
    manager.processDiscoveryMessage("Foo", "/$nodes", "relay");

    now += UNCONFIGURED_DISCOVERY_STATE_TTL_MS + 1;
    manager.processDiscoveryMessage("foo", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("foo", "/$fw/version", "1.1.0");
    markWritableBooleanNodes("foo", "relay");
    manager.processDiscoveryMessage("foo", "/$nodes", "relay");

    const regenerated = manager.regenerateDiscoveryPayloads();
    const messages = Array.isArray(regenerated.messages[Output.Lsh])
      ? regenerated.messages[Output.Lsh]
      : regenerated.messages[Output.Lsh]
        ? [regenerated.messages[Output.Lsh]]
        : [];

    expect(messages).toHaveLength(2);
    expect(messages).toEqual([
      expect.objectContaining({
        topic: "homeassistant/device/lsh_foo/config",
        payload: expect.objectContaining({
          availability_topic: "homie/foo/$state",
        }),
        qos: 1,
        retain: true,
      }),
      expect.objectContaining({
        topic: "homeassistant/sensor/lsh_foo_homie_state/config",
        payload: expect.objectContaining({
          state_topic: "homie/foo/$state",
        }),
        qos: 1,
        retain: true,
      }),
    ]);
  });

  it("treats wildcard devices that differ only by case as one canonical HA discovery target", () => {
    manager.processDiscoveryMessage("Foo", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("Foo", "/$fw/version", "1.0.0");
    markWritableBooleanNodes("Foo", "relay");
    manager.processDiscoveryMessage("Foo", "/$nodes", "relay");

    const updateResult = manager.processDiscoveryMessage("foo", "/$fw/version", "1.1.0");
    const messages = Array.isArray(updateResult.messages[Output.Lsh])
      ? updateResult.messages[Output.Lsh]
      : updateResult.messages[Output.Lsh]
        ? [updateResult.messages[Output.Lsh]]
        : [];

    expect(messages).toHaveLength(2);
    expect(messages).toEqual([
      expect.objectContaining({
        topic: "homeassistant/device/lsh_foo/config",
        payload: expect.objectContaining({
          availability_topic: "homie/foo/$state",
        }),
      }),
      expect.objectContaining({
        topic: "homeassistant/sensor/lsh_foo_homie_state/config",
        payload: expect.objectContaining({
          state_topic: "homie/foo/$state",
        }),
      }),
    ]);
  });

  it("retains configured devices without discovery overrides while pruning wildcard state", () => {
    manager.setDiscoveryConfig(
      new Map([
        [
          "device11",
          {
            name: "device11",
          },
        ],
      ]),
    );

    manager.processDiscoveryMessage("device11", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("device11", "/$fw/version", "1.0.0");
    markWritableBooleanNodes("device11", "relay");
    manager.processDiscoveryMessage("device11", "/$nodes", "relay");

    now += UNCONFIGURED_DISCOVERY_STATE_TTL_MS + 1;
    const regenerated = manager.regenerateDiscoveryPayloads();
    const messages = getDiscoveryMessages(regenerated.messages[Output.Lsh]);

    expect(getMessageByTopic(messages, "homeassistant/device/lsh_device11/config")).toBeDefined();
  });

  it("resets both discovery overrides and discovery state", () => {
    manager.setDiscoveryConfig(
      new Map([
        [
          "device10",
          {
            name: "device10",
            haDiscovery: {
              deviceName: "Configured Device",
            },
          },
        ],
      ]),
    );

    manager.processDiscoveryMessage("device10", "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage("device10", "/$fw/version", "1.0.0");
    markWritableBooleanNodes("device10", "relay");
    manager.processDiscoveryMessage("device10", "/$nodes", "relay");

    manager.reset();
    const regenerated = manager.regenerateDiscoveryPayloads();

    expect(regenerated.messages[Output.Lsh]).toBeUndefined();
  });
});
