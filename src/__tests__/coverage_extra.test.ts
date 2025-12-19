
import { ValidateFunction } from "ajv";
import { LshLogicService } from "../LshLogicService";
import {
    ClickType,
    SystemConfig,
    LshProtocol,
    Output,
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

const setDeviceOnline = (service: LshLogicService, deviceName: string) => {
    service.processMessage(`LSH/${deviceName}/conf`, {
        p: LshProtocol.DEVICE_DETAILS,
        n: deviceName,
        a: [1],
        b: [],
    });
    (service as any).deviceManager.updateConnectionState(deviceName, "ready");
};

describe("LshLogicService Extra Coverage", () => {
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

    it("should handle SuperLong click by setting state to OFF", () => {
        // Phase 1: Request
        service.processMessage("LSH/device-sender/misc", {
            p: LshProtocol.NETWORK_CLICK,
            i: 1,
            t: ClickType.SuperLong,
            c: 0,
        });

        // Phase 2: Confirmation
        const result = service.processMessage("LSH/device-sender/misc", {
            p: LshProtocol.NETWORK_CLICK,
            i: 1,
            t: ClickType.SuperLong,
            c: 1,
        });

        expect(result.messages[Output.Lsh]).toBeDefined();
        const cmd = (result.messages[Output.Lsh] as any[])[0];
        expect(cmd.payload.p).toBe(LshProtocol.SET_STATE);
        // expect state to be all 0 (OFF)
        // Since actor1 has 1 actuator, [0].
        expect(cmd.payload.s).toEqual([0]);
    });

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
            p: LshProtocol.NETWORK_CLICK,
            i: 1,
            t: ClickType.Long,
            c: 0
        });

        // Phase 2: Confirmation
        const result = service.processMessage("LSH/sender/misc", {
            p: LshProtocol.NETWORK_CLICK,
            i: 1,
            t: ClickType.Long,
            c: 1
        });

        expect(result.messages[Output.Lsh]).toBeDefined();
        const cmd = (result.messages[Output.Lsh] as any[])[0];
        expect(cmd.payload.p).toBe(LshProtocol.SET_STATE);
        // Expected: Actuators 1 and 3 set to 1 (ON). Actuators 2 and 4 remain 0.
        expect(cmd.payload.s).toEqual([1, 0, 1, 0]);
    });

    it("should generate broadcast ping when all devices are needed", () => {
        // Spy on _processWatchdogForDevice to populate actions manually
        jest.spyOn((service as any), "_processWatchdogForDevice").mockImplementation((name: any, now: any, actions: any) => {
            actions.devicesToPing.add(name);
        });

        const result = service.runWatchdogCheck();
        expect(result.messages[Output.Lsh]).toBeDefined();
        // Should be a single broadcast message because all 3 devices (actor1, device-sender, device-silent) are added
        expect(Array.isArray(result.messages[Output.Lsh])).toBe(false);
        const msg = result.messages[Output.Lsh] as any;
        expect(msg.topic).toBe(mockServiceConfig.serviceTopic);
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
            p: LshProtocol.NETWORK_CLICK,
            i: 1,
            t: ClickType.Long,
            c: 0,
        });

        // Phase 2: Confirmation
        const result = service.processMessage("LSH/device-sender-specific/misc", {
            p: LshProtocol.NETWORK_CLICK,
            i: 1,
            t: ClickType.Long,
            c: 1,
        });

        expect(result.messages[Output.Lsh]).toBeDefined();
        const cmd = (result.messages[Output.Lsh] as any[])[0];
        // Expect c_asas (p: 13)
        expect(cmd.payload.p).toBe(LshProtocol.SET_SINGLE_ACTUATOR);
        expect(cmd.payload.i).toBe(2);
        // Toggle logic: initially off, so should turn ON (1)
        expect(cmd.payload.s).toBe(1);
    });

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
        service.processMessage("LSH/sender-other/misc", { p: LshProtocol.NETWORK_CLICK, i: 1, t: ClickType.Long, c: 0 });

        // Confirm
        const result = service.processMessage("LSH/sender-other/misc", { p: LshProtocol.NETWORK_CLICK, i: 1, t: ClickType.Long, c: 1 });

        expect(result.messages[Output.OtherActors]).toBeDefined();
        const otherMsg = result.messages[Output.OtherActors] as any;
        expect(otherMsg.payload.otherActors).toEqual(["zigbee-bulb"]);
        expect(otherMsg.payload.stateToSet).toBe(true); // Default toggle ON
    });
});
