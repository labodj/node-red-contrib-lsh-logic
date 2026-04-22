/**
 * @file Unit tests for the DeviceRegistryManager class.
 * These tests verify the state management logic for all devices.
 */
import { DeviceRegistryManager } from "../DeviceRegistryManager";
import type { DeviceDetailsPayload, Actor, DeviceState } from "../types";
import { LSH_WIRE_PROTOCOL_MAJOR, LshProtocol } from "../types";
import type { WatchdogResult } from "../Watchdog";

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

  it("should store device details, initialize indexes, and leave state unauthoritative until a state frame arrives", () => {
    const details: DeviceDetailsPayload = {
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "new-device",
      a: [1, 2],
      b: [1],
    };
    manager.registerDeviceDetails("new-device", details);
    const deviceState = manager.getDevice("new-device");

    expect(deviceState).toBeDefined();
    expect(deviceState?.actuatorsIDs).toEqual([1, 2]);
    expect(deviceState?.actuatorStates).toEqual([]);
    expect(deviceState?.lastStateTime).toBe(0);
    expect(deviceState?.actuatorIndexes).toEqual({ 1: 0, 2: 1 });
  });

  it("returns a stable snapshot that is not mutated by later internal updates", () => {
    manager.registerDeviceDetails("snap-device", {
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "snap-device",
      a: [1],
      b: [],
    });
    manager.registerActuatorStates("snap-device", [false]);

    const firstSnapshot = manager.getRegistry();

    manager.registerActuatorStates("snap-device", [true]);

    expect(firstSnapshot["snap-device"].actuatorStates).toEqual([false]);
    expect(manager.getRegistry()["snap-device"].actuatorStates).toEqual([true]);
  });

  it("returns frozen nested snapshot collections so exposed registry reads stay detached", () => {
    manager.registerDeviceDetails("snap-device", {
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "snap-device",
      a: [1],
      b: [],
    });
    manager.registerActuatorStates("snap-device", [false]);

    const snapshot = manager.getRegistry()["snap-device"];

    expect(Object.isFrozen(snapshot.actuatorStates)).toBe(true);
    expect(Object.isFrozen(snapshot.actuatorIndexes)).toBe(true);
    expect(Reflect.set(snapshot.actuatorStates, 0, true)).toBe(false);
    expect(Reflect.set(snapshot.actuatorIndexes, 1, 99)).toBe(false);

    const freshSnapshot = manager.getRegistry()["snap-device"];
    expect(freshSnapshot.actuatorStates).toEqual([false]);
    expect(freshSnapshot.actuatorIndexes).toEqual({ 1: 0 });
  });

  it("should throw an error if actuator state length mismatches config", () => {
    manager.registerDeviceDetails("device-1", {
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "device-1",
      a: [1],
      b: [],
    });
    expect(() => {
      manager.registerActuatorStates("device-1", [true, false]);
    }).toThrow("State mismatch for device-1: expected 1 states, received 2.");
  });

  it("should prune a device from the registry", () => {
    manager.registerDeviceDetails("device-to-prune", {
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "d",
      a: [],
      b: [],
    });
    expect(manager.getDevice("device-to-prune")).toBeDefined();

    manager.pruneDevice("device-to-prune");
    expect(manager.getDevice("device-to-prune")).toBeUndefined();
  });

  describe("updateConnectionState (Homie)", () => {
    it("should update bridge reachability on ready/lost transitions and report changes", () => {
      manager.recordHomieLifecycleState("device-1", "init");

      const readyResult = manager.updateBridgeConnectionState("device-1", "ready");
      const readyDevice = manager.getDevice("device-1");

      expect(readyResult.stateChanged).toBe(true);
      expect(readyDevice?.bridgeConnected).toBe(true);
      expect(readyDevice?.connected).toBe(false);

      manager.recordControllerActivity("device-1");

      const lostResult = manager.updateBridgeConnectionState("device-1", "lost");
      const lostDevice = manager.getDevice("device-1");

      expect(lostResult.stateChanged).toBe(true);
      expect(lostDevice?.bridgeConnected).toBe(false);
      expect(lostDevice?.connected).toBe(false);
      expect(lostDevice?.isHealthy).toBe(false);
    });

    it("should not report a change if the state is the same", () => {
      manager.updateBridgeConnectionState("device-1", "ready");
      const { stateChanged } = manager.updateBridgeConnectionState("device-1", "ready");
      expect(stateChanged).toBe(false);
    });
  });

  describe("recordHomieLifecycleState", () => {
    it("should store the raw Homie lifecycle state and update bridgeLastSeenTime for live messages", () => {
      const before = Date.now();
      const { stateChanged } = manager.recordHomieLifecycleState("device-1", "init");
      const device = manager.getDevice("device-1");

      expect(stateChanged).toBe(true);
      expect(device?.lastHomieState).toBe("init");
      expect(device?.lastHomieStateTime).toBeGreaterThanOrEqual(before);
      expect(device?.bridgeLastSeenTime).toBe(device?.lastHomieStateTime);
    });

    it("should update diagnostics without changing bridgeLastSeenTime for retained messages", () => {
      manager.recordHomieLifecycleState("device-1", "ready");
      const initialBridgeLastSeenTime = manager.getDevice("device-1")!.bridgeLastSeenTime;

      const { stateChanged } = manager.recordHomieLifecycleState("device-1", "sleeping", false);
      const device = manager.getDevice("device-1");

      expect(stateChanged).toBe(true);
      expect(device?.lastHomieState).toBe("sleeping");
      expect(device?.bridgeLastSeenTime).toBe(initialBridgeLastSeenTime);
    });
  });

  describe("updateHealthFromResult (Watchdog)", () => {
    beforeEach(() => {
      manager.registerDeviceDetails("health-test-dev", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "d",
        a: [],
        b: [],
      });
    });

    it("should update health state transitions from watchdog results", () => {
      const cases: Array<{
        setup: (device: DeviceState) => void;
        result: WatchdogResult;
        expectedStateChanged: boolean;
        assert: (device: DeviceState) => void;
      }> = [
        {
          setup: (device) => {
            device.isHealthy = false;
            device.isStale = true;
          },
          result: { status: "ok" },
          expectedStateChanged: true,
          assert: (device) => {
            expect(device.isHealthy).toBe(true);
            expect(device.isStale).toBe(false);
          },
        },
        {
          setup: () => {},
          result: { status: "stale" },
          expectedStateChanged: true,
          assert: (device) => {
            expect(device.isStale).toBe(true);
          },
        },
        {
          setup: (device) => {
            device.isStale = true;
          },
          result: { status: "stale" },
          expectedStateChanged: false,
          assert: (device) => {
            expect(device.isStale).toBe(true);
          },
        },
        {
          setup: (device) => {
            device.isHealthy = true;
            device.isStale = true;
          },
          result: { status: "unhealthy", reason: "test" },
          expectedStateChanged: true,
          assert: (device) => {
            expect(device.isHealthy).toBe(false);
            expect(device.isStale).toBe(false);
          },
        },
        {
          setup: (device) => {
            device.isHealthy = false;
            device.isStale = false;
          },
          result: { status: "unhealthy", reason: "test" },
          expectedStateChanged: false,
          assert: (device) => {
            expect(device.isHealthy).toBe(false);
            expect(device.isStale).toBe(false);
          },
        },
      ];

      for (const testCase of cases) {
        manager.reset();
        manager.registerDeviceDetails("health-test-dev", {
          p: LshProtocol.DEVICE_DETAILS,
          v: LSH_WIRE_PROTOCOL_MAJOR,
          n: "d",
          a: [],
          b: [],
        });

        const device = manager.getDevice("health-test-dev")!;
        testCase.setup(device);

        const { stateChanged } = manager.updateHealthFromResult("health-test-dev", testCase.result);

        expect(stateChanged).toBe(testCase.expectedStateChanged);
        testCase.assert(device);
      }
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

      const result = manager.updateHealthFromResult(nonExistentDevice, anyWatchdogResult);
      expect(result.stateChanged).toBe(false);
      expect(manager.getDevice(nonExistentDevice)).toBeUndefined();
    });
  });

  describe("getSmartToggleState", () => {
    beforeEach(() => {
      manager.registerDeviceDetails("light-group", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "lg",
        a: [1, 2, 3, 4],
        b: [],
      });
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
      const actors: Actor[] = [{ name: "light-group", allActuators: false, actuators: [1, 2] }];
      const result = manager.getSmartToggleState(actors, []);
      expect(result.stateToSet).toBe(false);
      expect(result.active).toBe(1);
      expect(result.total).toBe(2);
    });

    it("should correctly handle multiple otherActors with different states", () => {
      // LSH devices are all OFF.
      manager.registerActuatorStates("light-group", [false, false, false, false]);

      mockContextReader.get
        .mockReturnValueOnce(true) // external-on is ON
        .mockReturnValueOnce(false); // external-off is OFF

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
      const actors: Actor[] = [{ name: "light-group", allActuators: false, actuators: [1, 999] }];
      const result = manager.getSmartToggleState(actors, []);

      // Should only count L1 which is on. Total is 1. Active is 1. 1/1 > 50% -> turn OFF.
      expect(result.total).toBe(1);
      expect(result.active).toBe(1);
      expect(result.stateToSet).toBe(false);
    });

    it("should ignore devices whose state is not authoritative yet and surface a warning", () => {
      manager.registerActuatorStates("light-group", [true, false, false, false]);
      manager.registerDeviceDetails("snapshot-only", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "snapshot-only",
        a: [9, 10],
        b: [],
      });

      const actors: Actor[] = [
        { name: "light-group", allActuators: true, actuators: [] },
        { name: "snapshot-only", allActuators: true, actuators: [] },
      ];
      const result = manager.getSmartToggleState(actors, []);

      expect(result.stateToSet).toBe(true);
      expect(result.total).toBe(4);
      expect(result.active).toBe(1);
      expect(result.warning).toContain(
        "State for device 'snapshot-only' is not authoritative yet; ignoring it for smart toggle.",
      );
    });

    it("should count duplicate actors on the same device only once", () => {
      manager.registerActuatorStates("light-group", [true, false, false, false]);
      const actors: Actor[] = [
        { name: "light-group", allActuators: false, actuators: [1, 2] },
        { name: "light-group", allActuators: false, actuators: [2, 3] },
      ];

      const result = manager.getSmartToggleState(actors, []);

      expect(result.stateToSet).toBe(true);
      expect(result.total).toBe(3);
      expect(result.active).toBe(1);
    });

    it("should return false with a warning if no valid actuators are found at all", () => {
      const actors: Actor[] = [{ name: "non-existent-device", allActuators: true, actuators: [] }];
      const result = manager.getSmartToggleState(actors, []);
      expect(result.stateToSet).toBe(false);
      expect(result.total).toBe(0);
      expect(result.warning).toContain("No valid actuators found");
    });
  });

  describe("recordControllerActivity", () => {
    it("should report a state change for a previously unhealthy device", () => {
      manager.updateBridgeConnectionState("offline-device", "lost");
      const { stateChanged } = manager.recordControllerActivity("offline-device");
      const device = manager.getDevice("offline-device")!;
      expect(stateChanged).toBe(true);
      expect(device.bridgeConnected).toBe(true);
      expect(device.connected).toBe(true);
      expect(device.isHealthy).toBe(true);
    });

    it("should report a state change for a previously stale device", () => {
      manager.updateBridgeConnectionState("stale-device", "ready");
      const device = manager.getDevice("stale-device")!;
      device.isStale = true; // Make it stale
      device.isHealthy = true;

      const { stateChanged } = manager.recordControllerActivity("stale-device");

      expect(stateChanged).toBe(true);
      expect(device.connected).toBe(true);
      expect(device.isHealthy).toBe(true);
      expect(device.isStale).toBe(false); // Should be cleared
    });

    it("should mark a device as connected when ping is the first reachability proof", () => {
      manager.registerDeviceDetails("ping-only-device", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "ping-only-device",
        a: [1],
        b: [],
      });
      manager.registerActuatorStates("ping-only-device", [false]);

      const { stateChanged, becameHealthy } = manager.recordControllerActivity("ping-only-device");
      const device = manager.getDevice("ping-only-device")!;

      expect(stateChanged).toBe(true);
      expect(becameHealthy).toBe(true);
      expect(device.connected).toBe(true);
      expect(device.isHealthy).toBe(true);
    });
  });

  describe("recordBridgePingReply", () => {
    it("should update bridge-only state without promoting controller reachability", () => {
      const { stateChanged, bridgeBecameConnected, controllerDisconnected, snapshotInvalidated } =
        manager.recordBridgePingReply("bridge-only-device", true, true);
      const device = manager.getDevice("bridge-only-device")!;

      expect(stateChanged).toBe(true);
      expect(bridgeBecameConnected).toBe(true);
      expect(controllerDisconnected).toBe(false);
      expect(snapshotInvalidated).toBe(false);
      expect(device.bridgeConnected).toBe(true);
      expect(device.connected).toBe(false);
    });

    it("should degrade controller reachability when the bridge reports controller loss", () => {
      manager.recordControllerActivity("device-1");

      const { stateChanged, controllerDisconnected, snapshotInvalidated } =
        manager.recordBridgePingReply("device-1", false, false);
      const device = manager.getDevice("device-1")!;

      expect(stateChanged).toBe(true);
      expect(controllerDisconnected).toBe(true);
      expect(snapshotInvalidated).toBe(false);
      expect(device.bridgeConnected).toBe(true);
      expect(device.connected).toBe(false);
      expect(device.isHealthy).toBe(false);
      expect(device.isStale).toBe(false);
    });

    it("should invalidate only the authoritative state snapshot when the bridge reports runtime desync", () => {
      manager.registerDeviceDetails("device-1", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "device-1",
        a: [1],
        b: [],
      });
      manager.registerActuatorStates("device-1", [false]);
      manager.recordControllerActivity("device-1");

      const { stateChanged, controllerDisconnected, snapshotInvalidated } =
        manager.recordBridgePingReply("device-1", true, false);
      const device = manager.getDevice("device-1")!;

      expect(stateChanged).toBe(true);
      expect(controllerDisconnected).toBe(false);
      expect(snapshotInvalidated).toBe(true);
      expect(device.connected).toBe(true);
      expect(device.isHealthy).toBe(true);
      expect(device.lastStateTime).toBe(0);
    });
  });

  describe("recordAlertSent", () => {
    it("should record the first alert only once", () => {
      const firstResult = manager.recordAlertSent("alert-device");
      const device = manager.getDevice("alert-device")!;

      expect(firstResult.stateChanged).toBe(true);
      expect(device.isHealthy).toBe(false);
      expect(device.alertSent).toBe(true);

      const secondResult = manager.recordAlertSent("alert-device");

      expect(secondResult.stateChanged).toBe(false);
    });
  });
});
