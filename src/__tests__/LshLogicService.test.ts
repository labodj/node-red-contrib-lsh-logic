/**
 * @file Comprehensive unit and integration tests for the LshLogicService class.
 */
import { ValidateFunction } from "ajv";
import { LshLogicService } from "../LshLogicService";
import {
  ClickType,
  SystemConfig,
  LshProtocol,
  Output,
  DeviceBootPayload,
  PingPayload,
  DeviceDetailsPayload,
} from "../types";
import { encode } from "@msgpack/msgpack";

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

describe("LshLogicService", () => {
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
  });

  // --- GENERAL & CONFIGURATION TESTS ---
  describe("General and Configuration", () => {
    it("should ignore messages if config is not loaded", () => {
      const result = service.processMessage("any/topic", {});
      expect(result.warnings).toContain(
        "Configuration not loaded, ignoring message.",
      );
    });

    it("should ignore messages on unhandled topics", () => {
      service.updateSystemConfig(mockSystemConfig);
      const result = service.processMessage("unhandled/topic/1", {});
      expect(result.logs).toContain(
        "Message on unhandled topic: unhandled/topic/1",
      );
    });

    it("should prune devices from registry when config is updated", () => {
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "device-sender");
      expect(service.getDeviceRegistry()["device-sender"]).toBeDefined();

      const newConfig: SystemConfig = { devices: [{ name: "actor1" }] };
      const logMessage = service.updateSystemConfig(newConfig);
      expect(service.getDeviceRegistry()["device-sender"]).toBeUndefined();
      expect(logMessage).toContain("Pruned stale devices from registry");
    });

    it("should clear system config", () => {
      service.updateSystemConfig(mockSystemConfig);
      expect(service.getConfiguredDeviceNames()).not.toBeNull();
      service.clearSystemConfig();
      expect(service.getConfiguredDeviceNames()).toBeNull();
    });

    it("should warn on invalid 'conf' payload", () => {
      service.updateSystemConfig(mockSystemConfig);
      mockValidators.validateDeviceDetails.mockReturnValue(false);
      mockValidators.validateDeviceDetails.errors = [
        { message: "invalid format" },
      ] as any;

      const result = service.processMessage("LSH/device-1/conf", { p: LshProtocol.DEVICE_DETAILS });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(
        "Invalid 'conf' payload from device-1: invalid format",
      );
    });

    it("should handle actuator state update errors gracefully", () => {
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "actor1"); // Sets actor1 with 1 actuator [1]

      const result = service.processMessage("LSH/actor1/state", {
        p: LshProtocol.ACTUATORS_STATE,
        s: [1, 0],
      }); // Mismatched state array

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("State mismatch for actor1");
    });

    it("should get startup commands", () => {
      service.updateSystemConfig(mockSystemConfig);
      const result = service.getStartupCommands();
      expect(result.logs).toContain(
        "Node started. Passively waiting for device Homie state announcements.",
      );
    });
  });

  // --- HOMIE & MISC TOPIC LOGIC ---
  describe("Homie and Misc Topic Logic", () => {
    beforeEach(() => {
      service.updateSystemConfig(mockSystemConfig);
      // Ensure device exists so 'cameOnline' logic can be tested
      (service as any).deviceManager.pruneDevice("actor1");
      service.processMessage("homie/actor1/$state", "init");
    });

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

    it("should handle a device boot message", () => {
      const payload: DeviceBootPayload = { p: LshProtocol.BOOT_NOTIFICATION };
      const result = service.processMessage("LSH/actor1/misc", payload);
      expect(result.logs).toContain("Device 'actor1' reported a boot event.");
      expect(result.stateChanged).toBe(true);
    });
  });

  // --- NETWORK CLICK LOGIC ---
  describe("Network Click Logic", () => {
    beforeEach(() => {
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "actor1");
      setDeviceOnline(service, "device-sender");
    });

    it("should process a click", () => {
      const reqResult = service.processMessage("LSH/device-sender/misc", {
        p: LshProtocol.NETWORK_CLICK,
        i: 1,
        t: ClickType.Long,
        c: 0,
      });
      expect((reqResult.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.NETWORK_CLICK_ACK,
      );
    });
  });

  // --- HOMIE DISCOVERY INTEGRATION ---
  describe("Homie Discovery Integration", () => {
    beforeEach(() => {
      service.updateSystemConfig(mockSystemConfig);
    });

    it("should process Homie attribute topics when enabled", () => {
      const deviceId = "new-homie-device";

      // Send MAC
      service.processMessage(`homie/${deviceId}/$mac`, "AA:BB:CC");

      // Send FW
      service.processMessage(`homie/${deviceId}/$fw/version`, "1.0.0");

      // Send Nodes
      const result = service.processMessage(`homie/${deviceId}/$nodes`, "lamp");

      // Discovery manager should have generated payloads
      expect(result.messages[Output.Lsh]).toBeDefined();
      const msgs = result.messages[Output.Lsh] as any[];
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs[0].topic).toContain("homeassistant/light/lsh_new-homie-device_lamp/config");
    });

    it("should ignore Homie attribute topics when disabled", () => {
      const configDisabled = { ...mockServiceConfig, haDiscovery: false };
      const serviceDisabled = new LshLogicService(configDisabled, mockContextReader, mockValidators);
      serviceDisabled.updateSystemConfig(mockSystemConfig);

      const result = serviceDisabled.processMessage("homie/dev1/$nodes", "foo");
      expect(result.messages[Output.Lsh]).toBeUndefined();
    });
  });

  // --- CODEC INTEGRATION ---
  describe("Codec Integration", () => {


    it("should encode output as MsgPack if configured", () => {
      const configMsgPack = { ...mockServiceConfig, protocol: "msgpack" as const };
      const serviceMsgPack = new LshLogicService(configMsgPack, mockContextReader, mockValidators);
      serviceMsgPack.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(serviceMsgPack, "device-sender");

      // Trigger an ACK
      const result = serviceMsgPack.processMessage("LSH/device-sender/misc", {
        p: LshProtocol.NETWORK_CLICK,
        i: 1,
        t: ClickType.Long,
        c: 0,
      });

      const msg = result.messages[Output.Lsh] as any;
      expect(Buffer.isBuffer(msg.payload)).toBe(true);
    });
  });
});
