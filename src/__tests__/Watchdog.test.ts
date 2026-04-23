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
    controllerLinkConnected: true,
    isHealthy: true,
    isStale: false,
    lastSeenTime: 0,
    bridgeConnected: true,
    bridgeLastSeenTime: 0,
    lastHomieState: null,
    lastHomieStateTime: 0,
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
    watchdog.onPingDispatched(device.name, NOW);

    const future = NOW + 1000;
    const result = watchdog.checkDeviceHealth(device, future);
    expect(result.status).toBe("ok");
  });

  it("should not time out a ping before the adapter reports the actual dispatch time", () => {
    const device = {
      ...mockDevice,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };

    const firstResult = watchdog.checkDeviceHealth(device, NOW);
    expect(firstResult.status).toBe("needs_ping");

    const future = NOW + (TIMEOUT_SEC + 1) * 1000;
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
    watchdog.onPingDispatched(device.name, NOW);

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
    watchdog.onPingDispatched(device.name, NOW);

    const future = NOW + (TIMEOUT_SEC + 1) * 1000;
    const result = watchdog.checkDeviceHealth(device, future);
    expect(result.status).toBe("stale");
  });

  it('should not requeue duplicate retries while a stale device retry is still "queued"', () => {
    const device = {
      ...mockDevice,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };

    watchdog.checkDeviceHealth(device, NOW);
    watchdog.onPingDispatched(device.name, NOW);

    const timeoutResult = watchdog.checkDeviceHealth(device, NOW + (TIMEOUT_SEC + 1) * 1000);
    expect(timeoutResult.status).toBe("stale");

    const staleDevice = { ...device, isStale: true };
    const queuedRetryResult = watchdog.checkDeviceHealth(
      staleDevice,
      NOW + (TIMEOUT_SEC + 2) * 1000,
    );
    expect(queuedRetryResult.status).toBe("retry_queued");
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

    watchdog.onPingDispatched(device.name, NOW);
    watchdog.onDeviceActivity(device.name);
    device.lastSeenTime = NOW + 1;
    const result2 = watchdog.checkDeviceHealth(device, NOW + 1);
    expect(result2.status).toBe("ok");
  });

  it("clears a pending ping when both bridge and controller are explicitly disconnected", () => {
    const staleConnectedDevice: DeviceState = {
      ...mockDevice,
      connected: true,
      lastSeenTime: NOW - (INTERROGATE_SEC + 10) * 1000,
    };

    expect(watchdog.checkDeviceHealth(staleConnectedDevice, NOW).status).toBe("needs_ping");

    const disconnectedDevice = {
      ...staleConnectedDevice,
      connected: false,
      bridgeConnected: false,
    };
    expect(watchdog.checkDeviceHealth(disconnectedDevice, NOW + 1000).status).toBe("ok");

    const reconnectedStaleDevice = { ...staleConnectedDevice, connected: true };
    expect(watchdog.checkDeviceHealth(reconnectedStaleDevice, NOW + 1001).status).toBe(
      "needs_ping",
    );
  });

  it("stops controller pings when the bridge explicitly reports controller_connected=false", () => {
    const bridgeOnlyDevice: DeviceState = {
      ...mockDevice,
      connected: false,
      bridgeConnected: true,
      controllerLinkConnected: false,
      lastSeenTime: NOW - (INTERROGATE_SEC + 10) * 1000,
    };

    expect(watchdog.checkDeviceHealth(bridgeOnlyDevice, NOW).status).toBe("ok");
  });

  it("rate-limits bridge probes independently from controller pings", () => {
    expect(watchdog.shouldProbeBridge(NOW)).toBe(true);
    watchdog.onBridgeProbeQueued();
    expect(watchdog.shouldProbeBridge(NOW + 1)).toBe(false);
    watchdog.onBridgeProbeDispatched(NOW + 100);
    expect(watchdog.shouldProbeBridge(NOW + 1_000)).toBe(false);
    expect(watchdog.shouldProbeBridge(NOW + (TIMEOUT_SEC + 1) * 1000)).toBe(true);
  });

  it("treats bridge probe cooldown as global because the emitted probe is broadcast", () => {
    expect(watchdog.shouldProbeBridge(NOW)).toBe(true);
    watchdog.onBridgeProbeQueued();
    expect(watchdog.shouldProbeBridge(NOW + 1_000)).toBe(false);
  });

  it("cancels a queued bridge probe when pending low-priority work is invalidated", () => {
    expect(watchdog.shouldProbeBridge(NOW)).toBe(true);
    watchdog.onBridgeProbeQueued();
    expect(watchdog.shouldProbeBridge(NOW + 1_000)).toBe(false);

    watchdog.cancelQueuedBridgeProbe();

    expect(watchdog.shouldProbeBridge(NOW + 1_001)).toBe(true);
  });

  it("prunes pending ping bookkeeping for devices removed from config", () => {
    const device = {
      ...mockDevice,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };

    expect(watchdog.checkDeviceHealth(device, NOW).status).toBe("needs_ping");
    expect(watchdog.pruneDevices([])).toEqual([device.name]);
    expect(watchdog.checkDeviceHealth(device, NOW + 1).status).toBe("needs_ping");
  });

  it("resets all pending ping bookkeeping when the watchdog is reset", () => {
    const device = {
      ...mockDevice,
      lastSeenTime: NOW - (INTERROGATE_SEC + 1) * 1000,
    };

    expect(watchdog.checkDeviceHealth(device, NOW).status).toBe("needs_ping");
    watchdog.reset();
    expect(watchdog.checkDeviceHealth(device, NOW + 1).status).toBe("needs_ping");
  });
});
