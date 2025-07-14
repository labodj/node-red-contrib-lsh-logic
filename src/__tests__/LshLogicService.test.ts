/**
 * @file Comprehensive unit and integration tests for the LshLogicService class.
 */
import { ValidateFunction } from "ajv";
import { LshLogicService, ClickValidationError } from "../LshLogicService";
import {
  ClickType,
  SystemConfig,
  LshProtocol,
  Output,
  DeviceBootPayload,
  PingPayload,
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
  otherDevicesPrefix: "other_devices",
  clickTimeout: 5,
  interrogateThreshold: 3,
  pingTimeout: 5,
};

const mockSystemConfig: SystemConfig = {
  devices: [
    {
      name: "device-sender",
      longClickButtons: [
        {
          id: "B1",
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
    p: "d_dd",
    dn: deviceName,
    ai: ["A1"],
    bi: [],
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

      const result = service.processMessage("LSH/device-1/conf", { p: "d_dd" });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(
        "Invalid 'conf' payload from device-1: invalid format",
      );
    });

    it("should handle actuator state update errors gracefully", () => {
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "actor1"); // Sets actor1 with 1 actuator 'A1'

      const result = service.processMessage("LSH/actor1/state", {
        p: "d_as",
        as: [true, false],
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

    it("should return warning if getting startup commands without config", () => {
      const result = service.getStartupCommands();
      expect(result.warnings).toContain(
        "Cannot generate startup commands: config not loaded.",
      );
    });
    it("should not report a change if actuator state is identical", () => {
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "actor1");

      service.processMessage("LSH/actor1/state", { p: "d_as", as: [true] });

      const result = service.processMessage("LSH/actor1/state", {
        p: "d_as",
        as: [true],
      });

      expect(result.stateChanged).toBe(false);
      expect(result.logs.some((log) => log.includes("Updated state"))).toBe(
        false,
      );
    });
    it("should return a warning when verifying initial states without a loaded config", () => {
      // Ensure the service is in a state without a system config
      // The beforeEach for the main describe block creates a fresh service, so we don't load any config here.

      const result = service.verifyInitialDeviceStates();

      // Expect a specific warning message
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toBe(
        "Cannot run initial state verification: config not loaded.",
      );

      // Expect no messages to be generated
      expect(Object.keys(result.messages)).toHaveLength(0);

      // Expect no state change
      expect(result.stateChanged).toBe(false);
    });

    it("should not log or mark state as changed if device details are identical", () => {
      service.updateSystemConfig(mockSystemConfig);
      const deviceName = "actor1";
      const detailsPayload = {
        p: "d_dd" as const,
        dn: deviceName,
        ai: ["A1"],
        bi: ["B1"],
      };

      // First call: The state changes, a log is expected.
      let result = service.processMessage(
        `LSH/${deviceName}/conf`,
        detailsPayload,
      );
      expect(result.stateChanged).toBe(true);
      expect(result.logs).toContain(
        `Stored/Updated details for device '${deviceName}'.`,
      );

      // Second call with identical payload: No change should be reported.
      result = service.processMessage(`LSH/${deviceName}/conf`, detailsPayload);

      // Assert: This time, no change should be detected, and the `if` block is skipped.
      expect(result.stateChanged).toBe(false);
      expect(result.logs).not.toContain(
        `Stored/Updated details for device '${deviceName}'.`,
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
      expect(payloads).toContain(LshProtocol.SEND_DEVICE_DETAILS);
      expect(payloads).toContain(LshProtocol.SEND_ACTUATORS_STATE);

      expect(result.messages[Output.Alerts]).toBeDefined();
      expect((result.messages[Output.Alerts] as any).payload).toContain(
        "back online",
      );
    });

    it("should create 'wentOffline' alert on Homie 'lost'", () => {
      service.processMessage("homie/actor1/$state", "ready"); // Bring it online first
      const result = service.processMessage("homie/actor1/$state", "lost");
      expect(result.messages[Output.Alerts]).toBeDefined();
      expect((result.messages[Output.Alerts] as any).payload).toContain(
        "Alert",
      );
    });

    it("should handle a device boot message", () => {
      const payload: DeviceBootPayload = { p: LshProtocol.DEVICE_BOOT };
      const result = service.processMessage("LSH/actor1/misc", payload);
      expect(result.logs).toContain("Device 'actor1' reported a boot event.");
      expect(result.stateChanged).toBe(true);
    });

    it("should handle a ping response and generate 'cameOnline' alert if was unhealthy", () => {
      const device = (service as any).deviceManager.getDevice("actor1");
      // Set the device to an unhealthy state
      device.isHealthy = false;

      const payload: PingPayload = { p: LshProtocol.PING };
      const result = service.processMessage("LSH/actor1/misc", payload);

      // The log message now comes from the service layer directly
      expect(
        result.logs.some((log) =>
          log.includes("is healthy again after ping response"),
        ),
      ).toBe(true);
      expect(result.stateChanged).toBe(true);
      expect(result.messages[Output.Alerts]).toBeDefined();
    });

    it("should prepare a 'healthy' alert without details", () => {
      // Set the device to an unhealthy state
      const device = (service as any).deviceManager.getDevice("actor1");
      device.isHealthy = false;

      // A ping will bring it back online, generating an alert
      const payload: PingPayload = { p: LshProtocol.PING };
      const result = service.processMessage("LSH/actor1/misc", payload);

      expect(result.messages[Output.Alerts]).toBeDefined();
      const alertPayload = (result.messages[Output.Alerts] as any).payload;
      // Verify that the recovery message is present
      expect(alertPayload).toContain("✅ *System Health Recovery* ✅");
      // Verify that the string "*Details:*" is NOT present
      expect(alertPayload).not.toContain("*Details:*");
    });

    it("should handle a ping response from an already healthy device", () => {
      // Setup: The device is already online and healthy.
      setDeviceOnline(service, "actor1");
      (service as any).deviceManager.getDevice("actor1").isHealthy = true;

      const payload: PingPayload = { p: LshProtocol.PING };
      const result = service.processMessage("LSH/actor1/misc", payload);

      // The state should NOT have changed.
      expect(result.stateChanged).toBe(false);

      // The log should reflect a simple received ping, not a recovery.
      expect(result.logs).toContain("Received ping response from 'actor1'.");
      expect(result.logs).not.toContain("is now responsive");

      // No alert should be generated.
      expect(result.messages[Output.Alerts]).toBeUndefined();
    });

    it("should do nothing if a homie state message does not change the connection state", () => {
      // Setup: Bring the device online. The first call changes the state.
      service.processMessage("homie/actor1/$state", "ready");

      // Act: Send the same state again. This call should do nothing.
      const result = service.processMessage("homie/actor1/$state", "ready");

      // Assert: The result should be empty.
      expect(result.stateChanged).toBe(false);
      expect(Object.keys(result.messages)).toHaveLength(0);
      // Verify there are no logs, as nothing relevant happened.
      const hasConnectionLog = result.logs.some((log) =>
        log.includes("connection state changed"),
      );
      expect(hasConnectionLog).toBe(false);
    });

    it("should request device details if a state message is received for a device without a known config", () => {
      // Setup: Ensure the device exists in the config but not in the registry (or is partial)
      service.updateSystemConfig(mockSystemConfig);
      // We do NOT call setDeviceOnline, as that would also send the details

      // Act: Send a state message from an unknown device
      const result = service.processMessage("LSH/actor1/state", {
        p: "d_as",
        as: [true],
      });

      // Assert
      // 1. A warning must be generated
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(
        "sent state but its configuration is unknown",
      );

      // 2. A message to request device details must be sent
      expect(result.messages[Output.Lsh]).toBeDefined();
      const command = result.messages[Output.Lsh] as any;
      expect(command.topic).toBe("LSH/actor1/IN");
      expect(command.payload.p).toBe(LshProtocol.SEND_DEVICE_DETAILS);
    });

    it("should log the creation of a partial entry when receiving state from a new device", () => {
      // Setup: Use a config with a device that we will treat as "new".
      service.updateSystemConfig(mockSystemConfig);
      const newDeviceName = "device-silent";

      // Pre-assertion: Ensure the device does NOT exist in the registry yet.
      const initialRegistry = service.getDeviceRegistry();
      expect(initialRegistry[newDeviceName]).toBeUndefined();

      // Act: Process a 'state' message from this new device.
      const result = service.processMessage(`LSH/${newDeviceName}/state`, {
        p: "d_as",
        as: [true, false], // The actual state doesn't matter for this test
      });

      // Assert: The specific log message for a new device should be present.
      // This proves that `isNew` was true and the target line was executed.
      expect(result.logs).toContain(
        `Received state for a new device: ${newDeviceName}. Creating partial entry.`,
      );

      // Post-assertion: The device should now exist in the registry.
      const finalRegistry = service.getDeviceRegistry();
      expect(finalRegistry[newDeviceName]).toBeDefined();
    });
    it("should not mark state as changed for a redundant boot message from a healthy device", () => {
      service.updateSystemConfig(mockSystemConfig);
      const deviceName = "actor1";
      const bootPayload: DeviceBootPayload = { p: LshProtocol.DEVICE_BOOT };

      // First boot message: The device becomes healthy, state changes.
      let result = service.processMessage(
        `LSH/${deviceName}/misc`,
        bootPayload,
      );
      expect(result.stateChanged).toBe(true);

      // Second, redundant boot message immediately after.
      result = service.processMessage(`LSH/${deviceName}/misc`, bootPayload);

      // Assert: The device was already healthy, so no state change should be reported.
      // This proves the `if` block was skipped.
      expect(result.stateChanged).toBe(false);
    });
  });

  describe("Invalid Payload Handling", () => {
    beforeEach(() => {
      service.updateSystemConfig(mockSystemConfig);
    });

    it("should warn on invalid 'conf' payload", () => {
      // Setup: Mock the validator to fail
      mockValidators.validateDeviceDetails.mockReturnValue(false);
      mockValidators.validateDeviceDetails.errors = [
        { message: "is the wrong type" },
      ] as any;

      const result = service.processMessage("LSH/device-1/conf", {
        p: "d_dd",
        dn: 123,
      }); // Invalid payload

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(
        "Invalid 'conf' payload from device-1: is the wrong type",
      );
      expect(Object.keys(result.messages)).toHaveLength(0); // No message should be sent
    });

    it("should warn on invalid 'state' payload", () => {
      // Setup: Mock the validator to fail
      mockValidators.validateActuatorStates.mockReturnValue(false);
      mockValidators.validateActuatorStates.errors = [
        { message: "array is too short" },
      ] as any;

      const result = service.processMessage("LSH/device-1/state", {
        p: "d_as",
        as: "not-an-array",
      });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(
        "Invalid 'state' payload from device-1: array is too short",
      );
    });

    it("should warn on invalid 'misc' payload", () => {
      // Setup: Mock the validator to fail
      mockValidators.validateAnyMiscTopic.mockReturnValue(false);
      mockValidators.validateAnyMiscTopic.errors = [
        { message: "unknown protocol" },
      ] as any;

      const result = service.processMessage("LSH/device-1/misc", {
        p: "d_xx",
        data: "some-data",
      });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(
        "Invalid 'misc' payload from device-1: unknown protocol",
      );
    });

    it("should provide a default error message if validator.errors is null", () => {
      // Setup: Mock the validator to fail but without providing an error array
      mockValidators.validateDeviceDetails.mockReturnValue(false);
      mockValidators.validateDeviceDetails.errors = null; // Simulate the edge case

      const result = service.processMessage("LSH/device-1/conf", { p: "d_dd" });

      expect(result.warnings[0]).toContain("unknown validation error");
    });

    it("should provide a default error for 'state' payload if validator.errors is null", () => {
      // Setup: Mock the validator to fail but without providing an error array
      mockValidators.validateActuatorStates.mockReturnValue(false);
      mockValidators.validateActuatorStates.errors = null; // Simulate the edge case

      const result = service.processMessage("LSH/device-1/state", {
        p: "d_as",
        as: "invalid",
      });

      // Assert that the fallback error message is used.
      expect(result.warnings[0]).toContain(
        "Invalid 'state' payload from device-1: unknown validation error",
      );
    });

    it("should handle non-Error exceptions from registerActuatorStates gracefully", () => {
      // Setup: Mock the deviceManager to throw a non-Error object (a string).
      const errorString = "A simple string error";
      jest
        .spyOn((service as any).deviceManager, "registerActuatorStates")
        .mockImplementation(() => {
          throw errorString;
        });

      service.updateSystemConfig(mockSystemConfig);

      // Act: Process a message that will trigger the mocked method.
      const result = service.processMessage("LSH/device-1/state", {
        p: "d_as",
        as: [true],
      });

      // Assert:
      // 1. The 'errors' array in the result should contain the stringified version of our error.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBe(errorString);

      // 2. No other side effects should have occurred.
      expect(result.stateChanged).toBe(false);

      // Restore the original method to not affect other tests.
      (
        (service as any).deviceManager.registerActuatorStates as jest.Mock
      ).mockRestore();
    });
    it("should provide a default error for 'misc' payload if validator.errors is null", () => {
      // Setup: Mock the validator to fail but without providing an error array
      mockValidators.validateAnyMiscTopic.mockReturnValue(false);
      mockValidators.validateAnyMiscTopic.errors = null; // Simulate the edge case

      // Act: Process a message with an invalid 'misc' payload.
      const result = service.processMessage("LSH/device-1/misc", {
        p: "invalid_protocol",
      });

      // Assert that the fallback error message is used.
      expect(result.warnings[0]).toContain(
        "Invalid 'misc' payload from device-1: unknown validation error",
      );
    });
  });

  // --- NETWORK CLICK LOGIC ---
  describe("Network Click Logic", () => {
    beforeEach(() => {
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "actor1");
      setDeviceOnline(service, "device-sender");
    });
    it("should NOT send a LSH command if a click is requested but config is not loaded", () => {
      service.clearSystemConfig(); // Simulate config not loaded

      // This processMessage call actually happens inside _handleNewClickRequest, which catches the validation error.
      // Let's trace it: processMessage -> route.handler -> handleNetworkClick -> _processNewClickRequest
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });

      // Correct behavior: NO LSH message should be sent because the target is unknown without config.
      expect(result.messages[Output.Lsh]).toBeUndefined();

      // An error should be logged internally.
      // The current implementation does not produce an error log here, but rather a generic warning at the start of `processMessage`.
      // Let's check for that warning instead.
      expect(result.warnings).toContain(
        "Configuration not loaded, ignoring message.",
      );
    });

    it("should fail click and generate an alert if target actor is offline", () => {
      (service as any).deviceManager.updateConnectionState("actor1", "lost"); // Make actor offline
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });

      expect((result.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.FAILOVER,
      );
      expect(result.messages[Output.Alerts]).toBeDefined();
      expect((result.messages[Output.Alerts] as any).payload).toContain(
        "Target actor(s) are offline",
      );
    });

    it("should fail click and generate an alert if button is not configured", () => {
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B_unconfigured",
        ct: ClickType.Long,
        c: false,
      });
      expect((result.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.FAILOVER,
      );
      expect(result.messages[Output.Alerts]).toBeDefined();
    });

    it("should correctly process a full click transaction (long-click/smart toggle)", () => {
      // Phase 1: Request
      const reqResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });
      expect((reqResult.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.NETWORK_CLICK_ACK,
      );

      // Phase 2: Confirmation
      const confirmResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: true,
      });
      expect(
        confirmResult.logs.some((log) => log.includes("Click confirmed")),
      ).toBe(true);
      const command = (confirmResult.messages[Output.Lsh] as any[])[0];
      expect(command.payload.p).toBe(LshProtocol.APPLY_ALL_ACTUATORS_STATE);
      // Smart toggle: state should be ON because initial state is OFF.
      expect(command.payload.as).toEqual([true]);
    });

    it("should return a warning on expired click confirmation", () => {
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: true,
      });
      expect(result.warnings).toContain(
        "Received confirmation for an expired or unknown click: device-sender.B1.lc.",
      );
    });

    it("should cleanup expired clicks", () => {
      // Start a transaction that will expire
      (service as any).clickManager.startTransaction("expired.key", [], []);
      jest.spyOn(Date, "now").mockReturnValue(new Date().getTime() + 6000); // Fast-forward time

      const log = service.cleanupPendingClicks();
      expect(log).toContain("Cleaned up 1 expired click transactions");

      const log2 = service.cleanupPendingClicks();
      expect(log2).toBeNull();

      (Date.now as any).mockRestore();
    });
    it("should issue a warning and ignore click if config is not loaded", () => {
      service.clearSystemConfig(); // Config not loaded

      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });

      expect(result.messages[Output.Lsh]).toBeUndefined();
      expect(result.warnings).toContain(
        "Configuration not loaded, ignoring message.",
      );
    });
    it("should generate a specific c_asas command for a single targeted actuator", () => {
      // Configuration with a single target actuator and an otherActor
      const advancedConfig: SystemConfig = {
        devices: [
          {
            name: "device-sender",
            longClickButtons: [
              {
                id: "B1",
                actors: [
                  {
                    name: "actor1",
                    allActuators: false,
                    actuators: ["A2"], // <<< TARGETING A SINGLE, SPECIFIC ACTUATOR
                  },
                ],
                otherActors: ["tasmota-plug"],
              },
            ],
          },
          { name: "actor1" },
          { name: "tasmota-plug" },
        ],
      };
      service.updateSystemConfig(advancedConfig);

      // Setup: actor1 has 2 actuators, both OFF
      service.processMessage(`LSH/actor1/conf`, {
        p: "d_dd",
        dn: "actor1",
        ai: ["A1", "A2"],
        bi: [],
      });
      (service as any).deviceManager.updateConnectionState("actor1", "ready");
      (service as any).deviceManager.registerActuatorStates("actor1", [
        false,
        false,
      ]);

      // Phase 1: Request
      const reqResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });
      expect((reqResult.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.NETWORK_CLICK_ACK,
      );

      // Phase 2: Confirmation
      const confirmResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: true,
      });

      // Assert LSH command - SHOULD BE THE OPTIMIZED 'c_asas'
      expect(confirmResult.messages[Output.Lsh]).toBeDefined();
      const lshCommand = (confirmResult.messages[Output.Lsh] as any[])[0];
      expect(lshCommand.payload.p).toBe(
        LshProtocol.APPLY_SINGLE_ACTUATOR_STATE,
      ); // <<< CORRECT ASSERTION
      expect(lshCommand.payload.ai).toBe("A2"); // Verify the actuator ID is correct
      expect(lshCommand.payload.as).toBe(true); // Verify the state is correct

      // Assert OtherActors command (the logic doesn't change)
      expect(confirmResult.messages[Output.OtherActors]).toBeDefined();
      const otherActorsCmd = confirmResult.messages[Output.OtherActors] as any;
      expect(otherActorsCmd.otherActors).toEqual(["tasmota-plug"]);
      expect(otherActorsCmd.stateToSet).toBe(true);
    });

    it("should fail validation if the button ID is not configured", () => {
      // Use a configuration that does NOT have 'B_unconfigured' for device-sender
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "device-sender");
      setDeviceOnline(service, "actor1");

      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B_unconfigured", // <<< UNCONFIGURED BUTTON
        ct: ClickType.Long,
        c: false,
      });

      // It must respond with a click-specific failover
      expect((result.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.FAILOVER,
      );
      // And it must generate an alert
      expect(result.messages[Output.Alerts]).toBeDefined();
      expect((result.messages[Output.Alerts] as any).payload).toContain(
        "No action configured for this button",
      );
    });

    it("should handle unexpected errors during click processing", () => {
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "device-sender");
      setDeviceOnline(service, "actor1");

      // Force an unexpected error from one of the dependencies
      const unexpectedError = new Error("Internal cache failure");
      jest
        .spyOn((service as any).clickManager, "startTransaction")
        .mockImplementation(() => {
          throw unexpectedError;
        });

      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });

      // It must not send messages
      expect(result.messages).toEqual({});
      // It must log the unexpected error
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(
        "Unexpected error during click processing",
      );
      expect(result.errors[0]).toContain(unexpectedError.message);
    });

    it("should handle a general failover when click validation throws a general error", () => {
      // Setup: Load the configuration and prepare the online state
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "device-sender");
      setDeviceOnline(service, "actor1");

      // Spy on the private method _validateClickRequest to force a specific error.
      const validationSpy = jest
        .spyOn(service as any, "_validateClickRequest")
        .mockImplementation(() => {
          throw new ClickValidationError(
            "Config suddenly unloaded.",
            "general", // <-- The key part
          );
        });

      const deviceName = "device-sender";

      // Act: Process a click request that will now fail as intended.
      const result = service.processMessage(`LSH/${deviceName}/misc`, {
        p: LshProtocol.NETWORK_CLICK,
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });

      // Assert: Verify that the GENERAL_FAILOVER command was sent.
      expect(result.messages[Output.Lsh]).toBeDefined();
      const lshMessage = result.messages[Output.Lsh] as any;
      expect(lshMessage.payload.p).toBe(LshProtocol.GENERAL_FAILOVER);

      // Assert: Verify that the correct error was logged.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(
        "System failure on click. Sending General Failover (c_gf).",
      );

      // Cleanup: Restore the original method to avoid affecting other tests.
      validationSpy.mockRestore();
    });

    it("should handle unexpected errors during click processing and log them", () => {
      // Setup
      service.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(service, "device-sender");
      setDeviceOnline(service, "actor1");

      // Spy on clickManager to force an unexpected error
      const unexpectedError = new Error("Internal cache failure");
      jest
        .spyOn((service as any).clickManager, "startTransaction")
        .mockImplementation(() => {
          throw unexpectedError;
        });

      // Act
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });

      // Assert
      // No messages should be sent
      expect(Object.keys(result.messages)).toHaveLength(0);

      // The unexpected error should be logged
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(
        "Unexpected error during click processing",
      );
      expect(result.errors[0]).toContain(unexpectedError.toString()); // Verify the original error is part of the log
    });

    it("should log a warning during click execution if an otherActor's state is missing", () => {
      // Configuration with an otherActor for the long-click
      const configWithOtherActor: SystemConfig = {
        devices: [
          {
            name: "device-sender",
            longClickButtons: [
              {
                id: "B1",
                actors: [], // No LSH actors for simplicity
                otherActors: ["non-existent-actor"], // Target that doesn't exist in context
              },
            ],
          },
        ],
      };
      service.updateSystemConfig(configWithOtherActor);
      setDeviceOnline(service, "device-sender");

      // Simulate that the context reader doesn't find the actor, returning undefined
      mockContextReader.get.mockReturnValue(undefined);

      // Execute the full transaction
      // Phase 1: Request
      service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });
      // Phase 2: Confirmation
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: true,
      });

      // Assert #1: The warning generated by getSmartToggleState must be present
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(
        "State for otherActor 'non-existent-actor' not found",
      );

      // Assert #2: The message for OtherActors must be correct
      expect(result.messages[Output.OtherActors]).toBeDefined();
      const otherActorMsg = result.messages[Output.OtherActors] as any;
      expect(otherActorMsg.otherActors).toEqual(["non-existent-actor"]);
      // The toggle logic, finding no actuators, will decide to turn off (false)
      expect(otherActorMsg.stateToSet).toBe(false);
      // Verify the specific payload
      expect(otherActorMsg.payload).toBe(
        "Set state=false for external actors.",
      );
    });

    it("should generate a specific c_asas command for a single targeted actuator", () => {
      // Advanced configuration with a single actuator as a target
      const advancedConfig: SystemConfig = {
        devices: [
          {
            name: "device-sender",
            longClickButtons: [
              {
                id: "B1",
                actors: [
                  {
                    name: "actor1",
                    allActuators: false, // <- Important: not all actuators
                    actuators: ["A2"], // <- Important: only a specific one
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

      // Setup: 'actor1' has 2 actuators, A1 and A2, both OFF.
      service.processMessage(`LSH/actor1/conf`, {
        p: "d_dd",
        dn: "actor1",
        ai: ["A1", "A2"],
        bi: [],
      });
      (service as any).deviceManager.updateConnectionState("actor1", "ready");
      (service as any).deviceManager.registerActuatorStates("actor1", [
        false,
        false,
      ]);

      // Phase 1: Request
      service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });
      // Phase 2: Confirmation
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: true,
      });

      // Assert: The LSH command must be the optimized 'c_asas' command.
      expect(result.messages[Output.Lsh]).toBeDefined();
      const lshCommands = result.messages[Output.Lsh] as any[];
      expect(lshCommands).toHaveLength(1);
      const command = lshCommands[0];

      expect(command.payload.p).toBe(LshProtocol.APPLY_SINGLE_ACTUATOR_STATE);
      expect(command.payload.ai).toBe("A2"); // Verify the actuator ID is correct
      expect(command.payload.as).toBe(true); // Smart-toggle will decide to turn ON
    });

    it("should fail validation if button is configured with no target actors", () => {
      // Configuration with a button that has neither actors nor otherActors
      const emptyButtonConfig: SystemConfig = {
        devices: [
          {
            name: "device-sender",
            longClickButtons: [{ id: "B1", actors: [], otherActors: [] }],
          },
        ],
      };
      service.updateSystemConfig(emptyButtonConfig);
      setDeviceOnline(service, "device-sender");

      // Act
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });

      // Assert
      expect((result.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.FAILOVER,
      );
      expect(result.messages[Output.Alerts]).toBeDefined();
      expect((result.messages[Output.Alerts] as any).payload).toContain(
        "Action configured with no targets.",
      );
    });

    it("should build correct state command for multiple specific actuators", () => {
      // Setup: A button config targeting a specific subset of actuators.
      const multiActorConfig: SystemConfig = {
        devices: [
          {
            name: "device-sender",
            longClickButtons: [
              {
                id: "B1",
                actors: [
                  {
                    name: "actor1",
                    allActuators: false, // Important: NOT all actuators
                    actuators: ["A1", "A3"], // Important: A specific subset of actuators
                  },
                ],
                otherActors: [],
              },
            ],
          },
          { name: "actor1" },
        ],
      };
      service.updateSystemConfig(multiActorConfig);

      // Setup: 'actor1' has 3 actuators, all OFF.
      service.processMessage(`LSH/actor1/conf`, {
        p: "d_dd",
        dn: "actor1",
        ai: ["A1", "A2", "A3"],
        bi: [],
      });
      (service as any).deviceManager.updateConnectionState("actor1", "ready");
      (service as any).deviceManager.registerActuatorStates("actor1", [
        false,
        false,
        false,
      ]);
      setDeviceOnline(service, "device-sender");

      // Phase 1: Request (ACK)
      const reqResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });
      expect((reqResult.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.NETWORK_CLICK_ACK,
      );

      // Phase 2: Confirmation and logic execution
      const confirmResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: true,
      });

      // Assert: The command should set all actuators' state (c_aas)
      // but only change the state for the targeted ones.
      expect(confirmResult.messages[Output.Lsh]).toBeDefined();
      const lshCommand = (confirmResult.messages[Output.Lsh] as any[])[0];

      // It should use the general 'apply all' state command.
      expect(lshCommand.payload.p).toBe(LshProtocol.APPLY_ALL_ACTUATORS_STATE);

      // The state array should reflect the change only for A1 and A3.
      // Initial state: [false, false, false]. Smart toggle turns them ON.
      expect(lshCommand.payload.as).toEqual([true, false, true]);
    });

    it("should correctly process a full SUPER LONG click transaction", () => {
      // Setup: A config with a super-long-click action defined.
      const slcConfig: SystemConfig = {
        devices: [
          {
            name: "device-sender",
            superLongClickButtons: [
              // <-- Using superLongClickButtons
              {
                id: "B1-slc",
                actors: [{ name: "actor1", allActuators: true, actuators: [] }],
                otherActors: [],
              },
            ],
          },
          { name: "actor1" },
        ],
      };
      service.updateSystemConfig(slcConfig);
      setDeviceOnline(service, "actor1");
      setDeviceOnline(service, "device-sender");

      // Set the initial state of the actor to ON, to see it turn OFF.
      (service as any).deviceManager.registerActuatorStates("actor1", [true]);

      // --- Phase 1: Request a super-long-click ---
      const reqResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1-slc",
        ct: ClickType.SuperLong, // <-- SuperLong click type
        c: false,
      });
      expect((reqResult.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.NETWORK_CLICK_ACK,
      );

      // --- Phase 2: Confirm the super-long-click ---
      const confirmResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1-slc",
        ct: ClickType.SuperLong, // <-- SuperLong click type
        c: true,
      });

      // Assert #1: Check for the specific log message.
      // This proves the target lines were executed.
      expect(confirmResult.logs).toContain(
        "Executing SLC logic: setting state to OFF.",
      );

      // Assert #2: Check that the generated command sets the state to OFF.
      expect(confirmResult.messages[Output.Lsh]).toBeDefined();
      const command = (confirmResult.messages[Output.Lsh] as any[])[0];
      expect(command.payload.as).toEqual([false]); // stateToSet should be false
    });

    it("should fail validation if a button action is configured but has no actor properties", () => {
      // Setup: A config where a button action exists but is an empty object
      // (missing 'actors' and 'otherActors' properties).
      const malformedButtonConfig: SystemConfig = {
        devices: [
          {
            name: "device-sender",
            longClickButtons: [
              {
                id: "B1",
                // 'actors' and 'otherActors' are intentionally missing
              } as any, // Use 'as any' to bypass TypeScript's strict type checking for the test
            ],
          },
        ],
      };
      service.updateSystemConfig(malformedButtonConfig);
      setDeviceOnline(service, "device-sender");

      // Act: Process a click for this malformed button config.
      const result = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });

      // Assert:
      // The destructuring on line 822 will succeed using default values.
      // The *next* check (`if (actors.length === 0 && otherActors.length === 0)`)
      // will then catch the error and throw. We verify that this subsequent
      // failure occurs correctly.
      expect((result.messages[Output.Lsh] as any).payload.p).toBe(
        LshProtocol.FAILOVER,
      );
      expect((result.messages[Output.Alerts] as any).payload).toContain(
        "Action configured with no targets.",
      );
    });

    it("should ignore non-existent actuator IDs when building state commands", () => {
      // Setup: A button config targeting a valid actuator ('A1') AND
      // a non-existent one ('A99').
      const mixedActuatorsConfig: SystemConfig = {
        devices: [
          {
            name: "device-sender",
            longClickButtons: [
              {
                id: "B1",
                actors: [
                  {
                    name: "actor1",
                    allActuators: false,
                    actuators: ["A1", "A99"], // 'A99' does not exist on actor1
                  },
                ],
                otherActors: [],
              },
            ],
          },
          { name: "actor1" },
        ],
      };
      service.updateSystemConfig(mixedActuatorsConfig);

      // Setup: 'actor1' only has actuators 'A1' and 'A2'. Both are OFF.
      service.processMessage(`LSH/actor1/conf`, {
        p: "d_dd",
        dn: "actor1",
        ai: ["A1", "A2"],
        bi: [],
      });
      (service as any).deviceManager.updateConnectionState("actor1", "ready");
      (service as any).deviceManager.registerActuatorStates("actor1", [
        false,
        false,
      ]);
      setDeviceOnline(service, "device-sender");

      // Act: Perform a full click transaction.
      service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: false,
      });
      const confirmResult = service.processMessage("LSH/device-sender/misc", {
        p: "c_nc",
        bi: "B1",
        ct: ClickType.Long,
        c: true,
      });

      // Assert:
      // The loop in `buildStateCommands` will run for 'A1' and 'A99'.
      // For 'A1', `index` will be 0, and the `if` is true.
      // For 'A99', `index` will be undefined, and the `if` is false, covering our branch.
      // The final state array should only have A1 changed.
      expect(confirmResult.messages[Output.Lsh]).toBeDefined();
      const lshCommand = (confirmResult.messages[Output.Lsh] as any[])[0];

      expect(lshCommand.payload.p).toBe(LshProtocol.APPLY_ALL_ACTUATORS_STATE);
      // Initial state: [false, false]. Smart toggle turns them ON.
      // Only A1 (index 0) should be affected. A2 (index 1) should remain unchanged.
      expect(lshCommand.payload.as).toEqual([true, false]);
    });
  });

  // --- WATCHDOG & VERIFICATION ---
  describe("Watchdog and Verification", () => {
    beforeEach(() => {
      service.updateSystemConfig(mockSystemConfig);
      // Simulate ALL devices being online and recently seen.
      // This creates a consistent starting point for watchdog tests.
      setDeviceOnline(service, "device-sender");
      setDeviceOnline(service, "actor1");
      setDeviceOnline(service, "device-silent");
    });

    it("should do nothing if watchdog runs with no silent devices", () => {
      const result = service.runWatchdogCheck();
      expect(Object.keys(result.messages)).toHaveLength(0);
    });

    it("should prepare a single broadcast ping if all devices are silent", () => {
      // Fast-forward time to make all devices appear silent
      const futureTime =
        Date.now() + (mockServiceConfig.interrogateThreshold + 1) * 1000;
      jest.spyOn(Date, "now").mockReturnValue(futureTime);

      const result = service.runWatchdogCheck();

      // We expect a single command, not an array
      expect(result.messages[Output.Lsh]).toBeDefined();
      expect(Array.isArray(result.messages[Output.Lsh])).toBe(false);

      const command = result.messages[Output.Lsh] as any;
      expect(command.topic).toBe(mockServiceConfig.serviceTopic);
      expect(command.payload.p).toBe(LshProtocol.PING);
      expect(
        result.logs.some((log) => log.includes("a single broadcast ping")),
      ).toBe(true);

      // Restore the original Date.now() function
      (Date.now as any).mockRestore();
    });

    it("should run initial verification and ping only silent devices", () => {
      // In this scenario, we start fresh and only bring two devices online.
      const freshService = new LshLogicService(
        mockServiceConfig,
        mockContextReader,
        mockValidators,
      );
      freshService.updateSystemConfig(mockSystemConfig);
      setDeviceOnline(freshService, "device-sender");
      setDeviceOnline(freshService, "actor1");

      const result = freshService.verifyInitialDeviceStates();
      expect(result.logs.some((l) => l.includes("Pinging them directly"))).toBe(
        true,
      );
      const pingCommands = result.messages[Output.Lsh] as any[];
      // device-sender and actor1 are online, so only device-silent should be pinged.
      expect(pingCommands).toHaveLength(1);
      expect(pingCommands[0].topic).toBe("LSH/device-silent/IN");
    });

    it("should run final verification and declare unresponsive devices unhealthy", () => {
      // First, ensure the device exists in the registry with a non-healthy state.
      // updateConnectionState with 'lost' ensures creation and sets connected=false, isHealthy=false.
      (service as any).deviceManager.updateConnectionState(
        "device-silent",
        "lost",
      );

      const pingedDevices = ["device-silent"];
      const result = service.runFinalVerification(pingedDevices);

      expect(result.warnings).toContain(
        "Final verification failed for: device-silent",
      );
      expect(result.messages[Output.Alerts]).toBeDefined();

      // Now we can safely get the device and check its state
      const device = (service as any).deviceManager.getDevice("device-silent");
      expect(device).toBeDefined();
      expect(device!.isHealthy).toBe(false); // Should remain unhealthy
    });

    it("should succeed final verification if device responds", () => {
      // Device becomes healthy after being pinged.
      setDeviceOnline(service, "device-silent");
      const result = service.runFinalVerification(["device-silent"]);
      expect(
        result.logs.some((l) => l.includes("Final verification successful")),
      ).toBe(true);
      expect(result.messages[Output.Alerts]).toBeUndefined();
    });
    it("should succeed initial and final verification if all devices are responsive", () => {
      // For initial verification, create a fresh service
      const freshService = new LshLogicService(
        mockServiceConfig,
        mockContextReader,
        mockValidators,
      );
      freshService.updateSystemConfig(mockSystemConfig);

      // Setup: ALL devices are online
      setDeviceOnline(freshService, "device-sender");
      setDeviceOnline(freshService, "actor1");
      setDeviceOnline(freshService, "device-silent");

      // 1. Test verifyInitialDeviceStates (success case)
      const initialResult = freshService.verifyInitialDeviceStates();
      expect(initialResult.messages[Output.Lsh]).toBeUndefined(); // No pings sent
      expect(initialResult.logs).toContain(
        "Initial state verification: all configured devices are connected.",
      );

      // 2. Test runFinalVerification (success case)
      const finalResult = freshService.runFinalVerification(["actor1"]); // Pass a device that is already online
      expect(finalResult.messages[Output.Alerts]).toBeUndefined(); // No alerts generated
      expect(finalResult.logs).toContain(
        "Final verification successful: all pinged devices responded.",
      );
    });

    it("should declare a never-seen device as unhealthy and set its alertSent flag", () => {
      // Configuration with a "ghost" device that will never send messages.
      const configWithGhost = {
        devices: [{ name: "ghost-device" }, { name: "active-device" }],
      };
      service.updateSystemConfig(configWithGhost);
      setDeviceOnline(service, "active-device"); // Only one of the two is online.

      // Advance time to trigger the watchdog.
      const futureTime =
        Date.now() + (mockServiceConfig.interrogateThreshold + 1) * 1000;
      jest.spyOn(Date, "now").mockReturnValue(futureTime);

      // Act
      const result = service.runWatchdogCheck();

      // Assert: Check the alert
      expect(result.messages[Output.Alerts]).toBeDefined();
      const alertPayload = (result.messages[Output.Alerts] as any).payload;
      expect(alertPayload).toContain("ghost-device");
      expect(alertPayload).toContain("Never seen on the network");

      // KEY Assert: Verify that the 'alertSent' flag has been set on the device.
      // The device is created implicitly by the watchdog when it's declared "unhealthy".
      const ghostDeviceState = (service as any).deviceManager.getDevice(
        "ghost-device",
      );
      expect(ghostDeviceState).toBeDefined();
      expect(ghostDeviceState.alertSent).toBe(true);

      (Date.now as any).mockRestore();
    });

    it("should skip watchdog checks for a device already marked as unhealthy and alerted", () => {
      // Setup: Ensure all devices exist
      const silentDevice = (service as any).deviceManager.getDevice(
        "device-silent",
      );
      const senderDevice = (service as any).deviceManager.getDevice(
        "device-sender",
      );
      const actorDevice = (service as any).deviceManager.getDevice("actor1");

      // Set 'device-silent' as unhealthy and already alerted
      silentDevice.isHealthy = false;
      silentDevice.alertSent = true;

      // Move time forward
      const futureTime =
        Date.now() + (mockServiceConfig.interrogateThreshold + 1) * 1000;
      jest.spyOn(Date, "now").mockReturnValue(futureTime);

      // Now, in the 'future', update 'actor1' to make it look recently seen
      actorDevice.lastSeenTime = futureTime;

      // 'senderDevice' still has its old lastSeenTime, so it is now the only silent device.

      // Act
      const result = service.runWatchdogCheck();

      // Assert
      // 1. No alert should be present
      expect(result.messages[Output.Alerts]).toBeUndefined();

      // 2. Only 'device-sender' should be pinged.
      expect(result.messages[Output.Lsh]).toBeDefined();
      const pingCommands = result.messages[Output.Lsh] as any[];
      expect(pingCommands).toHaveLength(1);
      expect(pingCommands[0].topic).toBe("LSH/device-sender/IN");

      (Date.now as any).mockRestore();
    });

    it("should mark a device as stale and prepare a new ping if the first ping times out", () => {
      // Setup
      const staleDevice = (service as any).deviceManager.getDevice(
        "device-silent",
      );
      const otherDevice1 = (service as any).deviceManager.getDevice(
        "device-sender",
      );
      const otherDevice2 = (service as any).deviceManager.getDevice("actor1");

      // === Phase 1: 'staleDevice' becomes silent and gets pinged ===
      let currentTime = Date.now();
      staleDevice.lastSeenTime =
        currentTime - (mockServiceConfig.interrogateThreshold + 1) * 1000;
      // The other devices are "recent"
      otherDevice1.lastSeenTime = currentTime;
      otherDevice2.lastSeenTime = currentTime;
      jest.spyOn(Date, "now").mockReturnValue(currentTime);

      let result = service.runWatchdogCheck();
      // At this point, the watchdog has sent a ping only to 'staleDevice'.

      // === Phase 2: The ping expires ===
      // Let's advance time beyond the ping timeout
      currentTime += (mockServiceConfig.pingTimeout + 1) * 1000;
      (Date.now as any).mockReturnValue(currentTime);

      // Update the other devices again to prevent them from becoming silent
      otherDevice1.lastSeenTime = currentTime;
      otherDevice2.lastSeenTime = currentTime;

      // Run the watchdog again
      result = service.runWatchdogCheck();

      // Assert
      // 1. An alert must be prepared for the "stale" device
      expect(result.messages[Output.Alerts]).toBeDefined();
      const alertPayload = (result.messages[Output.Alerts] as any).payload;
      expect(alertPayload).toContain("device-silent");
      expect(alertPayload).toContain("No response to ping.");

      // 2. A *new* ping must be prepared ONLY for 'device-silent'
      expect(result.messages[Output.Lsh]).toBeDefined();
      // We now expect an array because only one of three devices was pinged
      const pingCommands = result.messages[Output.Lsh] as any[];
      expect(Array.isArray(pingCommands)).toBe(true);
      expect(pingCommands).toHaveLength(1);
      expect(pingCommands[0].topic).toBe("LSH/device-silent/IN");

      // 3. The device's internal state must be 'stale'
      expect(staleDevice.isStale).toBe(true);

      (Date.now as any).mockRestore();
    });

    it("should set stateChanged to true when final verification marks a stale device as unhealthy", () => {
      // Setup: Create a device that is 'stale'. This is a complex state to achieve,
      // let's manually set it. A device can be unhealthy but also stale if it missed a ping.
      const deviceName = "device-silent";
      setDeviceOnline(service, deviceName);
      const device = (service as any).deviceManager.getDevice(deviceName);
      device.isHealthy = false;
      device.isStale = true;

      // Pre-assertion: Check the initial state
      expect(device.isStale).toBe(true);
      expect(device.isHealthy).toBe(false);

      // Act: Run final verification on this stale, unhealthy device.
      const result = service.runFinalVerification([deviceName]);

      // Assert
      // The device is unhealthy, so the `if (!deviceState.isHealthy)` block is entered.
      // `updateHealthFromResult` will be called. It will change the state from
      // { isHealthy: false, isStale: true } to { isHealthy: false, isStale: false }.
      // This IS a state change.
      expect(result.stateChanged).toBe(true);

      // Check the final state
      const finalDeviceState = (service as any).deviceManager.getDevice(
        deviceName,
      );
      expect(finalDeviceState.isHealthy).toBe(false);
      expect(finalDeviceState.isStale).toBe(false);
    });

    it("should do nothing if watchdog runs without a loaded config", () => {
      // Setup: Ensure the service has no system config loaded.
      service.clearSystemConfig();

      // Act: Run the watchdog check.
      const result = service.runWatchdogCheck();

      // Assert: The method should exit early, returning an empty result.
      // This proves the early `return` statement was hit.
      expect(result.messages).toEqual({});
      expect(result.logs).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.stateChanged).toBe(false);
    });

    it("should handle final verification for a device that is not in the registry", () => {
      // Setup: Ensure the service has a config, but the target device is not in the registry.
      service.updateSystemConfig(mockSystemConfig);
      const ghostDeviceName = "device-that-never-spoke";
      const pingedDevices = [ghostDeviceName];

      // Pre-assertion: Make sure the device is not in the registry.
      const initialRegistry = service.getDeviceRegistry();
      expect(initialRegistry[ghostDeviceName]).toBeUndefined();

      // Act: Run final verification for this non-existent device.
      const result = service.runFinalVerification(pingedDevices);

      // Assert:
      // 1. An alert should be prepared for the ghost device.
      expect(result.messages[Output.Alerts]).toBeDefined();
      const alertPayload = (result.messages[Output.Alerts] as any).payload;
      expect(alertPayload).toContain(ghostDeviceName);

      // 2. The state should be marked as changed because an unhealthy device was found.
      expect(result.stateChanged).toBe(true);

      // 3. The device should still not exist in the registry, because the `if (deviceState)`
      // block was correctly skipped.
      const finalRegistry = service.getDeviceRegistry();
      expect(finalRegistry[ghostDeviceName]).toBeUndefined();
    });

    it("should mark state as changed when a device is marked unhealthy for the first time", () => {
      // Use a clean service instance to avoid state from beforeEach
      const freshService = new LshLogicService(
        mockServiceConfig,
        mockContextReader,
        mockValidators,
      );
      freshService.updateSystemConfig(mockSystemConfig);
      const deviceName = "device-silent";

      // Pre-condition: The device exists but is healthy and has not had an alert sent.
      setDeviceOnline(freshService, deviceName);
      const device = (freshService as any).deviceManager.getDevice(deviceName);
      expect(device.alertSent).toBe(false);

      // We need the watchdog to return 'unhealthy'. We can force this by mocking it.
      jest
        .spyOn((freshService as any).watchdog, "checkDeviceHealth")
        .mockReturnValue({
          status: "unhealthy",
          reason: "Forced for test",
        });

      // Act: Run the watchdog check.
      const result = freshService.runWatchdogCheck();

      // Assert:
      // 1. The device is found unhealthy.
      // 2. `recordAlertSent` is called for the first time, returning `stateChanged: true`.
      // 3. The `if (stateChanged)` block is executed, setting the overall result's stateChanged to true.
      expect(result.stateChanged).toBe(true);

      // Verify the side-effect on the device state
      const finalDeviceState = (freshService as any).deviceManager.getDevice(
        deviceName,
      );
      expect(finalDeviceState.alertSent).toBe(true);

      // Cleanup the spy
      (
        (freshService as any).watchdog.checkDeviceHealth as jest.Mock
      ).mockRestore();
    });
  });
});
