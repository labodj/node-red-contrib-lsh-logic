/**
 * @file Manages the in-memory state of all known devices.
 * @description This class acts as the single source of truth for device state and is solely
 * responsible for creating, updating, and querying it. It is decoupled from
 * Node-RED and does not perform I/O (like logging or sending messages).
 */
import {
  DeviceRegistry,
  DeviceState,
  DeviceDetailsPayload,
  Actor,
  ActuatorIndexMap,
} from "./types";
import { areSameArray } from "./utils";
import { WatchdogResult } from "./Watchdog";

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
        // A new device is assumed to be disconnected and unhealthy until it
        // proves it's online via a 'ready' message, boot, or ping response.
        connected: false,
        isHealthy: false,
        isStale: false,
        alertSent: false,
        lastSeenTime: 0,
        lastBootTime: 0,
        lastDetailsTime: 0,
        actuatorsIDs: [],
        buttonsIDs: [],
        actuatorStates: [],
        actuatorIndexes: {},
      };
    }
    return this.registry[deviceName];
  }

/**
   * Returns a deep copy of the entire device registry.
   * This prevents external code from accidentally modifying the internal state.
   * Uses the modern, robust `structuredClone` function.
   * @returns A deep copy of the current device registry object.
   */
  public getRegistry(): DeviceRegistry {
    return structuredClone(this.registry);
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
  }

  /**
   * Updates the registry with configuration details from a device's 'conf' message.
   * @param deviceName - The name of the device.
   * @param details - The validated payload from the 'conf' topic.
   * @returns An object indicating if the device details have changed.
   */
  public registerDeviceDetails(
    deviceName: string,
    details: DeviceDetailsPayload
  ): { changed: boolean } {
    const device = this._ensureDeviceExists(deviceName);

    const oldActuatorIDs = [...device.actuatorsIDs];
    const oldButtonIDs = [...device.buttonsIDs];
    let changed = false;

    if (!areSameArray(oldActuatorIDs, details.ai) || !areSameArray(oldButtonIDs, details.bi)) {
      changed = true;
    }

    const actuatorIndexes: ActuatorIndexMap = details.ai.reduce(
      (acc, id, index) => {
        acc[id] = index;
        return acc;
      },
      {} as ActuatorIndexMap
    );

    // Merge new details into the existing device state
    Object.assign(device, {
      lastSeenTime: Date.now(),
      lastDetailsTime: Date.now(),
      actuatorsIDs: details.ai,
      buttonsIDs: details.bi,
      actuatorIndexes,
    });
    // If the number of actuators has changed, the old state array is invalid.
    // Reset it to the new correct length, initialized to all 'false'.
    if (device.actuatorStates.length !== details.ai.length) {
      device.actuatorStates = new Array<boolean>(details.ai.length).fill(false);
      changed = true;
    }

    return { changed };
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
    newStates: boolean[]
  ): { isNew: boolean; changed: boolean; configIsMissing: boolean } {
    const isNew = !this.registry[deviceName];
    const device = this._ensureDeviceExists(deviceName);

    const configIsMissing = device.lastDetailsTime === 0;

    if (!configIsMissing && device.actuatorsIDs.length !== newStates.length) {
      throw new Error(
        `State mismatch for ${deviceName}: expected ${device.actuatorsIDs.length} states, received ${newStates.length}.`
      );
    }

    const hasChanged = !areSameArray(device.actuatorStates, newStates);

    if (hasChanged) {
      device.actuatorStates = newStates;
    }
    device.lastSeenTime = Date.now();
    return { isNew, changed: hasChanged, configIsMissing };
  }

  /**
   * Updates a device's status based on Homie `$state` messages.
   * This method is now only responsible for updating the internal state.
   * @param deviceName - The name of the device.
   * @param homieState - The state string from the Homie topic (e.g., "ready", "lost").
   * @returns An object indicating if the internal state was changed.
   */
  public updateConnectionState(
    deviceName: string,
    homieState: string
  ): { stateChanged: boolean } {
    const device = this._ensureDeviceExists(deviceName);
    const wasConnected = device.connected;
    const isReady = homieState === 'ready';

    if (wasConnected === isReady) {
      return { stateChanged: false };
    }

    device.connected = isReady;
    device.lastSeenTime = Date.now();

    if (isReady) {
      device.isHealthy = true;
      device.isStale = false;
      device.alertSent = false;
    } else {
      device.isHealthy = false;
      device.isStale = false;
    }

    return { stateChanged: true };
  }

  /**
   * Records a boot event from a device, marking it as connected and healthy.
   * @param deviceName - The name of the device that booted.
   * @returns An object indicating if the state was changed.
   */
  public recordBoot(deviceName: string): { stateChanged: boolean } {
    const device = this._ensureDeviceExists(deviceName);

    const willChange = !device.connected || !device.isHealthy || device.isStale;

    const now = Date.now();
    device.lastSeenTime = now;
    device.lastBootTime = now;
    device.connected = true;
    device.isHealthy = true;
    device.isStale = false;

    return { stateChanged: willChange };
  }

 /**
   * Records a ping response from a device, marking it as healthy.
   * A ping response is a strong indicator of LSH-level health.
   * @param deviceName - The name of the device that responded.
   * @returns An object indicating if the internal state was changed.
   */
  public recordPingResponse(deviceName: string): { stateChanged: boolean } {
    const device = this._ensureDeviceExists(deviceName);

    const wasHealthy = device.isHealthy;
    const wasStale = device.isStale;

    const stateChanged = !wasHealthy || wasStale;

    if (stateChanged) {
        device.isHealthy = true;
        device.isStale = false;
        device.alertSent = false;
        device.lastSeenTime = Date.now();
    }
    
    return { stateChanged };
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
    result: WatchdogResult
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
    otherActors: string[]
  ): { stateToSet: boolean; active: number; total: number; warning?: string } {
    const lshCounts = actors.reduce(
      (acc, actor) => {
        const device = this.registry[actor.name];
        if (!device) return acc;

        if (actor.allActuators) {
          acc.total += device.actuatorStates.length;
          acc.active += device.actuatorStates.filter(Boolean).length;
        } else {
          for (const actuatorId of actor.actuators) {
            const index = device.actuatorIndexes[actuatorId];
            if (
              index !== undefined &&
              device.actuatorStates[index] !== undefined
            ) {
              acc.total++;
              if (device.actuatorStates[index]) {
                acc.active++;
              }
            }
          }
        }
        return acc;
      },
      { active: 0, total: 0 }
    );

    const prefix = this.otherDevicesPrefix;
    const otherCounts = otherActors.reduce(
      (acc, actorName) => {
        const state = this.otherActorsContext.get(
          `${prefix}.${actorName}.state`
        );
        if (typeof state === "boolean") {
          acc.total++;
          if (state === true) acc.active++;
        } else {
          acc.warnings.push(
            `State for otherActor '${actorName}' not found or not a boolean.`
          );
        }
        return acc;
      },
      { active: 0, total: 0, warnings: [] as string[] }
    );

    const warning = otherCounts.warnings.join(" ");
    const totalCount = lshCounts.total + otherCounts.total;
    const activeCount = lshCounts.active + otherCounts.active;

    if (totalCount === 0) {
      return {
        stateToSet: false, // Default to OFF if no valid actuators are found.
        active: 0,
        total: 0,
        warning: warning
          ? warning
          : "Smart Toggle: No valid actuators found to calculate state.",
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
