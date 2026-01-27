/**
 * @file Unit tests focussed on Network Click Logic for LshLogicService.
 * This covers Request-Ack-Confirm flows, Failovers, specialized click types (SuperLong),
 * and bitpacking/actuator targeting logic.
 */
import { ValidateFunction } from "ajv";
import { LshLogicService, ClickValidationError } from "../LshLogicService";
import {
    ClickType,
    SystemConfig,
    LshProtocol,
    Output,
    Actor,
} from "../types";

// --- MOCK HELPERS (Duplicated for isolation) ---
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
        {
            name: "device-sender",
            longClickButtons: [
                {
                    id: 1,
                    actors: [{ name: "actor1", allActuators: true, actuators: [] }],
                    otherActors: [],
                },
            ],
            superLongClickButtons: [
                {
                    id: 1,
                    actors: [{ name: "actor1", allActuators: true, actuators: [] }],
                    otherActors: [],
                },
            ],
        },
        { name: "actor1" },
        { name: "device-silent" },
    ],
};

// Helper to set a device as online
const setDeviceOnline = (service: LshLogicService, deviceName: string) => {
    service.processMessage(`LSH/${deviceName}/conf`, {
        p: LshProtocol.DEVICE_DETAILS,
        n: deviceName,
        a: [1],
        b: [],
    });
    (service as any).deviceManager.updateConnectionState(deviceName, "ready");
};

describe("LshLogicService - Network Click Logic", () => {
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
        setDeviceOnline(service, "actor1");
        setDeviceOnline(service, "device-sender");
    });

    // --- BASIC HANDSHAKE ---
    it("should handle the 3-way click handshake (REQUEST -> ACK -> CONFIRM)", () => {
        // Phase 1: Request
        const reqResult = service.processMessage("LSH/device-sender/misc", {
            p: LshProtocol.NETWORK_CLICK_REQUEST,
            i: 1,
            t: ClickType.Long,
        });

        // Should send ACK
        expect((reqResult.messages[Output.Lsh] as any).payload.p).toBe(
            LshProtocol.NETWORK_CLICK_ACK,
        );
        expect(reqResult.logs.some(l => l.includes("Validation OK"))).toBe(true);

        // Phase 2: Confirm (Logic should execute here)
        const confResult = service.processMessage("LSH/device-sender/misc", {
            p: LshProtocol.NETWORK_CLICK_CONFIRM,
            i: 1,
            t: ClickType.Long,
        });

        expect(confResult.logs.some(l => l.includes("Click confirmed"))).toBe(true);
        // actor1 should be turned on
        expect(confResult.messages[Output.Lsh]).toBeDefined();
        const actorMsg = (confResult.messages[Output.Lsh] as any)[0];
        expect(actorMsg.topic).toBe("LSH/actor1/IN");
    });

    it("should reject unconfirmed or expired clicks", () => {
        const confResult = service.processMessage("LSH/device-sender/misc", {
            p: LshProtocol.NETWORK_CLICK_CONFIRM,
            i: 99, // Unknown button
            t: ClickType.Long,
        });

        expect(confResult.warnings[0]).toContain("Received confirmation for an expired or unknown click");
    });

    // --- ADVANCED CLICK TYPES ---
    it("should handle SuperLong click by setting state to OFF", () => {
        // Phase 1: Request
        service.processMessage("LSH/device-sender/misc", {
            p: LshProtocol.NETWORK_CLICK_REQUEST,
            i: 1,
            t: ClickType.SuperLong,
        });

        // Phase 2: Confirmation
        const result = service.processMessage("LSH/device-sender/misc", {
            p: LshProtocol.NETWORK_CLICK_CONFIRM,
            i: 1,
            t: ClickType.SuperLong,
        });

        expect(result.messages[Output.Lsh]).toBeDefined();
        const cmd = (result.messages[Output.Lsh] as any[])[0];
        expect(cmd.payload.p).toBe(LshProtocol.SET_STATE);
        // expect state to be bitpacked (1 byte for 1-8 actuators)
        // bit 0 = actuator ID 1. All OFF -> bit 0 = 0 -> byte = 0
        expect(cmd.payload.s).toEqual([0]);
    });

    // --- ACTUATOR TARGETING & BITPACKING ---
    it("should target specific subset of actuators", () => {
        // Reconfigure actor1 to have 4 actuators
        service.updateSystemConfig({
            devices: [
                {
                    name: "sender",
                    longClickButtons: [{
                        id: 1,
                        actors: [{ name: "actor1", allActuators: false, actuators: [1, 3] }],
                        otherActors: []
                    }]
                },
                { name: "actor1" }
            ]
        });
        setDeviceOnline(service, "sender");

        // Manually register actor1 details with 4 actuators
        service.processMessage("LSH/actor1/conf", {
            p: LshProtocol.DEVICE_DETAILS,
            n: "actor1",
            a: [1, 2, 3, 4],
            b: []
        });
        (service as any).deviceManager.updateConnectionState("actor1", "ready");
        (service as any).deviceManager.registerActuatorStates("actor1", [false, false, false, false]);

        // Phase 1: Request
        service.processMessage("LSH/sender/misc", {
            p: LshProtocol.NETWORK_CLICK_REQUEST,
            i: 1,
            t: ClickType.Long,
        });

        // Phase 2: Confirmation
        const result = service.processMessage("LSH/sender/misc", {
            p: LshProtocol.NETWORK_CLICK_CONFIRM,
            i: 1,
            t: ClickType.Long,
        });

        expect(result.messages[Output.Lsh]).toBeDefined();
        const cmd = (result.messages[Output.Lsh] as any[])[0];
        expect(cmd.payload.p).toBe(LshProtocol.SET_STATE);
        // Target: Actuators 1 and 3 (bits 0 and 2) to ON (1).
        // 0b00000101 = 5
        expect(cmd.payload.s).toEqual([5]);
    });

    it("should generate a specific c_asas command for a single targeted actuator", () => {
        const advancedConfig: SystemConfig = {
            devices: [
                {
                    name: "device-sender-specific",
                    longClickButtons: [
                        {
                            id: 1,
                            actors: [
                                {
                                    name: "actor1",
                                    allActuators: false,
                                    actuators: [2], // Target ONLY actuator 2
                                },
                            ],
                            otherActors: [],
                        },
                    ],
                },
                { name: "actor1" },
            ],
        };
        service.updateSystemConfig(advancedConfig);

        // Register actor1 with 2 actuators
        service.processMessage("LSH/actor1/conf", {
            p: LshProtocol.DEVICE_DETAILS,
            n: "actor1",
            a: [1, 2],
            b: [],
        });
        (service as any).deviceManager.updateConnectionState("actor1", "ready");

        // Phase 1: Request
        service.processMessage("LSH/device-sender-specific/misc", {
            p: LshProtocol.NETWORK_CLICK_REQUEST,
            i: 1,
            t: ClickType.Long,
        });

        // Phase 2: Confirmation
        const result = service.processMessage("LSH/device-sender-specific/misc", {
            p: LshProtocol.NETWORK_CLICK_CONFIRM,
            i: 1,
            t: ClickType.Long,
        });

        expect(result.messages[Output.Lsh]).toBeDefined();
        const cmd = (result.messages[Output.Lsh] as any[])[0];
        // Expect c_asas (p: 13)
        expect(cmd.payload.p).toBe(LshProtocol.SET_SINGLE_ACTUATOR);
        expect(cmd.payload.i).toBe(2);
        // Toggle logic: initially off, so should turn ON (1)
        expect(cmd.payload.s).toBe(1);
    });

    it("should correctly handle bitpacked state updates (ACTUATORS_STATE) processing", () => {
        // Prepare actor with 9 actuators
        service.processMessage("LSH/actor1/conf", {
            p: LshProtocol.DEVICE_DETAILS,
            n: "actor1",
            a: [1, 2, 3, 4, 5, 6, 7, 8, 9], // 9 actuators to test multiple bytes
            b: [],
        });

        // Send state: byte0=0b10101010 (actuators 1,3,5,7 off, 2,4,6,8 on), byte1=0b00000001 (actuator 9 on)
        // Note: LSH uses 0-indexed bits for actuator IDs (ID 1 = bit 0, ID 2 = bit 1, etc.)
        const result = service.processMessage("LSH/actor1/state", {
            p: LshProtocol.ACTUATORS_STATE,
            s: [0b10101010, 0b00000001],
        });

        expect(result.stateChanged).toBe(true);
        const registry = service.getDeviceRegistry()["actor1"];
        expect(registry.actuatorStates[0]).toBe(false); // ID 1 (bit 0)
        expect(registry.actuatorStates[1]).toBe(true);  // ID 2 (bit 1)
        expect(registry.actuatorStates[8]).toBe(true);  // ID 9 (bit 0 of byte 1)
    });

    // --- OTHER ACTORS (Non-LSH) ---
    it("should include otherActors in click execution results", () => {
        service.updateSystemConfig({
            devices: [{
                name: "sender-other",
                longClickButtons: [{
                    id: 1, actors: [], otherActors: ["zigbee-bulb"]
                }]
            }]
        });
        setDeviceOnline(service, "sender-other");

        // Mock context to return 'false' (OFF) for zigbee-bulb
        mockContextReader.get.mockReturnValue(false);

        // Request
        service.processMessage("LSH/sender-other/misc", { p: LshProtocol.NETWORK_CLICK_REQUEST, i: 1, t: ClickType.Long });

        // Confirm
        const result = service.processMessage("LSH/sender-other/misc", { p: LshProtocol.NETWORK_CLICK_CONFIRM, i: 1, t: ClickType.Long });

        expect(result.messages[Output.OtherActors]).toBeDefined();
        const otherMsg = result.messages[Output.OtherActors] as any;
        expect(otherMsg.payload.otherActors).toEqual(["zigbee-bulb"]);
        expect(otherMsg.payload.stateToSet).toBe(true); // Default toggle ON
    });

    // --- ERROR HANDLING & FAILOVERS ---
    it("should catch unexpected errors during click processing", () => {
        service.updateSystemConfig({ devices: [{ name: "sender" }] });
        jest.spyOn((service as any), "_validateClickRequest").mockImplementation(() => {
            throw new Error("Boom");
        });
        const result = service.processMessage("LSH/sender/misc", { p: LshProtocol.NETWORK_CLICK_REQUEST, i: 1, t: ClickType.Long });
        expect(result.errors.some(e => e.includes("Unexpected error"))).toBe(true);
    });

    it("should fail validation if target actors are offline (Failover)", () => {
        service.updateSystemConfig({
            devices: [
                { name: "sender", longClickButtons: [{ id: 1, actors: [{ name: "offline_act", allActuators: true, actuators: [] }], otherActors: [] }] },
                { name: "offline_act" }
            ]
        });
        (service as any).deviceManager.updateConnectionState("sender", "ready");
        // No update for offline_act -> it's offline

        const result = service.processMessage("LSH/sender/misc", { p: LshProtocol.NETWORK_CLICK_REQUEST, i: 1, t: ClickType.Long });
        expect(result.messages[Output.Lsh]).toBeDefined();
        // Check if failover was sent
        const payload = (result.messages[Output.Lsh] as any).payload;
        expect(payload.p).toBe(LshProtocol.FAILOVER);
    });

    it("should throw ClickValidationError if no action is configured", () => {
        service.updateSystemConfig({ devices: [{ name: "sender", longClickButtons: [] }] });
        (service as any).deviceManager.updateConnectionState("sender", "ready");
        const result = service.processMessage("LSH/sender/misc", { p: LshProtocol.NETWORK_CLICK_REQUEST, i: 99, t: ClickType.Long });
        expect((result.messages[Output.Lsh] as any).payload.p).toBe(LshProtocol.FAILOVER);
    });

    it("should send General Failover (p:16) if a general ClickValidationError occurs", () => {
        service.updateSystemConfig({
            devices: [{ name: "sender", longClickButtons: [{ id: 1, actors: [{ name: "act1", allActuators: true, actuators: [] }], otherActors: [] }] }, { name: "act1" }]
        });
        (service as any).deviceManager.updateConnectionState("sender", "ready");
        (service as any).deviceManager.updateConnectionState("act1", "ready");

        jest.spyOn((service as any), "_validateClickRequest").mockImplementation(() => {
            throw new ClickValidationError("forced fail", "general");
        });

        const result = service.processMessage("LSH/sender/misc", { p: LshProtocol.NETWORK_CLICK_REQUEST, i: 1, t: ClickType.Long });
        expect(result.errors.some(e => e.includes("System failure on click"))).toBe(true);
        expect((result.messages[Output.Lsh] as any).payload.p).toBe(LshProtocol.GENERAL_FAILOVER);
    });

    it("should throw ClickValidationError if action has no targets", () => {
        service.updateSystemConfig({
            devices: [{ name: "sender", longClickButtons: [{ id: 1, actors: [], otherActors: [] }] }]
        });
        (service as any).deviceManager.updateConnectionState("sender", "ready");
        const result = service.processMessage("LSH/sender/misc", { p: LshProtocol.NETWORK_CLICK_REQUEST, i: 1, t: ClickType.Long });
        expect((result.messages[Output.Lsh] as any).payload.p).toBe(LshProtocol.FAILOVER);
    });
});
