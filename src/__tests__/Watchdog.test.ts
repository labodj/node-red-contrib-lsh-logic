/**
 * @file Unit tests for the Watchdog class.
 * These tests verify the health-checking logic for devices.
 */
import { Watchdog } from "../Watchdog";
import type { DeviceState } from "../types";

describe("Watchdog", () => {
  const INTERROGATE_SEC = 3;
  const TIMEOUT_SEC = 5;
  const NOW = 10_000;
  let watchdog: Watchdog;

  const mockDevice: DeviceState = {
    name: "test-device",
    connected: true,
    isHealthy: true,
    isStale: false,
    lastSeenTime: 0,
    lastDetailsTime: 1, // Mark as configured to avoid edge cases
    lastStateTime: 1,
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
    const device = { ...mockDevice, lastSeenTime: NOW - 1000 };
    const result = watchdog.checkDeviceHealth(device, NOW);
    expect(result.status).toBe("ok");
  });

  it('should return "needs_ping" for a device silent beyond the threshold', () => {
    const device = {
      ...mockDevice,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };
    const result = watchdog.checkDeviceHealth(device, NOW);
    expect(result.status).toBe("needs_ping");
  });

  it('should return "ok" if a ping was sent but has not timed out yet', () => {
    const device = {
      ...mockDevice,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };

    watchdog.checkDeviceHealth(device, NOW);

    const future = NOW + 1000;
    const result = watchdog.checkDeviceHealth(device, future);
    expect(result.status).toBe("ok");
  });

  it('should keep a stale device marked as "stale" while waiting for the retry ping response', () => {
    const device = {
      ...mockDevice,
      isStale: true,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };

    watchdog.checkDeviceHealth(device, NOW);

    const future = NOW + 1000;
    const result = watchdog.checkDeviceHealth(device, future);
    expect(result.status).toBe("stale");
  });

  it('should return "stale" if a ping has timed out', () => {
    const device = {
      ...mockDevice,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };

    watchdog.checkDeviceHealth(device, NOW);

    const future = NOW + (TIMEOUT_SEC + 1) * 1000;
    const result = watchdog.checkDeviceHealth(device, future);
    expect(result.status).toBe("stale");
  });

  it('should return "needs_ping" for a device that exists but has never communicated (lastSeenTime is 0)', () => {
    const device = { ...mockDevice, lastSeenTime: 0 };
    const result = watchdog.checkDeviceHealth(device, NOW);
    expect(result.status).toBe("needs_ping");
  });

  it('should return "unhealthy" for a device not in the registry (undefined state)', () => {
    const result = watchdog.checkDeviceHealth(undefined, NOW);

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: expect.stringContaining("Never seen"),
    });
  });

  it("should clear a pending ping on new device activity", () => {
    const device: DeviceState = {
      ...mockDevice,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };

    const result1 = watchdog.checkDeviceHealth(device, NOW);
    expect(result1.status).toBe("needs_ping");

    watchdog.onDeviceActivity(device.name);
    device.lastSeenTime = NOW + 1;
    const result2 = watchdog.checkDeviceHealth(device, NOW + 1);
    expect(result2.status).toBe("ok");
  });

  it("clears a pending ping when a device is explicitly disconnected", () => {
    const staleConnectedDevice: DeviceState = {
      ...mockDevice,
      connected: true,
      lastSeenTime: NOW - (INTERROGATE_SEC + 10) * 1000,
    };

    expect(watchdog.checkDeviceHealth(staleConnectedDevice, NOW).status).toBe("needs_ping");

    const disconnectedDevice = { ...staleConnectedDevice, connected: false };
    expect(watchdog.checkDeviceHealth(disconnectedDevice, NOW + 1000).status).toBe("ok");

    const reconnectedStaleDevice = { ...staleConnectedDevice, connected: true };
    expect(watchdog.checkDeviceHealth(reconnectedStaleDevice, NOW + 1001).status).toBe(
      "needs_ping",
    );
  });
});
