/**
 * @file Unit tests for the Watchdog class.
 */
import { Watchdog } from "../Watchdog";
import { DeviceState } from "../types";

describe("Watchdog", () => {
  /** Test constant for the interrogation threshold in seconds. */
  const INTERROGATE_SEC = 3;
  /** Test constant for the ping timeout in seconds. */
  const TIMEOUT_SEC = 5;
  /** The instance of the Watchdog class under test. */
  let watchdog: Watchdog;

  /** A mock device state object used as a base for various test scenarios. */
  const mockDevice: DeviceState = {
    name: "test-device",
    connected: true,
    isHealthy: true,
    isStale: false,
    lastSeenTime: 0,
    lastBootTime: 0,
    lastDetailsTime: 1, // Mark as configured
    actuatorsIDs: [],
    buttonsIDs: [],
    actuatorStates: [],
    actuatorIndexes: {},
  };

  beforeEach(() => {
    watchdog = new Watchdog(INTERROGATE_SEC, TIMEOUT_SEC);
  });

  it('should return "ok" for a recently seen device', () => {
    const now = Date.now();
    const device = { ...mockDevice, lastSeenTime: now - 1000 };
    const result = watchdog.checkDeviceHealth(device, now);
    expect(result.status).toBe("ok");
  });

  it('should return "needs_ping" for a device silent beyond the threshold', () => {
    const now = Date.now();
    const device = {
      ...mockDevice,
      lastSeenTime: now - (INTERROGATE_SEC + 1) * 1000,
    };
    const result = watchdog.checkDeviceHealth(device, now);
    expect(result.status).toBe("needs_ping");
  });

  it('should return "ok" if a ping was sent but has not timed out yet', () => {
    const now = Date.now();
    const device = {
      ...mockDevice,
      lastSeenTime: now - (INTERROGATE_SEC + 1) * 1000,
    };

    // First check sends a ping
    watchdog.checkDeviceHealth(device, now);

    // Second check, a little later
    const future = now + 1000;
    const result = watchdog.checkDeviceHealth(device, future);
    expect(result.status).toBe("ok");
  });

  it('should return "stale" if a ping has timed out', () => {
    const now = Date.now();
    const device = {
      ...mockDevice,
      lastSeenTime: now - (INTERROGATE_SEC + 1) * 1000,
    };

    // First check sends a ping at 'now'
    watchdog.checkDeviceHealth(device, now);

    // Second check, after the ping timeout
    const future = now + (TIMEOUT_SEC + 1) * 1000;
    const result = watchdog.checkDeviceHealth(device, future);
    expect(result.status).toBe("stale");
  });

  it('should return "needs_ping" for a device that exists but has never communicated (lastSeenTime is 0)', () => {
    const now = Date.now();
    // This device is in the registry but has never had its lastSeenTime updated.
    // The correct behavior is to try pinging it first, not mark it as unhealthy immediately.
    const device = { ...mockDevice, lastSeenTime: 0 };
    const result = watchdog.checkDeviceHealth(device, now);
    expect(result.status).toBe("needs_ping");
  });

  it('should return "unhealthy" for a device that is not in the registry (undefined state)', () => {
    const now = Date.now();
    // This represents a device listed in the config file but that has never sent any message.
    const result = watchdog.checkDeviceHealth(undefined, now);

    expect(result.status).toBe("unhealthy");
    if (result.status === "unhealthy") {
      expect(result.reason).toContain("Never seen");
    } else {
      fail('Expected status to be "unhealthy" but it was not.');
    }
  });

  it('should return "ok" for a device that just had activity', () => {
    let now = Date.now();
    let device: DeviceState = {
      ...mockDevice,
      lastSeenTime: now - (INTERROGATE_SEC + 1) * 1000,
    };

    // 1. Device is silent, so it needs a ping.
    const result1 = watchdog.checkDeviceHealth(device, now);
    expect(result1.status).toBe("needs_ping");

    // 2. An activity happens. In the real world, this means TWO things:
    //    a) The watchdog is notified to clear any pending pings for this device.
    watchdog.onDeviceActivity(device.name);
    //    b) The device's state in the registry is updated with a new `lastSeenTime`.
    now = Date.now(); // Simulate time passing for the new activity
    device.lastSeenTime = now;

    // 3. Now, if we check again, the device should be 'ok' because its `lastSeenTime` is recent.
    const result2 = watchdog.checkDeviceHealth(device, now);
    expect(result2.status).toBe("ok");
  });
});
