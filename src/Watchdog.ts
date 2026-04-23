/**
 * @file Manages device health monitoring, deciding when to ping devices or raise alerts.
 * This class encapsulates the logic for determining device staleness based on
 * timing thresholds. It is a pure, stateful class that does not perform any I/O,
 * making it highly testable.
 */
import type { DeviceState } from "./types";

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
  /**
   * The device is already stale and its retry ping is still queued for the
   * adapter's low-priority drain. Keep the stale state latched, but do not
   * enqueue duplicate retries on every watchdog cycle.
   */
  | { status: "retry_queued" }
  /** The device is considered unhealthy for a specific reason (e.g., never seen, or connected but unresponsive). */
  | { status: "unhealthy"; reason: string };

type PingLifecycleState = { status: "queued" } | { status: "sent"; sentTime: number };

export class Watchdog {
  /** Milliseconds of silence before a device is considered in need of a ping. */
  private readonly interrogateThresholdMs: number;
  /** Milliseconds to wait for a ping response before a device is considered stale. */
  private readonly pingTimeoutMs: number;
  /**
   * Stores timestamps of when a ping was last sent to a device.
   * This internal state is key to the multi-stage health check.
   */
  private pingStates: Map<string, PingLifecycleState> = new Map();
  /**
   * Tracks the lifecycle of the single bridge-level service probe broadcast.
   * The emitted command is global, so its throttle state is global too.
   */
  private bridgeProbeState: PingLifecycleState | null = null;

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
   * 1. It first checks whether the device is currently known to be reachable at the controller layer.
   *    Bridge-only reachability is tracked separately in the registry.
   * 2. If the device is reachable but has been silent beyond `interrogateThreshold`, it initiates a ping.
   * 3. If the bridge is alive but controller reachability is still unknown, it may initiate controller pings.
   *    If the bridge explicitly reported `controller_connected=false`, it suppresses controller probes.
   * 4. If a ping has been sent but no response is received within `pingTimeout`, it marks the device as 'stale'.
   * 5. If the device has never been seen, it is immediately marked 'unhealthy'.
   * @param deviceState - The current state of the device to check, or `undefined` if never seen.
   * @param now - The current timestamp (e.g., from `Date.now()`).
   * @returns A `WatchdogResult` indicating the device's health status.
   */
  public checkDeviceHealth(deviceState: DeviceState | undefined, now: number): WatchdogResult {
    // GUARD 1: The device is configured but has never appeared on the network at all.
    if (!deviceState) {
      return { status: "unhealthy", reason: "Never seen on the network." };
    }

    // GUARD 2: The bridge is currently offline, so controller probes cannot succeed.
    if (!deviceState.connected && !deviceState.bridgeConnected) {
      this.pingStates.delete(deviceState.name);
      return { status: "ok" };
    }

    // GUARD 3: The bridge is alive and explicitly reported that the downstream
    // controller link is down. Controller pings cannot succeed until the bridge
    // reports that link as recovered.
    if (
      !deviceState.connected &&
      deviceState.bridgeConnected &&
      deviceState.controllerLinkConnected === false
    ) {
      this.pingStates.delete(deviceState.name);
      return { status: "ok" };
    }

    const timeSinceLastSeen = now - deviceState.lastSeenTime;

    // GUARD 4: The device is connected and has been seen recently. It's healthy.
    if (deviceState.lastSeenTime > 0 && timeSinceLastSeen < this.interrogateThresholdMs) {
      this.onDeviceActivity(deviceState.name);
      return { status: "ok" };
    }

    // At this point, the device is CONNECTED but has been SILENT for too long.
    // We now proceed with the ping/staleness logic.
    const pingState = this.pingStates.get(deviceState.name);

    if (pingState?.status === "sent") {
      // A ping has actually been emitted by the adapter. Only now does the
      // timeout window start counting down.
      const pingHasTimedOut = now - pingState.sentTime > this.pingTimeoutMs;
      if (pingHasTimedOut) {
        // The last emitted ping timed out. Latch the retry request as queued so
        // later watchdog cycles do not keep duplicating the same retry while it
        // is still waiting in the adapter's low-priority drain.
        this.pingStates.set(deviceState.name, { status: "queued" });
        return { status: "stale" };
      }

      // We are still waiting for a response to a ping that really left the
      // node. Keep a stale device latched as stale until genuine activity
      // clears it, otherwise the state would oscillate without any reply.
      return deviceState.isStale ? { status: "stale" } : { status: "ok" };
    }

    if (pingState?.status === "queued") {
      // A ping is already queued for transmission, but has not been observed as
      // emitted by the adapter yet. Do not start timeout accounting early and
      // do not enqueue duplicate pings on every watchdog cycle.
      return deviceState.isStale ? { status: "retry_queued" } : { status: "ok" };
    }

    // The device is silent and no ping is currently pending. Request one and
    // mark it as queued until the adapter confirms the actual dispatch time.
    this.pingStates.set(deviceState.name, { status: "queued" });
    return { status: "needs_ping" };
  }

  /**
   * Resets the ping timestamp for a device after a live reachability signal.
   * Callers should use this only for non-retained telemetry that proves the
   * device is currently alive on the network path being monitored.
   * @param deviceName - The name of the active device.
   */
  public onDeviceActivity(deviceName: string): void {
    this.pingStates.delete(deviceName);
  }

  /**
   * Marks that the adapter has queued a controller ping for a device but the
   * frame has not necessarily left the node yet.
   * @param deviceName - The device that now has a queued ping.
   */
  public onPingQueued(deviceName: string): void {
    this.pingStates.set(deviceName, { status: "queued" });
  }

  /**
   * Marks the instant a controller ping actually leaves the node. The timeout
   * window starts from this real dispatch time, not from the watchdog cycle
   * that merely decided a ping was needed.
   * @param deviceName - The device whose ping was emitted.
   * @param now - The current timestamp.
   */
  public onPingDispatched(deviceName: string, now: number): void {
    this.pingStates.set(deviceName, { status: "sent", sentTime: now });
  }

  /**
   * Clears a queued-but-unsent ping when the adapter drops pending low-priority
   * work, for example after a config generation change.
   * @param deviceName - The device whose queued ping should be cancelled.
   */
  public cancelQueuedPing(deviceName: string): void {
    const pingState = this.pingStates.get(deviceName);
    if (pingState?.status === "queued") {
      this.pingStates.delete(deviceName);
    }
  }

  /**
   * Returns whether a new bridge-level service probe may be sent now.
   * The probe is throttled independently from controller pings so a retained
   * Homie baseline or an explicitly disconnected controller path cannot cause
   * one service ping per watchdog tick forever. Because the emitted command is
   * a single broadcast on the service topic, the cooldown is global too.
   * @param now - The current timestamp.
   * @returns `true` when the probe should be sent now.
   */
  public shouldProbeBridge(now: number): boolean {
    if (this.bridgeProbeState?.status === "queued") {
      return false;
    }

    if (this.bridgeProbeState?.status === "sent") {
      return now - this.bridgeProbeState.sentTime >= this.pingTimeoutMs;
    }

    return true;
  }

  /**
   * Marks that a bridge-level service probe has been queued for later
   * transmission but has not necessarily left the adapter yet.
   */
  public onBridgeProbeQueued(): void {
    this.bridgeProbeState = { status: "queued" };
  }

  /**
   * Marks the actual dispatch instant of the bridge-level service probe. The
   * cooldown starts from this real emit time.
   * @param now - The current timestamp.
   */
  public onBridgeProbeDispatched(now: number): void {
    this.bridgeProbeState = { status: "sent", sentTime: now };
  }

  /**
   * Cancels a queued-but-unsent bridge-level probe, for example when a config
   * generation invalidates pending low-priority work before it is emitted.
   */
  public cancelQueuedBridgeProbe(): void {
    if (this.bridgeProbeState?.status === "queued") {
      this.bridgeProbeState = null;
    }
  }

  /**
   * Removes pending ping bookkeeping for devices that are no longer configured.
   * @param configuredDeviceNames - The devices that should remain tracked.
   * @returns The removed device names, for optional diagnostics.
   */
  public pruneDevices(configuredDeviceNames: Iterable<string>): string[] {
    const configuredDevices = new Set(configuredDeviceNames);
    const prunedDeviceNames: string[] = [];

    for (const deviceName of this.pingStates.keys()) {
      if (!configuredDevices.has(deviceName)) {
        this.pingStates.delete(deviceName);
        prunedDeviceNames.push(deviceName);
      }
    }

    return prunedDeviceNames;
  }

  /**
   * Clears all pending ping bookkeeping, typically when configuration is reset.
   */
  public reset(): void {
    this.pingStates.clear();
    this.bridgeProbeState = null;
  }
}
