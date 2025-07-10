/**
 * @file Manages device health monitoring, deciding when to ping devices or raise alerts.
 * This class encapsulates the logic for determining device staleness based on
 * timing thresholds, without performing any I/O itself.
 */
import { DeviceState } from "./types";

/**
 * Defines the possible outcomes of a watchdog health check for a single device.
 * This is a discriminated union, allowing for type-safe handling of each case.
 */
export type WatchdogResult =
  | { status: "ok" }
  | { status: "needs_ping" }
  | { status: "stale" }
  | { status: "unhealthy"; reason: string };

export class Watchdog {
  private readonly interrogateThresholdMs: number;
  private readonly pingTimeoutMs: number;
  private pingTimestamps: Map<string, number> = new Map();

  /**
   * Constructs a new Watchdog.
   * @param interrogateThresholdSec - Seconds of silence before a device needs a ping.
   * @param pingTimeoutSec - Seconds to wait for a ping response before a device is considered stale/unhealthy.
   */
  constructor(interrogateThresholdSec: number, pingTimeoutSec: number) {
    this.interrogateThresholdMs = interrogateThresholdSec * 1000;
    this.pingTimeoutMs = pingTimeoutSec * 1000;
  }

  /**
   * Checks the health of a single device based on its state and the current time.
   * @param deviceState - The current state of the device to check.
   * @param now - The current timestamp (e.g., from `Date.now()`).
   * @returns A `WatchdogResult` indicating the device's health status.
   */
  public checkDeviceHealth(
    deviceState: DeviceState,
    now: number
  ): WatchdogResult {
    if (!deviceState || deviceState.lastSeenTime === 0) {
      return { status: "unhealthy", reason: "Never seen on the network." };
    }

    const timeSinceLastSeen = now - deviceState.lastSeenTime;
    const pingSentTime = this.pingTimestamps.get(deviceState.name) || 0;

    // 1. Is the device online and healthy?
    if (timeSinceLastSeen < this.interrogateThresholdMs) {
      if (pingSentTime) this.pingTimestamps.delete(deviceState.name);
      return { status: "ok" };
    }

    // --- Device has been silent for too long ---

    // 2. Have we already sent a ping?
    if (pingSentTime > 0) {
      // Yes. Has the ping timed out?
      if (now - pingSentTime > this.pingTimeoutMs) {
        // Ping timed out. The device is officially problematic.
        this.pingTimestamps.set(deviceState.name, now); // Record that we are trying to ping again
        return { status: "stale" }; // It's stale, might become unhealthy on the next check
      }
      // Ping sent, but not yet timed out. We wait.
      return { status: "ok" };
    }

    // 3. First time we've seen it silent. Send a ping.
    this.pingTimestamps.set(deviceState.name, now);
    return { status: "needs_ping" };
  }

  /**
   * Resets the ping timestamp for a device, typically after receiving a message from it.
   * @param deviceName - The name of the device.
   */
  public onDeviceActivity(deviceName: string): void {
    if (this.pingTimestamps.has(deviceName)) {
      this.pingTimestamps.delete(deviceName);
    }
  }
}
