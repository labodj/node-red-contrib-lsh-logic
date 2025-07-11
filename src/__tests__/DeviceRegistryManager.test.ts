/**
 * @file Unit tests for the DeviceRegistryManager class.
 */
import { DeviceRegistryManager } from "../DeviceRegistryManager";
import { DeviceDetailsPayload, Actor, LshProtocol } from "../types";

describe("DeviceRegistryManager", () => {
  /** The instance of the DeviceRegistryManager class under test. */
  let manager: DeviceRegistryManager;
  /** A mock context reader to simulate reading from Node-RED's flow/global context. */
  let mockContextReader: { get: jest.Mock };

  beforeEach(() => {
    mockContextReader = { get: jest.fn() };
    manager = new DeviceRegistryManager("other_devices", mockContextReader);
  });

  it("should create a shell device when storing state for an unknown device", () => {
    // Calling a public method that internally uses the private one.
    manager.registerActuatorStates("new-device", [true]);
    const registry = manager.getRegistry();

    expect(registry["new-device"]).toBeDefined();
    expect(registry["new-device"].name).toBe("new-device");
    expect(registry["new-device"].connected).toBe(false);
  });

  it("should store device details for a new device", () => {
    const details: DeviceDetailsPayload = {
      p: LshProtocol.DEVICE_DETAILS,
      dn: "new-device",
      ai: ["A1", "A2"],
      bi: ["B1"],
    };
    manager.registerDeviceDetails("new-device", details);
    const deviceState = manager.getDevice("new-device");

    expect(deviceState).toBeDefined();
    expect(deviceState?.actuatorsIDs).toEqual(["A1", "A2"]);
    expect(deviceState?.actuatorStates).toEqual([false, false]);
  });

  describe("getSmartToggleState", () => {
    it("should return true when less than 50% of actuators are on", () => {
      manager.registerDeviceDetails("light-group", {
        p: LshProtocol.DEVICE_DETAILS,
        dn: "light-group",
        ai: ["L1", "L2", "L3", "L4"],
        bi: [],
      });
      manager.registerActuatorStates("light-group", [true, false, false, false]);
      const actors: Actor[] = [
        { name: "light-group", allActuators: true, actuators: [] },
      ];

      const result = manager.getSmartToggleState(actors, []);
      expect(result.stateToSet).toBe(true);
      expect(result.active).toBe(1);
      expect(result.total).toBe(4);
    });

    it("should return false when 50% or more actuators are on", () => {
      manager.registerDeviceDetails("light-group", {
        p: LshProtocol.DEVICE_DETAILS,
        dn: "light-group",
        ai: ["L1", "L2", "L3", "L4"],
        bi: [],
      });
      manager.registerActuatorStates("light-group", [true, true, false, false]);
      const actors: Actor[] = [
        { name: "light-group", allActuators: true, actuators: [] },
      ];

      const result = manager.getSmartToggleState(actors, []);
      expect(result.stateToSet).toBe(false);
    });

    it("should include otherActors from context in calculation", () => {
      manager.registerDeviceDetails("light-group", {
        p: LshProtocol.DEVICE_DETAILS,
        dn: "light-group",
        ai: ["L1"],
        bi: [],
      });
      manager.registerActuatorStates("light-group", [false]); // 0/1 LSH actors are on
      mockContextReader.get.mockReturnValue(true); // External actor is on

      const actors: Actor[] = [
        { name: "light-group", allActuators: true, actuators: [] },
      ];
      const otherActors = ["external-light"];

      const result = manager.getSmartToggleState(actors, otherActors);

      // Total is 2 (1 LSH, 1 external). 1 is on. 1/2 = 50%. So should turn off.
      expect(result.stateToSet).toBe(false);
      expect(mockContextReader.get).toHaveBeenCalledWith(
        "other_devices.external-light.state"
      );
    });
  });
});