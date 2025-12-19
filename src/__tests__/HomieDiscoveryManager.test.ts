/**
 * @file Unit tests for the HomieDiscoveryManager class.
 */
import { HomieDiscoveryManager } from "../HomieDiscoveryManager";
import { Output, ServiceResult } from "../types";
import { NodeMessage } from "node-red";

describe("HomieDiscoveryManager", () => {
    let manager: HomieDiscoveryManager;
    const homieBasePath = "homie/";
    const discoveryPrefix = "homeassistant";

    beforeEach(() => {
        manager = new HomieDiscoveryManager(homieBasePath, discoveryPrefix);
    });

    it("should accumulate state and generate discovery payloads when all data is present", () => {
        const deviceId = "device01"; // Lowercase for safety checks usually
        // 1. Send MAC
        let result = manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
        expect(result.messages[Output.Lsh]).toBeUndefined();

        // 2. Send FW Version
        result = manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
        expect(result.messages[Output.Lsh]).toBeUndefined();

        // 3. Send Nodes (Lights only for now)
        // This should trigger generation
        result = manager.processDiscoveryMessage(deviceId, "/$nodes", "light1,light2");
        expect(result.messages[Output.Lsh]).toBeDefined();

        const messages = result.messages[Output.Lsh] as NodeMessage[];
        expect(messages.length).toBeGreaterThan(0);

        // Check for Light Configs
        const lightConfig = messages.find((m: any) => m.topic.includes("/light/lsh_device01_light1/config"));
        expect(lightConfig).toBeDefined();
        expect(lightConfig!.payload).toHaveProperty("default_entity_id", "light.lsh_device01_light1");
        expect(lightConfig!.payload).toHaveProperty("origin");

        // Check for Sensor Configs
        const sensorConfig = messages.find((m: any) => m.topic.includes("/sensor/lsh_device01_mac_address/config"));
        expect(sensorConfig).toBeDefined();
        expect(sensorConfig!.payload).toHaveProperty("entity_category", "diagnostic");
    });

    it("should be idempotent and not regenerate config if data hasn't changed", () => {
        const deviceId = "device02";

        // Initial setup
        manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
        manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
        const result1 = manager.processDiscoveryMessage(deviceId, "/$nodes", "led");

        expect(result1.messages[Output.Lsh]).toBeDefined();

        // Resend same data
        const result2 = manager.processDiscoveryMessage(deviceId, "/$nodes", "led");
        const result3 = manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");

        expect(result2.messages[Output.Lsh]).toBeUndefined();
        expect(result3.messages[Output.Lsh]).toBeUndefined();
        expect(result3.messages[Output.Lsh]).toBeUndefined();
        // Expect no logs or up-to-date log if logic permits, but here it likely returns early.
        // So we just expect no valid messages.
        expect(result3.stateChanged).toBe(false);
    });

    it("should regenerate config if data changes", () => {
        const deviceId = "device03";

        manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
        manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
        manager.processDiscoveryMessage(deviceId, "/$nodes", "led");

        // Update FW version
        const result = manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.1");

        expect(result.messages[Output.Lsh]).toBeDefined();
        const msgs = result.messages[Output.Lsh] as NodeMessage[];
        // Verify payload contains new version
        const ledMsg = msgs.find((m: any) => m.topic.includes("/light/"));
        expect((ledMsg!.payload as any).device.sw_version).toBe("1.0.1");
    });

    it("should handle mixed case device IDs and node names gracefully", () => {
        const deviceId = "MyDevice";

        manager.processDiscoveryMessage(deviceId, "/$mac", "AA:BB:CC:DD:EE:FF");
        manager.processDiscoveryMessage(deviceId, "/$fw/version", "1.0.0");
        const result = manager.processDiscoveryMessage(deviceId, "/$nodes", "KitchenLight");

        const msgs = result.messages[Output.Lsh] as NodeMessage[];
        const configMsg = msgs.find((m: any) => m.topic.includes("lsh_mydevice_kitchenlight"));

        expect(configMsg).toBeDefined();
        expect((configMsg!.payload as any).unique_id).toBe("lsh_mydevice_kitchenlight");
        expect((configMsg!.payload as any).name).toBe("MYDEVICE KITCHENLIGHT");
    });
});
