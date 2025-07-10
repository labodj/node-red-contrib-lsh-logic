// src/Watchdog.ts

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
   * This method uses guard clauses for improved readability.
   * @param deviceState - The current state of the device to check.
   * @param now - The current timestamp (e.g., from `Date.now()`).
   * @returns A `WatchdogResult` indicating the device's health status.
   */
  public checkDeviceHealth(
    deviceState: DeviceState | undefined,
    now: number
  ): WatchdogResult {
    // GUARD 1: Device is not in the registry or has never sent ANY message.
    // This is the condition the test expects.
    if (!deviceState || deviceState.lastSeenTime === 0) {
      return { status: "unhealthy", reason: "Never seen on the network." };
    }

    const timeSinceLastSeen = now - deviceState.lastSeenTime;

    // GUARD 2: Device has been seen recently. It's healthy.
    if (timeSinceLastSeen < this.interrogateThresholdMs) {
      this.onDeviceActivity(deviceState.name); // Clear any pending ping
      return { status: "ok" };
    }

    // At this point, we know the device has been silent for too long.
    const pingSentTime = this.pingTimestamps.get(deviceState.name);

    if (pingSentTime) {
      // A ping has already been sent. We need to check if it has timed out.
      const pingHasTimedOut = now - pingSentTime > this.pingTimeoutMs;
      if (pingHasTimedOut) {
        // Ping timed out. It's now stale. The orchestrator will ping again.
        this.pingTimestamps.set(deviceState.name, now); // Set a new ping time for the next attempt
        return { status: "stale" };
      } else {
        // Ping was sent, but we are still within the timeout window. All is OK for now.
        return { status: "ok" };
      }
    } else {
      // Device is silent and we haven't sent a ping yet. Time to send one.
      this.pingTimestamps.set(deviceState.name, now);
      return { status: "needs_ping" };
    }
  }

  /**
   * Resets the ping timestamp for a device, typically after receiving a message from it.
   * This should be called whenever there's activity to prevent false 'stale' states.
   * @param deviceName - The name of the device.
   */
  public onDeviceActivity(deviceName: string): void {
    this.pingTimestamps.delete(deviceName);
  }
}