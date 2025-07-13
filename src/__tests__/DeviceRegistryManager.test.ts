/**
 * @file Unit tests for the DeviceRegistryManager class.
 * These tests verify the state management logic for all devices.
 */
import { DeviceRegistryManager } from "../DeviceRegistryManager";
import {
  DeviceDetailsPayload,
  Actor,
  LshProtocol,
  DeviceState,
} from "../types";
import { WatchdogResult } from "../Watchdog";

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
    // Calling a public method that internally uses the private _ensureDeviceExists.
    manager.registerActuatorStates("new-device", [true]);
    const registry = manager.getRegistry();

    expect(registry["new-device"]).toBeDefined();
    expect(registry["new-device"].name).toBe("new-device");
    // A new device should start as disconnected until proven otherwise.
    expect(registry["new-device"].connected).toBe(false);
  });

  it("should store device details and initialize actuator states and indexes", () => {
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
    // Actuator states should be initialized to false for the correct length.
    expect(deviceState?.actuatorStates).toEqual([false, false]);
    expect(deviceState?.actuatorIndexes).toEqual({ A1: 0, A2: 1 });
  });

  it("should throw an error if actuator state length mismatches config", () => {
    manager.registerDeviceDetails("device-1", {
      p: LshProtocol.DEVICE_DETAILS,
      dn: "device-1",
      ai: ["A1"],
      bi: [],
    });
    expect(() => {
      manager.registerActuatorStates("device-1", [true, false]);
    }).toThrow("State mismatch for device-1: expected 1 states, received 2.");
  });

  it("should prune a device from the registry", () => {
    manager.registerDeviceDetails("device-to-prune", {
      p: LshProtocol.DEVICE_DETAILS,
      dn: "d",
      ai: [],
      bi: [],
    });
    expect(manager.getDevice("device-to-prune")).toBeDefined();

    manager.pruneDevice("device-to-prune");
    expect(manager.getDevice("device-to-prune")).toBeUndefined();
  });

  describe("updateConnectionState (Homie)", () => {
    it("should mark a device as connected and report cameOnline on 'ready'", () => {
      // First, ensure the device exists but is offline
      manager.updateConnectionState("device-1", "init");
      const { changed, connected, wentOffline, cameOnline } =
        manager.updateConnectionState("device-1", "ready");
      const device = manager.getDevice("device-1");
      expect(changed).toBe(true);
      expect(connected).toBe(true);
      expect(device?.connected).toBe(true);
      expect(device?.isHealthy).toBe(true);
      expect(wentOffline).toBe(false);
      expect(cameOnline).toBe(true);
    });

    it("should mark a device as disconnected and report wentOffline on 'lost'", () => {
      manager.updateConnectionState("device-1", "ready"); // Start as ready
      const { changed, connected, wentOffline, cameOnline } =
        manager.updateConnectionState("device-1", "lost");
      const device = manager.getDevice("device-1");
      expect(changed).toBe(true);
      expect(connected).toBe(false);
      expect(device?.connected).toBe(false);
      expect(device?.isHealthy).toBe(false);
      expect(wentOffline).toBe(true);
      expect(cameOnline).toBe(false);
    });

    it("should not report a change if the state is the same", () => {
      manager.updateConnectionState("device-1", "ready");
      const { changed, wentOffline, cameOnline } =
        manager.updateConnectionState("device-1", "ready");
      expect(changed).toBe(false);
      expect(wentOffline).toBe(false);
      expect(cameOnline).toBe(false);
    });
  });

  describe("recordBoot", () => {
    it("should mark a device as connected and healthy on boot", () => {
      const { stateChanged } = manager.recordBoot("boot-device");
      const device = manager.getDevice("boot-device");
      expect(stateChanged).toBe(true);
      expect(device?.connected).toBe(true);
      expect(device?.isHealthy).toBe(true);
      expect(device?.lastBootTime).toBeGreaterThan(0);
    });
  });

  describe("updateHealthFromResult (Watchdog)", () => {
    beforeEach(() => {
      manager.registerDeviceDetails("health-test-dev", { p: LshProtocol.DEVICE_DETAILS, dn: "d", ai: [], bi: [] });
    });

    it("should update health to OK and clear stale flag", () => {
      const device = manager.getDevice("health-test-dev")!;
      device.isHealthy = false;
      device.isStale = true;
      const result: WatchdogResult = { status: "ok" };
      const { stateChanged } = manager.updateHealthFromResult("health-test-dev", result);
      expect(stateChanged).toBe(true);
      expect(device.isHealthy).toBe(true);
      expect(device.isStale).toBe(false);
    });

    it("should update state to STALE", () => {
      const device = manager.getDevice("health-test-dev")!;
      const result: WatchdogResult = { status: "stale" };
      const { stateChanged } = manager.updateHealthFromResult("health-test-dev", result);
      expect(stateChanged).toBe(true);
      expect(device.isStale).toBe(true);
    });

    it("should not change state if already stale", () => {
      const device = manager.getDevice("health-test-dev")!;
      device.isStale = true;
      const result: WatchdogResult = { status: "stale" };
      const { stateChanged } = manager.updateHealthFromResult("health-test-dev", result);
      expect(stateChanged).toBe(false);
    });

    it("should update health to UNHEALTHY and clear stale flag", () => {
      const device = manager.getDevice("health-test-dev")!;
      device.isHealthy = true;
      device.isStale = true;
      const result: WatchdogResult = { status: "unhealthy", reason: "test" };
      const { stateChanged } = manager.updateHealthFromResult("health-test-dev", result);
      expect(stateChanged).toBe(true);
      expect(device.isHealthy).toBe(false);
      expect(device.isStale).toBe(false);
    });

    it("should not change state if already unhealthy", () => {
      const device = manager.getDevice("health-test-dev")!;
      device.isHealthy = false;
      device.isStale = false;
      const result: WatchdogResult = { status: "unhealthy", reason: "test" };
      const { stateChanged } = manager.updateHealthFromResult("health-test-dev", result);
      expect(stateChanged).toBe(false);
    });

    it("should not change state for 'needs_ping'", () => {
      const device = manager.getDevice("health-test-dev") as DeviceState;
      const initialState = { ...device };
      const result: WatchdogResult = { status: "needs_ping" };
      const { stateChanged } = manager.updateHealthFromResult("health-test-dev", result);
      expect(stateChanged).toBe(false);
      expect(manager.getDevice("health-test-dev")).toEqual(initialState);
    });

    it("should return { stateChanged: false } for a non-existent device", () => {

      const nonExistentDevice = "ghost-device";
      const anyWatchdogResult: WatchdogResult = { status: "ok" };

      const result = manager.updateHealthFromResult(
        nonExistentDevice,
        anyWatchdogResult
      );
      expect(result.stateChanged).toBe(false);
      expect(manager.getDevice(nonExistentDevice)).toBeUndefined();
    });

  });

  describe("getSmartToggleState", () => {
    beforeEach(() => {
      manager.registerDeviceDetails("light-group", { p: LshProtocol.DEVICE_DETAILS, dn: "lg", ai: ["L1", "L2", "L3", "L4"], bi: [] });
    });

    it("should return true when less than 50% of actuators are on", () => {
      manager.registerActuatorStates("light-group", [true, false, false, false]);
      const actors: Actor[] = [{ name: "light-group", allActuators: true, actuators: [] }];
      const result = manager.getSmartToggleState(actors, []);
      expect(result.stateToSet).toBe(true);
      expect(result.active).toBe(1);
      expect(result.total).toBe(4);
    });

    it("should return false when 50% or more actuators are on", () => {
      manager.registerActuatorStates("light-group", [true, true, false, false]);
      const actors: Actor[] = [{ name: "light-group", allActuators: true, actuators: [] }];
      const result = manager.getSmartToggleState(actors, []);
      expect(result.stateToSet).toBe(false);
    });

    it("should correctly calculate state for a specific subset of actuators", () => {
      manager.registerActuatorStates("light-group", [true, false, true, false]); // L1 and L3 are ON
      // Target only L1 and L2. One is on, one is off. 1/2 = 50%, so turn OFF.
      const actors: Actor[] = [{ name: "light-group", allActuators: false, actuators: ["L1", "L2"] }];
      const result = manager.getSmartToggleState(actors, []);
      expect(result.stateToSet).toBe(false);
      expect(result.active).toBe(1);
      expect(result.total).toBe(2);
    });

    it("should correctly handle multiple otherActors with different states", () => {
      // LSH devices are all OFF.
      manager.registerActuatorStates("light-group", [false, false, false, false]);

      mockContextReader.get
        .mockReturnValueOnce(true)    // external-on is ON
        .mockReturnValueOnce(false);   // external-off is OFF

      const actors: Actor[] = [{ name: "light-group", allActuators: true, actuators: [] }];
      const otherActors = ["external-on", "external-off"];
      const result = manager.getSmartToggleState(actors, otherActors);

      // Total actuators = 4 (LSH) + 2 (other) = 6
      // Active actuators = 0 (LSH) + 1 (other) = 1
      // 1/6 < 0.5, so stateToSet should be true.
      expect(result.stateToSet).toBe(true);
      expect(result.total).toBe(6);
      expect(result.active).toBe(1);
      expect(result.warning).toBe(""); // No warnings
    });

    it("should handle the case where only a non-existent otherActor is specified", () => {
      // No LSH actors are provided, only an otherActor that doesn't exist in context.
      mockContextReader.get.mockReturnValue(undefined);

      const result = manager.getSmartToggleState([], ["non-existent-actor"]);

      // This hits totalCount === 0 and the warning is not empty.
      expect(result.stateToSet).toBe(false); // Default
      expect(result.total).toBe(0);
      expect(result.active).toBe(0);
      // This is the key assertion to cover the `warning ? warning : ...` branch.
      expect(result.warning).toContain("State for otherActor 'non-existent-actor' not found");
    });

    it("should ignore LSH actuators with undefined indexes", () => {
      manager.registerActuatorStates("light-group", [true, true, true, true]);
      const actors: Actor[] = [{ name: "light-group", allActuators: false, actuators: ["L1", "non-existent"] }];
      const result = manager.getSmartToggleState(actors, []);

      // Should only count L1 which is on. Total is 1. Active is 1. 1/1 > 50% -> turn OFF.
      expect(result.total).toBe(1);
      expect(result.active).toBe(1);
      expect(result.stateToSet).toBe(false);
    });

    it("should return false with a warning if no valid actuators are found at all", () => {
      const actors: Actor[] = [{ name: "non-existent-device", allActuators: true, actuators: [] }];
      const result = manager.getSmartToggleState(actors, []);
      expect(result.stateToSet).toBe(false);
      expect(result.total).toBe(0);
      expect(result.warning).toContain("No valid actuators found");
    });
  });

  describe("recordPingResponse", () => {
    it("should mark a previously unhealthy device as healthy", () => {
      manager.updateConnectionState("offline-device", "lost"); // unhealthy
      const { stateChanged, cameOnline } = manager.recordPingResponse("offline-device");
      const device = manager.getDevice("offline-device")!;
      expect(stateChanged).toBe(true);
      expect(cameOnline).toBe(true);
      expect(device.isHealthy).toBe(true);
    });

    it("should mark a previously stale device as healthy", () => {
      manager.updateConnectionState("stale-device", "ready");
      const device = manager.getDevice("stale-device")!;
      device.isStale = true; // Make it stale
      device.isHealthy = true;

      const { stateChanged, cameOnline } = manager.recordPingResponse("stale-device");

      expect(stateChanged).toBe(true);
      expect(cameOnline).toBe(true);
      expect(device.isHealthy).toBe(true);
      expect(device.isStale).toBe(false); // Should be cleared
    });
  });

  describe("recordAlertSent", () => {
    it("should mark a new device as unhealthy and with alert sent", () => {
      const { stateChanged } = manager.recordAlertSent("alert-device");
      const device = manager.getDevice("alert-device")!;

      expect(stateChanged).toBe(true);
      expect(device.isHealthy).toBe(false);
      expect(device.alertSent).toBe(true);
    });

    it("should return stateChanged: false if an alert has already been sent", () => {
      // First call, the state changes
      manager.recordAlertSent("alert-device");

      // Second call, on the same device
      const { stateChanged } = manager.recordAlertSent("alert-device");

      // The state should not change
      expect(stateChanged).toBe(false);
    });
  });
});
