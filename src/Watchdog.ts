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
  /** The device has been seen recently and is considered healthy. */
  | { status: "ok" }
  /** The device has been silent for too long and requires a ping. */
  | { status: "needs_ping" }
  /** A ping was sent, but it timed out. The device may become unhealthy. */
  | { status: "stale" }
  /** The device is considered unhealthy for a specific reason (e.g., never seen). */
  | { status: "unhealthy"; reason: string };

export class Watchdog {
  /** Milliseconds of silence before a device is considered in need of a ping. */
  private readonly interrogateThresholdMs: number;
  /** Milliseconds to wait for a ping response before a device is considered stale. */
  private readonly pingTimeoutMs: number;
  /** Stores timestamps of when a ping was last sent to a device, keyed by device name. */
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

    // 1. If seen recently, it's healthy. Clear any pending ping state.
    if (timeSinceLastSeen < this.interrogateThresholdMs) {
      if (pingSentTime) this.pingTimestamps.delete(deviceState.name);
      return { status: "ok" };
    }

    // --- At this point, the device has been silent for too long ---

    // 2. If we have already sent a ping...
    if (pingSentTime > 0) {
      // 2a. ...check if the ping has timed out.
      if (now - pingSentTime > this.pingTimeoutMs) {
        // Ping timed out. It's stale. We'll try pinging again.
        this.pingTimestamps.set(deviceState.name, now); // Record that we are trying to ping again
        return { status: "stale" }; // It's stale, might become unhealthy on the next check
      }
      // 2b. ...otherwise, the ping has not timed out yet. We wait.
      return { status: "ok" };
    }

    // 3. If we reach here, the device is silent and we haven't pinged it yet. Time to send a ping.
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
