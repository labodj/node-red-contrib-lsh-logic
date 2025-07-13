/**
 * @file Unit tests for the Watchdog class.
 * These tests verify the health-checking logic for devices.
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
    lastDetailsTime: 1, // Mark as configured to avoid edge cases
    alertSent: false,
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

    // First check triggers a ping to be sent.
    watchdog.checkDeviceHealth(device, now);

    // Second check, a moment later but before timeout, should be 'ok'.
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

    // First check sends a ping at 'now'.
    watchdog.checkDeviceHealth(device, now);

    // Second check, after the ping timeout has elapsed.
    const future = now + (TIMEOUT_SEC + 1) * 1000;
    const result = watchdog.checkDeviceHealth(device, future);
    expect(result.status).toBe("stale");
  });

  it('should return "needs_ping" for a device that exists but has never communicated (lastSeenTime is 0)', () => {
    const now = Date.now();
    // This device is in the registry but has never had its lastSeenTime updated.
    const device = { ...mockDevice, lastSeenTime: 0 };
    const result = watchdog.checkDeviceHealth(device, now);
    expect(result.status).toBe("needs_ping");
  });

  it('should return "unhealthy" for a device not in the registry (undefined state)', () => {
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

  it("should clear a pending ping on new device activity", () => {
    let now = Date.now();
    const device: DeviceState = {
      ...mockDevice,
      lastSeenTime: now - (INTERROGATE_SEC + 1) * 1000,
    };

    // 1. Device is silent, so it needs a ping.
    const result1 = watchdog.checkDeviceHealth(device, now);
    expect(result1.status).toBe("needs_ping");

    // 2. An activity happens. The watchdog is notified to clear pending pings.
    watchdog.onDeviceActivity(device.name);

    // 3. The device's state in the registry is updated with a new `lastSeenTime`.
    now = Date.now();
    device.lastSeenTime = now;

    // 4. Now, if we check again, the device should be 'ok' because its `lastSeenTime` is recent.
    const result2 = watchdog.checkDeviceHealth(device, now);
    expect(result2.status).toBe("ok");
  });

  it('should return "ok" for a device that is explicitly disconnected', () => {
    const now = Date.now();
    const device: DeviceState = {
      ...mockDevice,
      connected: false, // The key property for this test
      // Make it seem very old to ensure the 'connected' flag is what's being tested
      lastSeenTime: now - (INTERROGATE_SEC + 10) * 1000,
    };

    // Pre-populate a ping timestamp to ensure onDeviceActivity clears it
    (watchdog as any).pingTimestamps.set(device.name, now - 1000);

    const result = watchdog.checkDeviceHealth(device, now);
    expect(result.status).toBe("ok");
    // Also assert that the pending ping was cleared as a side effect
    expect((watchdog as any).pingTimestamps.has(device.name)).toBe(false);
  });
});
