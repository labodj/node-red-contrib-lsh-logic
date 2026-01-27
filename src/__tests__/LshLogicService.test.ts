/**
 * @file Comprehensive unit tests for the LshLogicService class.
 * This file verifies general configuration, startup logic, message routing,
 * and error handling.
 */
import { ValidateFunction } from "ajv";
import { LshLogicService } from "../LshLogicService";
import {
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
    { name: "device-sender" },
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

describe("LshLogicService - Core & Config", () => {
  let service: LshLogicService;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.values(mockValidators).forEach((v) => {
      v.mockReturnValue(true);
      v.errors = null;
    });
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

    it("should warn if verifyInitialDeviceStates is called without config", () => {
      const result = service.verifyInitialDeviceStates();
      expect(result.warnings.some(w => w.includes("config not loaded"))).toBe(true);
    });

    it("should warn if getStartupCommands is called without config", () => {
      const result = service.getStartupCommands();
      expect(result.warnings.some(w => w.includes("config not loaded"))).toBe(true);
    });

    it("should return a clone of systemConfig", () => {
      service.updateSystemConfig({ devices: [{ name: "dev1" }] });
      const config = service.getSystemConfig();
      expect(config).not.toBeNull();
      expect(config?.devices[0].name).toBe("dev1");
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
  });

  // --- STARTUP VERIFICATION ---
  describe("Startup Verification", () => {
    beforeEach(() => {
      service.updateSystemConfig(mockSystemConfig);
    });

    it("should log success when all devices are connected during initial verification", () => {
      (service as any).deviceManager.updateConnectionState("device-sender", "ready");
      (service as any).deviceManager.updateConnectionState("actor1", "ready");
      (service as any).deviceManager.updateConnectionState("device-silent", "ready");
      const result = service.verifyInitialDeviceStates();
      expect(result.logs.some(l => l.includes("all configured devices are connected"))).toBe(true);
    });

    it("should log success when final verification is successful", () => {
      // Simulate all responsive
      (service as any).deviceManager.updateConnectionState("device-sender", "ready");
      (service as any).deviceManager.updateConnectionState("actor1", "ready");
      (service as any).deviceManager.updateConnectionState("device-silent", "ready");
      const result = service.runFinalVerification(["device-sender", "actor1", "device-silent"]);
      expect(result.logs.some(l => l.includes("Final verification successful"))).toBe(true);
    });

    it("should get startup commands", () => {
      const result = service.getStartupCommands();
      expect(result.logs).toContain(
        "Node started. Passively waiting for device Homie state announcements.",
      );
    });
  });

  // --- ERROR HANDLING & ROBUSTNESS ---
  describe("Error Handling & Robustness", () => {
    beforeEach(() => {
      service.updateSystemConfig(mockSystemConfig);
    });

    it("should warn on invalid 'conf' payload", () => {
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

    it("should carry schema errors in handleLshState warning", () => {
      mockValidators.validateActuatorStates.mockReturnValue(false);
      mockValidators.validateActuatorStates.errors = [{ message: "mock state error" }];

      const result = service.processMessage("LSH/actor1/state", { p: LshProtocol.ACTUATORS_STATE });
      expect(result.warnings.some(w => w.includes("mock state error"))).toBe(true);
    });

    it("should carry schema errors in handleLshMisc warning", () => {
      mockValidators.validateAnyMiscTopic.mockReturnValue(false);
      mockValidators.validateAnyMiscTopic.errors = [{ message: "mock misc error" }];

      const result = service.processMessage("LSH/actor1/misc", { p: LshProtocol.PING });
      expect(result.warnings.some(w => w.includes("mock misc error"))).toBe(true);
    });

    it("should handle actuator state update errors gracefully", () => {
      setDeviceOnline(service, "actor1");
      // actor1 has 1 actuator [1] thanks to setDeviceOnline

      const result = service.processMessage("LSH/actor1/state", {
        p: LshProtocol.ACTUATORS_STATE,
        s: [1, 0],
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("State mismatch for actor1: expected 1 bytes");
    });

    it("should catch errors in _handleLshState (Crash Simulation)", () => {
      // Force a crash by mocking registerActuatorStates to throw
      jest.spyOn((service as any).deviceManager, "registerActuatorStates").mockImplementation(() => {
        throw new Error("Simulated crash");
      });
      const result = service.processMessage("LSH/actor1/state", { p: LshProtocol.ACTUATORS_STATE, s: [0] });
      expect(result.errors).toContain("Simulated crash");
    });

    it("should log and request details for a new/unconfigured device sending state", () => {
      // device unknown-dev is not in mockSystemConfig
      const result = service.processMessage("LSH/unknown-dev/state", { p: LshProtocol.ACTUATORS_STATE, s: [0] });
      expect(result.logs.some(l => l.includes("new device"))).toBe(true);
      expect(result.warnings.some(w => w.includes("configuration is unknown"))).toBe(true);
      expect(result.messages[Output.Lsh]).toBeDefined();
    });
  });

  // --- HOMIE DISCOVERY ---
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

      // Uses a click request to trigger a response
      const result = serviceMsgPack.processMessage("LSH/device-sender/misc", {
        p: LshProtocol.NETWORK_CLICK_REQUEST,
        i: 1,
        t: 1, // Long
      });

      const msg = result.messages[Output.Lsh] as any;
      expect(Buffer.isBuffer(msg.payload)).toBe(true);
    });
  });
});
