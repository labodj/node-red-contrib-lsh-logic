/**
 * @file Manages device health monitoring, deciding when to ping devices or raise alerts.
 * This class encapsulates the logic for determining device staleness based on
 * timing thresholds. It is a pure, stateful class that does not perform any I/O,
 * making it highly testable.
 */
import { DeviceState } from "./types";

/**
 * Defines the possible outcomes of a watchdog health check for a single device.
 * This is a discriminated union, allowing for type-safe handling of each case.
 */
export type WatchdogResult =
  /** The device is responsive or its state is handled by other means (e.g., Homie 'lost'). */
  | { status: "ok" }
  /** The device is connected but has been silent for too long and requires a ping. */
  | { status: "needs_ping" }
  /** A ping was sent to a connected device, but it timed out. The device is now considered stale. */
  | { status: "stale" }
  /** The device is considered unhealthy for a specific reason (e.g., never seen, or connected but unresponsive). */
  | { status: "unhealthy"; reason: string };

export class Watchdog {
  /** Milliseconds of silence before a device is considered in need of a ping. */
  private readonly interrogateThresholdMs: number;
  /** Milliseconds to wait for a ping response before a device is considered stale. */
  private readonly pingTimeoutMs: number;
  /**
   * Stores timestamps of when a ping was last sent to a device.
   * This internal state is key to the multi-stage health check.
   */
  private pingTimestamps: Map<string, number> = new Map();

  /**
   * Constructs a new Watchdog instance.
   * @param interrogateThresholdSec - Seconds of silence before a device needs a ping.
   * @param pingTimeoutSec - Seconds to wait for a ping response before marking a device as stale.
   */
  constructor(interrogateThresholdSec: number, pingTimeoutSec: number) {
    this.interrogateThresholdMs = interrogateThresholdSec * 1000;
    this.pingTimeoutMs = pingTimeoutSec * 1000;
  }

  /**
    * Checks the health of a single device based on its state and the current time.
    * This method implements a multi-stage check:
    * 1. It first trusts the Homie `connected` state. If Homie reports a device as disconnected, the watchdog takes no further action.
    * 2. If the device is connected but has been silent beyond `interrogateThreshold`, it initiates a ping.
    * 3. If a ping has been sent but no response is received within `pingTimeout`, it marks the device as 'stale'.
    * 4. If the device has never been seen, it is immediately marked 'unhealthy'.
    * @param deviceState - The current state of the device to check, or `undefined` if never seen.
    * @param now - The current timestamp (e.g., from `Date.now()`).
    * @returns A `WatchdogResult` indicating the device's health status.
    */
  public checkDeviceHealth(
    deviceState: DeviceState | undefined,
    now: number
  ): WatchdogResult {
    // GUARD 1: The device is configured but has never appeared on the network at all.
    if (!deviceState) {
      return { status: "unhealthy", reason: "Never seen on the network." };
    }

    // GUARD 2: The device is explicitly marked as disconnected by the Homie protocol.
    // Homie is the source of truth for Layer 3 (IP) connectivity. If it says the device
    // is offline, there's no point in sending an LSH-level ping. We return "ok" to
    // prevent the watchdog from raising a redundant alert.
    if (!deviceState.connected) {
      this.onDeviceActivity(deviceState.name); // Clear any pending pings for it.
      return { status: "ok" };
    }

    const timeSinceLastSeen = now - deviceState.lastSeenTime;

    // GUARD 3: The device is connected and has been seen recently. It's healthy.
    if (deviceState.lastSeenTime > 0 && timeSinceLastSeen < this.interrogateThresholdMs) {
      this.onDeviceActivity(deviceState.name);
      return { status: "ok" };
    }

    // At this point, the device is CONNECTED but has been SILENT for too long.
    // We now proceed with the ping/staleness logic.
    const pingSentTime = this.pingTimestamps.get(deviceState.name);

    if (pingSentTime) {
      // A ping has been sent. Check if it has timed out.
      const pingHasTimedOut = now - pingSentTime > this.pingTimeoutMs;
      if (pingHasTimedOut) {
        // The device is connected but did not respond to our ping in time. It is stale.
        this.pingTimestamps.set(deviceState.name, now); // Set a new ping time for the next attempt.
        return { status: "stale" };
      } else {
        // We are still waiting for a response. No new action is needed.
        return { status: "ok" };
      }
    } else {
      // The device is silent and we haven't sent a ping yet. Time to send one.
      this.pingTimestamps.set(deviceState.name, now);
      return { status: "needs_ping" };
    }
  }

  /**
   * Resets the ping timestamp for a device. This should be called whenever there's
   * any activity from the device to prevent it from being incorrectly marked as stale.
   * @param deviceName - The name of the active device.
   */
  public onDeviceActivity(deviceName: string): void {
    this.pingTimestamps.delete(deviceName);
  }
}