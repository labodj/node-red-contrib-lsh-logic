/**
 * @file Unit tests focussed on Watchdog Integration and Device Health for LshLogicService.
 * This covers health checks, ping strategies (broadcast vs staggered), and external
 * device status updates via Homie protocol or LSH boot notifications.
 */
import { ValidateFunction } from "ajv";
import { LshLogicService } from "../LshLogicService";
import {
    SystemConfig,
    LshProtocol,
    Output,
    DeviceBootPayload,
} from "../types";

// --- MOCK HELPERS ---
const createMockValidator = (): jest.Mock & ValidateFunction => {
    const mockFn = jest.fn().mockReturnValue(true);
    const validatorMock = mockFn as jest.Mock & ValidateFunction;
    validatorMock.errors = null;
    return validatorMock;
};

const mockContextReader = { get: jest.fn() };

const mockValidators = {
    validateSystemConfig: createMockValidator(),
    validateDeviceDetails: createMockValidator(),
    validateActuatorStates: createMockValidator(),
    validateAnyMiscTopic: createMockValidator(),
};

const mockServiceConfig = {
    lshBasePath: "LSH/",
    homieBasePath: "homie/",
    serviceTopic: "LSH/Node-RED/SRV",
    protocol: "json" as const,
    otherDevicesPrefix: "other_devices",
    clickTimeout: 5,
    interrogateThreshold: 3,
    pingTimeout: 5,
    haDiscovery: true,
    haDiscoveryPrefix: "homeassistant",
};

const mockSystemConfig: SystemConfig = {
    devices: [
        { name: "device-sender" },
        { name: "actor1" },
        { name: "device-silent" },
    ],
};

describe("LshLogicService - Watchdog & Health", () => {
    let service: LshLogicService;

    beforeEach(() => {
        jest.clearAllMocks();
        Object.values(mockValidators).forEach((v) => v.mockReturnValue(true));
        mockContextReader.get.mockClear();
        service = new LshLogicService(
            mockServiceConfig,
            mockContextReader,
            mockValidators,
        );
        service.updateSystemConfig(mockSystemConfig);
    });

    // --- HOMIE AVAILABILITY ---
    it("should request state on Homie 'ready' and create 'cameOnline' alert", () => {
        const result = service.processMessage("homie/actor1/$state", "ready");

        expect(result.stateChanged).toBe(true);
        expect(result.messages[Output.Lsh]).toBeInstanceOf(Array);
        const payloads = (result.messages[Output.Lsh] as any[]).map(
            (m) => m.payload.p,
        );
        expect(payloads).toContain(LshProtocol.REQUEST_DETAILS);
        expect(payloads).toContain(LshProtocol.REQUEST_STATE);

        expect(result.messages[Output.Alerts]).toBeDefined();
        const alertMsg = result.messages[Output.Alerts] as any;
        // It can be a single message or array.
        const payload = Array.isArray(alertMsg) ? alertMsg[0].payload : alertMsg.payload;
        expect(payload.message).toContain("back online");
    });

    it("should create 'wentOffline' alert on Homie 'lost'", () => {
        service.processMessage("homie/actor1/$state", "ready"); // Bring it online first
        const result = service.processMessage("homie/actor1/$state", "lost");
        expect(result.messages[Output.Alerts]).toBeDefined();
        const alertMsg = result.messages[Output.Alerts] as any;
        const payload = Array.isArray(alertMsg) ? alertMsg[0].payload : alertMsg.payload;
        expect(payload.message).toContain("Alert");
    });

    // --- WATCHDOG CHECKS ---
    it("should handle watchdog 'needs_ping' status", () => {
        jest.spyOn((service as any).watchdog, "checkDeviceHealth").mockReturnValue({ status: "needs_ping" });

        const result = service.runWatchdogCheck();
        expect(result.messages[Output.Lsh]).toBeDefined();
        const payload = (result.messages[Output.Lsh] as any).payload; // Single payload because strictly 1 device mocked return?
        // Note: runWatchdogCheck iterates all devices. If we mock checkDeviceHealth to always return needs_ping,
        // it will collect all of them.

        // Actually, if multiple devices need ping, they are aggregated.
        // Let's verify the payload type (PING) 
        expect(payload.p).toBe(LshProtocol.PING);
    });

    it("should handle watchdog 'stale' status", () => {
        const healthSpy = jest.spyOn((service as any).watchdog, "checkDeviceHealth");
        healthSpy.mockReturnValueOnce({ status: "stale" }); // device-sender
        // others will return undefined or default if not mocked per call, assuming subsequent calls follow mock logic or default.
        // But since we used mockReturnValueOnce, others might fail if we don't handle them.
        // Safest is to rely on the Loop.

        // Let's force specific behavior for specific devices if possible, or just accept the first one triggers 'stale'.
        const result = service.runWatchdogCheck();

        // Check stale
        expect(result.messages[Output.Alerts]).toBeDefined();
    });

    it("should skip device health check if skip alerted is true", () => {
        const configOneDev = { devices: [{ name: "dev1" }] };
        service.updateSystemConfig(configOneDev);

        // Ensure device exists in registry by setting it momentarily to ready
        (service as any).deviceManager.updateConnectionState("dev1", "ready");

        // Now set it to lost
        (service as any).deviceManager.updateConnectionState("dev1", "lost");

        // And record that an alert was sent
        (service as any).deviceManager.recordAlertSent("dev1");

        const spy = jest.spyOn((service as any).watchdog, "checkDeviceHealth");
        service.runWatchdogCheck();
        expect(spy).not.toHaveBeenCalled();
    });

    // --- PING STRATEGIES ---
    it("should generate broadcast ping when all devices are needed", () => {
        // Spy on _processWatchdogForDevice to populate actions manually
        jest.spyOn((service as any), "_processWatchdogForDevice").mockImplementation((name: any, now: any, actions: any) => {
            actions.devicesToPing.add(name);
        });

        const result = service.runWatchdogCheck();
        expect(result.messages[Output.Lsh]).toBeDefined();
        // Should be a single broadcast message because all 3 devices are added
        expect(Array.isArray(result.messages[Output.Lsh])).toBe(false);
        const msg = result.messages[Output.Lsh] as any;
        expect(msg.topic).toBe(mockServiceConfig.serviceTopic); // Broadcast topic
        expect(msg.payload.p).toBe(LshProtocol.PING);
    });

    it("should generate staggered pings when some devices are needed", () => {
        // Spy on _processWatchdogForDevice to populate actions manually
        jest.spyOn((service as any), "_processWatchdogForDevice").mockImplementation((name: any, now: any, actions: any) => {
            if (name === "actor1" || name === "device-sender") {
                actions.devicesToPing.add(name);
            }
        });

        const result = service.runWatchdogCheck();
        expect(result.messages[Output.Lsh]).toBeDefined();
        expect(Array.isArray(result.messages[Output.Lsh])).toBe(true);
        const msgs = result.messages[Output.Lsh] as any[];
        expect(msgs.length).toBe(2);
        expect(result.staggerLshMessages).toBe(true);
    });

    // --- MISC / LOGGING ---
    it("should handle redundant ping logs when state doesn't change", () => {
        (service as any).deviceManager.updateConnectionState("device-sender", "ready");
        const result = service.processMessage("LSH/device-sender/misc", { p: LshProtocol.PING });
        expect(result.logs.some(l => l.includes("Received ping response"))).toBe(true);
    });

    it("should handle a device boot message", () => {
        const payload: DeviceBootPayload = { p: LshProtocol.BOOT_NOTIFICATION };
        const result = service.processMessage("LSH/actor1/misc", payload);
        expect(result.logs).toContain("Device 'actor1' reported a boot event.");
        expect(result.stateChanged).toBe(true);
    });
});
