/**
 * @file Unit tests for the HomieDiscoveryManager class.
 */
import { HomieDiscoveryManager } from "../HomieDiscoveryManager";
import { Output } from "../types";
import type { NodeMessage } from "node-red";

type DiscoveryPayload = {
  unique_id: string;
  name: string;
  default_entity_id?: string;
  entity_category?: string;
  origin?: unknown;
  device: {
    sw_version: string;
  };
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

  it("should accumulate state and generate discovery payloads when all data is present", () => {
    const deviceId = "device01";

    expect(
      manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF").messages[Output.Lsh],
    ).toBeUndefined();
    expect(
      manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0").messages[Output.Lsh],
    ).toBeUndefined();

    const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "light1,light2");
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);

    const lightConfig = messages.find((message) =>
      message.topic.includes("/light/lsh_device01_light1/config"),
    );
    expect(lightConfig?.payload.default_entity_id).toBe("light.lsh_device01_light1");
    expect(lightConfig?.payload.origin).toBeDefined();

    const sensorConfig = messages.find((message) =>
      message.topic.includes("/sensor/lsh_device01_mac_address/config"),
    );
    expect(sensorConfig?.payload.entity_category).toBe("diagnostic");
  });

  it("should be idempotent and not regenerate config if data hasn't changed", () => {
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

  it("should regenerate config if discovery data changes", () => {
    const deviceId = "device03";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "led");

    const result = manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.1");
    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const ledConfig = messages.find((message) => message.topic.includes("/light/"));

    expect(ledConfig?.payload.device.sw_version).toBe("1.0.1");
  });

  it("should normalize mixed-case device IDs and node names", () => {
    const deviceId = "MyDevice";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "KitchenLight");

    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const configMessage = messages.find((message) =>
      message.topic.includes("lsh_mydevice_kitchenlight"),
    );

    expect(configMessage?.payload.unique_id).toBe("lsh_mydevice_kitchenlight");
    expect(configMessage?.payload.name).toBe("MYDEVICE KITCHENLIGHT");
  });

  it("should use the default discovery prefix and ignore empty node names", () => {
    const defaultPrefixManager = new HomieDiscoveryManager(homieBasePath);
    const deviceId = "device04";

    defaultPrefixManager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    defaultPrefixManager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    const result = defaultPrefixManager.processDiscoveryMessage(deviceId, "/$nodes", "light1,");

    const messages = getDiscoveryMessages(result.messages[Output.Lsh]);
    const lightTopics = messages.filter((message) => message.topic.includes("/light/"));

    expect(lightTopics).toHaveLength(1);
    expect(lightTopics[0].topic).toContain("homeassistant/light/lsh_device04_light1/config");
  });

  it("should ignore unsupported discovery attributes and regenerate when the node list changes", () => {
    const deviceId = "device05";

    manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
    manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
    manager.processDiscoveryMessage(deviceId, "/$nodes", "led");

    const ignored = manager.processDiscoveryMessage(deviceId, "/$localip", "192.168.1.5");
    const changed = manager.processDiscoveryMessage(deviceId, "/$nodes", "led,relay");

    expect(ignored.messages[Output.Lsh]).toBeUndefined();
    expect(ignored.logs).toEqual([]);
    expect(getDiscoveryMessages(changed.messages[Output.Lsh])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: expect.stringContaining("/light/lsh_device05_led/config"),
        }),
        expect.objectContaining({
          topic: expect.stringContaining("/light/lsh_device05_relay/config"),
        }),
      ]),
    );
  });
});
