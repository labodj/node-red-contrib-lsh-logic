/**
 * @file Manages the in-memory state of all known devices.
 * @description This class acts as the single source of truth for device state and is solely
 * responsible for creating, updating, and querying it. It is decoupled from
 * Node-RED and does not perform I/O (like logging or sending messages).
 */
import type {
  DeviceRegistry,
  DeviceRegistrySnapshot,
  DeviceState,
  DeviceStateSnapshot,
  DeviceDetailsPayload,
  Actor,
  ActuatorIndexMap,
  HomieLifecycleState,
} from "./types";
import { areSameArray, normalizeActors } from "./utils";
import type { WatchdogResult } from "./Watchdog";

/**
 * An interface describing an object that can read values from a context store.
 * This decouples the manager from Node-RED's context API for easier testing.
 */
interface ContextReader {
  get(key: string): unknown;
}

/**
 * Manages the in-memory state of all known devices.
 */
export class DeviceRegistryManager {
  /** The main in-memory database of all device states, keyed by device name. */
  private registry: DeviceRegistry = {};
  /**
   * Incremental read-optimized snapshot used for exposure outside the manager.
   * Each device entry is cloned only when that device changes.
   */
  private registrySnapshot: DeviceRegistrySnapshot = Object.freeze({});
  /** The prefix used to construct context keys for reading external device states. */
  private readonly otherDevicesPrefix: string;
  /** A reference to the context reader for fetching external states (e.g., from flow or global context). */
  private readonly otherActorsContext: ContextReader;

  /**
   * @param otherDevicesPrefix - The prefix for context keys (e.g., "other_devices").
   * @param otherActorsContext - A context reader for external device states.
   */
  constructor(otherDevicesPrefix: string, otherActorsContext: ContextReader) {
    this.otherDevicesPrefix = otherDevicesPrefix;
    this.otherActorsContext = otherActorsContext;
  }

  private _createDeviceSnapshot(device: DeviceState): DeviceStateSnapshot {
    const snapshot: DeviceStateSnapshot = {
      ...device,
      actuatorsIDs: Object.freeze([...device.actuatorsIDs]),
      buttonsIDs: Object.freeze([...device.buttonsIDs]),
      actuatorStates: Object.freeze([...device.actuatorStates]),
      actuatorIndexes: Object.freeze({ ...device.actuatorIndexes }),
    };
    return Object.freeze(snapshot);
  }

  private _publishDeviceSnapshot(deviceName: string): void {
    const device = this.registry[deviceName];
    if (!device) {
      if (!(deviceName in this.registrySnapshot)) {
        return;
      }

      const nextSnapshot: DeviceRegistrySnapshot = { ...this.registrySnapshot };
      delete nextSnapshot[deviceName];
      this.registrySnapshot = Object.freeze(nextSnapshot);
      return;
    }

    this.registrySnapshot = Object.freeze({
      ...this.registrySnapshot,
      [deviceName]: this._createDeviceSnapshot(device),
    });
  }

  /**
   * Ensures a device entry exists in the registry. If not, it creates a new
   * default entry. This implements a "create-on-write" pattern.
   * @internal
   * @param deviceName - The name of the device.
   * @returns The existing or newly created `DeviceState` object.
   */
  private _ensureDeviceExists(deviceName: string): DeviceState {
    if (!this.registry[deviceName]) {
      this.registry[deviceName] = {
        name: deviceName,
        // A new device is assumed to be bridge-disconnected and controller-unhealthy
        // until telemetry proves otherwise.
        connected: false,
        controllerLinkConnected: null,
        isHealthy: false,
        isStale: false,
        alertSent: false,
        lastSeenTime: 0,
        bridgeConnected: false,
        bridgeLastSeenTime: 0,
        lastHomieState: null,
        lastHomieStateTime: 0,
        lastDetailsTime: 0,
        lastStateTime: 0,
        actuatorsIDs: [],
        buttonsIDs: [],
        actuatorStates: [],
        actuatorIndexes: {},
      };
      this._publishDeviceSnapshot(deviceName);
    }
    return this.registry[deviceName];
  }

  /**
   * Returns a snapshot of the entire device registry.
   * The snapshot is incrementally maintained per-device so callers can inspect
   * state without paying for a full deep clone on every read.
   * @returns A detached top-level object containing frozen device snapshots.
   */
  public getRegistry(): DeviceRegistrySnapshot {
    return { ...this.registrySnapshot };
  }

  /**
   * Returns the names of the devices currently present in the registry.
   * This avoids cloning the full registry when only iteration over keys is needed.
   * @returns An array of registered device names.
   */
  public getRegisteredDeviceNames(): string[] {
    return Object.keys(this.registry);
  }

  /**
   * Retrieves a single device's state by its name.
   * @param deviceName - The name of the device to retrieve.
   * @returns The `DeviceState` object or `undefined` if not found.
   */
  public getDevice(deviceName: string): DeviceState | undefined {
    return this.registry[deviceName];
  }

  /**
   * Prunes (removes) a device from the registry. Used when a device is
   * removed from the system configuration file.
   * @param deviceName - The name of the device to remove.
   */
  public pruneDevice(deviceName: string): void {
    delete this.registry[deviceName];
    this._publishDeviceSnapshot(deviceName);
  }

  /**
   * Clears the entire registry and its detached snapshot.
   * Used when the runtime configuration is fully reset.
   */
  public reset(): void {
    this.registry = {};
    this.registrySnapshot = Object.freeze({});
  }

  /**
   * Updates the registry with configuration details from a device's 'conf' message.
   * @param deviceName - The name of the device.
   * @param details - The validated payload from the 'conf' topic.
   * @returns An object indicating if the device details have changed.
   */
  public registerDeviceDetails(
    deviceName: string,
    details: DeviceDetailsPayload,
    markSeen = true,
  ): { changed: boolean; registryChanged: boolean } {
    const device = this._ensureDeviceExists(deviceName);
    const actuatorIds = [...details.a];
    const buttonIds = [...details.b];

    const oldActuatorIDs = [...device.actuatorsIDs];
    const oldButtonIDs = [...device.buttonsIDs];
    const actuatorIdsChanged = !areSameArray(oldActuatorIDs, actuatorIds);
    const buttonIdsChanged = !areSameArray(oldButtonIDs, buttonIds);
    let changed = false;

    // Use the new keys 'a' and 'b' from the details object
    if (actuatorIdsChanged || buttonIdsChanged) {
      changed = true;
    }

    const actuatorIndexes: ActuatorIndexMap = actuatorIds.reduce((acc, id, index) => {
      acc[id] = index;
      return acc;
    }, {} as ActuatorIndexMap);

    // Merge new details into the existing device state
    const now = Date.now();
    if (markSeen) {
      device.lastSeenTime = now;
    }
    Object.assign(device, {
      lastDetailsTime: now,
      // Store detached copies so downstream mutations of the validated payload
      // cannot leak back into the runtime registry.
      actuatorsIDs: actuatorIds,
      buttonsIDs: buttonIds,
      actuatorIndexes,
    });

    if (actuatorIdsChanged) {
      device.lastStateTime = 0;
      device.actuatorStates = [];
    }

    this._publishDeviceSnapshot(deviceName);

    return { changed, registryChanged: true };
  }

  /**
   * Updates the actuator states for a specific device from a 'state' message.
   * @param deviceName - The name of the device.
   * @param newStates - The array of booleans from the 'state' topic payload.
   * @returns An object indicating if the device was new, if its state changed, and if its config is missing.
   * @throws An `Error` if the state array length doesn't match the known configuration.
   */
  public registerActuatorStates(
    deviceName: string,
    newStates: boolean[],
    markSeen = true,
  ): { isNew: boolean; changed: boolean; configIsMissing: boolean; registryChanged: boolean } {
    const isNew = !this.registry[deviceName];
    const device = this._ensureDeviceExists(deviceName);

    const configIsMissing = device.lastDetailsTime === 0;

    if (!configIsMissing && device.actuatorsIDs.length !== newStates.length) {
      throw new Error(
        `State mismatch for ${deviceName}: expected ${device.actuatorsIDs.length} states, received ${newStates.length}.`,
      );
    }

    const hasChanged = !areSameArray(device.actuatorStates, newStates);

    if (hasChanged) {
      // Keep the registry detached from caller-owned arrays. This function is
      // hot enough to stay simple, but not so hot that a tiny defensive copy is
      // a problem on Node.js.
      device.actuatorStates = [...newStates];
    }
    const now = Date.now();
    if (markSeen) {
      device.lastSeenTime = now;
    }
    device.lastStateTime = now;
    this._publishDeviceSnapshot(deviceName);
    return { isNew, changed: hasChanged, configIsMissing, registryChanged: true };
  }

  /**
   * Updates a device's bridge reachability status based on Homie `$state` messages.
   * Homie lifecycle describes the MQTT-facing bridge runtime, not the downstream
   * controller health.
   * @param deviceName - The name of the device.
   * @param homieState - The state string from the Homie topic (e.g., "ready", "lost").
   * @returns An object indicating if the internal state was changed, and the old/new bridge connection states.
   */
  public updateBridgeConnectionState(
    deviceName: string,
    homieState: HomieLifecycleState,
  ): { stateChanged: boolean; wasConnected: boolean; isConnected: boolean } {
    const device = this._ensureDeviceExists(deviceName);
    const wasConnected = device.bridgeConnected;

    // Homie `init` and `sleeping` are diagnostic-only runtime hints. They must
    // never mutate the bridge/controller reachability booleans.
    if (homieState !== "ready" && homieState !== "lost") {
      return { stateChanged: false, wasConnected, isConnected: wasConnected };
    }

    const isConnected = homieState === "ready";

    if (wasConnected === isConnected) {
      // If the state is the same, return that nothing changed.
      return { stateChanged: false, wasConnected, isConnected };
    }

    const now = Date.now();
    device.bridgeConnected = isConnected;
    device.bridgeLastSeenTime = now;

    if (!isConnected) {
      // Once the bridge is offline, the controller cannot be considered reachable.
      device.connected = false;
      device.controllerLinkConnected = null;
      device.isHealthy = false;
      device.isStale = false;
    }
    this._publishDeviceSnapshot(deviceName);
    return { stateChanged: true, wasConnected, isConnected };
  }

  /**
   * Records the last raw Homie lifecycle state observed for a device.
   * This keeps diagnostic lifecycle states inspectable without coupling them
   * directly to alerting and resync decisions.
   * @param deviceName - The name of the device.
   * @param homieState - The raw Homie `$state` payload.
   * @param markSeen - Whether this message should count as live device activity.
   * @returns Whether the raw lifecycle state changed.
   */
  public recordHomieLifecycleState(
    deviceName: string,
    homieState: HomieLifecycleState,
    markSeen = true,
  ): { stateChanged: boolean; registryChanged: boolean } {
    const device = this._ensureDeviceExists(deviceName);
    const previousState = device.lastHomieState;
    const now = Date.now();

    device.lastHomieState = homieState;
    device.lastHomieStateTime = now;

    if (markSeen) {
      device.bridgeLastSeenTime = now;
    }

    this._publishDeviceSnapshot(deviceName);

    return { stateChanged: previousState !== homieState, registryChanged: true };
  }

  /**
   * Records live, non-retained traffic from the device itself.
   * This is strong evidence that the MQTT/LSH path is currently alive.
   * @param deviceName - The name of the device that emitted live traffic.
   * @returns Reachability transition details.
   */
  public recordControllerActivity(deviceName: string): {
    stateChanged: boolean;
    becameHealthy: boolean;
    registryChanged: boolean;
  } {
    const device = this._ensureDeviceExists(deviceName);

    const wasHealthy = device.isHealthy;
    const wasStale = device.isStale;
    const wasConnected = device.connected;

    const becameHealthy = !wasHealthy || wasStale;

    device.lastSeenTime = Date.now();
    device.bridgeLastSeenTime = device.lastSeenTime;
    device.connected = true;
    device.bridgeConnected = true;
    device.controllerLinkConnected = true;

    if (becameHealthy) {
      device.isHealthy = true;
      device.isStale = false;
      device.alertSent = false;
    }

    this._publishDeviceSnapshot(deviceName);

    return {
      stateChanged: becameHealthy || !wasConnected,
      becameHealthy,
      registryChanged: true,
    };
  }

  /**
   * Records a bridge-local service ping reply without promoting controller
   * health from bridge-only traffic.
   * @param deviceName - The device whose bridge replied.
   * @param controllerConnected - Bridge-reported controller link status.
   * @param runtimeSynchronized - Bridge-reported runtime sync status.
   * @returns Transition details for exposed state updates and logging.
   */
  public recordBridgePingReply(
    deviceName: string,
    controllerConnected: boolean,
    runtimeSynchronized: boolean,
  ): {
    stateChanged: boolean;
    bridgeBecameConnected: boolean;
    controllerDisconnected: boolean;
    snapshotInvalidated: boolean;
    registryChanged: boolean;
  } {
    const device = this._ensureDeviceExists(deviceName);
    const now = Date.now();
    const bridgeBecameConnected = !device.bridgeConnected;
    const controllerWasOperational = device.connected || device.isHealthy || device.isStale;
    const snapshotInvalidated =
      controllerConnected && !runtimeSynchronized && device.lastStateTime !== 0;

    device.bridgeConnected = true;
    device.bridgeLastSeenTime = now;
    device.controllerLinkConnected = controllerConnected;

    const controllerDisconnected = !controllerConnected && controllerWasOperational;

    if (!controllerConnected) {
      device.connected = false;
      device.isHealthy = false;
      device.isStale = false;
    }

    if (snapshotInvalidated) {
      // The last state is still useful for diagnostics, but no longer
      // authoritative for click logic until a fresh `state` arrives.
      device.lastStateTime = 0;
    }

    this._publishDeviceSnapshot(deviceName);

    return {
      stateChanged: bridgeBecameConnected || controllerDisconnected || snapshotInvalidated,
      bridgeBecameConnected,
      controllerDisconnected,
      snapshotInvalidated,
      registryChanged: true,
    };
  }

  /**
   * Updates the health status of a device based on a watchdog check result.
   * This cleanly separates the *decision* (made by the Watchdog) from the *action*
   * of updating the device's state record.
   * @param deviceName - The name of the device to update.
   * @param result - The result from the Watchdog health check.
   * @returns An object indicating if the internal state was changed.
   */
  public updateHealthFromResult(
    deviceName: string,
    result: WatchdogResult,
  ): { stateChanged: boolean } {
    const device = this.getDevice(deviceName);
    if (!device) {
      return { stateChanged: false };
    }

    let stateChanged = false;

    switch (result.status) {
      case "ok":
        if (!device.isHealthy || device.isStale) {
          device.isHealthy = true;
          device.isStale = false;
          stateChanged = true;
        }
        break;

      case "stale":
        if (!device.isStale) {
          device.isStale = true;
          stateChanged = true;
        }
        break;

      // A queued retry must keep the stale latch without generating another
      // semantic state transition on every watchdog tick.
      case "retry_queued":
        break;

      case "unhealthy":
        // The watchdog has declared the device unhealthy. This overrides previous states.
        if (device.isHealthy || device.isStale) {
          device.isHealthy = false;
          device.isStale = false; // An unhealthy device is not considered stale.
          stateChanged = true;
        }
        break;

      // "needs_ping" does not change the health status itself.
      case "needs_ping":
        break;
    }

    if (stateChanged) {
      this._publishDeviceSnapshot(deviceName);
    }

    return { stateChanged };
  }

  /**
   * Records that an alert for a device's unhealthy state has been sent.
   * This creates a device entry if one doesn't exist.
   * @param deviceName - The name of the device for which an alert was sent.
   * @returns An object indicating if the state was changed.
   */
  public recordAlertSent(deviceName: string): { stateChanged: boolean } {
    const device = this._ensureDeviceExists(deviceName);
    if (device.alertSent) {
      return { stateChanged: false };
    }
    device.isHealthy = false; // A device with an alert is not healthy
    device.alertSent = true;
    this._publishDeviceSnapshot(deviceName);
    return { stateChanged: true };
  }

  /**
   * Calculates the desired state for a "smart toggle" operation. The rule is:
   * if less than 50% of targeted actuators are ON, turn them all ON; otherwise, turn them all OFF.
   * This prevents a single "on" light from causing the whole group to turn off.
   * This logic considers both primary LSH actors and secondary external actors.
   * @param actors - An array of primary LSH actors to consider.
   * @param otherActors - An array of secondary external actor names.
   * @returns An object with the calculated state and diagnostic info.
   */
  public getSmartToggleState(
    actors: Actor[],
    otherActors: string[],
  ): { stateToSet: boolean; active: number; total: number; warning?: string } {
    const lshWarnings: string[] = [];
    const lshCounts = normalizeActors(actors).reduce(
      (acc, actor) => {
        const device = this.registry[actor.name];
        if (!device) return acc;
        if (device.lastStateTime === 0) {
          lshWarnings.push(
            `State for device '${actor.name}' is not authoritative yet; ignoring it for smart toggle.`,
          );
          return acc;
        }

        if (actor.allActuators) {
          acc.total += device.actuatorStates.length;
          acc.active += device.actuatorStates.filter(Boolean).length;
        } else {
          for (const actuatorId of actor.actuators) {
            const index = device.actuatorIndexes[actuatorId];
            if (index !== undefined && device.actuatorStates[index] !== undefined) {
              acc.total++;
              if (device.actuatorStates[index]) {
                acc.active++;
              }
            }
          }
        }
        return acc;
      },
      { active: 0, total: 0 },
    );

    const prefix = this.otherDevicesPrefix;
    const otherCounts = otherActors.reduce(
      (acc, actorName) => {
        const state = this.otherActorsContext.get(`${prefix}.${actorName}.state`);
        if (typeof state === "boolean") {
          acc.total++;
          if (state === true) acc.active++;
        } else {
          acc.warnings.push(`State for otherActor '${actorName}' not found or not a boolean.`);
        }
        return acc;
      },
      { active: 0, total: 0, warnings: [] as string[] },
    );

    const warning = [...lshWarnings, ...otherCounts.warnings].join(" ");
    const totalCount = lshCounts.total + otherCounts.total;
    const activeCount = lshCounts.active + otherCounts.active;

    if (totalCount === 0) {
      return {
        stateToSet: false, // Default to OFF if no valid actuators are found.
        active: 0,
        total: 0,
        warning: warning ? warning : "Smart Toggle: No valid actuators found to calculate state.",
      };
    }

    const shouldTurnOn = activeCount < totalCount / 2.0;

    return {
      stateToSet: shouldTurnOn,
      active: activeCount,
      total: totalCount,
      warning,
    };
  }
}
