// src/DeviceRegistryManager.ts

/**
 * @file Manages the in-memory state of all known devices.
 * This class is the single source of truth for device state and is solely
 * responsible for creating, updating, and querying it. It does not handle
 * I/O (like logging or sending messages).
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
 * This decouples the manager from the specifics of Node-RED's context.
 */
interface ContextReader {
  get(key: string): any;
}

export class DeviceRegistryManager {
  /** The main in-memory database of all device states, keyed by device name. */
  private registry: DeviceRegistry = {};
  /** The prefix used to construct context keys for reading external device states. */
  private readonly otherDevicesPrefix: string;
  /** A reference to the context reader (flow or global) for fetching external states. */
  private readonly otherActorsContext: ContextReader;

  constructor(otherDevicesPrefix: string, otherActorsContext: ContextReader) {
    this.otherDevicesPrefix = otherDevicesPrefix;
    this.otherActorsContext = otherActorsContext;
  }

  /**
   * @internal
   * @description A private helper to ensure a device entry exists in the registry.
   * If it doesn't, a new "shell" entry is created and returned.
   * This consolidates repetitive creation logic.
   * @param deviceName - The name of the device.
   * @returns The existing or newly created `DeviceState` object.
   */
  private _ensureDeviceExists(deviceName: string): DeviceState {
    if (!this.registry[deviceName]) {
      this.registry[deviceName] = {
        name: deviceName,
        connected: true, // Assume connected until a 'lost' message is received
        isHealthy: true,
        isStale: false,
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
   * Returns the entire device registry.
   * @returns The current device registry object.
   */
  public getRegistry(): DeviceRegistry {
    return this.registry;
  }

  /**
   * Retrieves a single device state by its name.
   * @param deviceName - The name of the device to retrieve.
   * @returns The `DeviceState` object or `undefined` if not found.
   */
  public getDevice(deviceName: string): DeviceState | undefined {
    return this.registry[deviceName];
  }

  /**
   * Prunes (removes) a device from the registry.
   * This is used when a device is removed from the configuration file.
   * @param deviceName - The name of the device to remove.
   */
  public pruneDevice(deviceName: string): void {
    delete this.registry[deviceName];
  }

  /**
   * Updates the registry with configuration details from a device's 'conf' message (`d_dd`).
   * @param deviceName - The name of the device.
   * @param details - The validated payload from the 'conf' topic.
   * @returns An object indicating if the device details have changed.
   */
  public registerDeviceDetails(
    deviceName: string,
    details: DeviceDetailsPayload
  ): { changed: boolean } {
    const device = this._ensureDeviceExists(deviceName);

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

    if (device.actuatorStates.length !== details.ai.length) {
      device.actuatorStates = new Array(details.ai.length).fill(false);
    }
    return { changed: true }; // Receiving details always constitutes a change.
  }

  /**
     * Updates the actuator states for a specific device from a 'state' message (`d_as`).
     * @param deviceName - The name of the device.
     * @param newStates - The array of booleans from the 'state' topic payload.
     * @returns An object indicating if the device was new and if its state changed.
     * @throws An `Error` if the state array length doesn't match the known configuration.
     */
  public registerActuatorStates(
    deviceName: string,
    newStates: boolean[]
  ): { isNew: boolean, changed: boolean } {
    const isNew = !this.registry[deviceName];
    const device = this._ensureDeviceExists(deviceName);

    if (
      device.lastDetailsTime > 0 &&
      device.actuatorsIDs.length !== newStates.length
    ) {
      throw new Error(
        `State mismatch for ${deviceName}: expected ${device.actuatorsIDs.length} states, received ${newStates.length}.`
      );
    }

    const hasChanged = !areSameArray(device.actuatorStates, newStates);

    if (hasChanged) {
      device.actuatorStates = newStates;
    }
    device.lastSeenTime = Date.now();
    return { isNew, changed: hasChanged };
  }

  /**
   * Updates the connection status of a device based on Homie $state messages.
   * @param deviceName - The name of the device.
   * @param homieState - The state string from the Homie topic (e.g., "ready", "lost").
   * @returns An object indicating if the connection state changed.
   */
  public updateConnectionState(
    deviceName: string,
    homieState: string
  ): { changed: boolean; connected: boolean } {
    const device = this._ensureDeviceExists(deviceName);

    const wasConnected = device.connected;
    const isReady = homieState === "ready";

    if (wasConnected === isReady) {
      return { changed: false, connected: isReady };
    }

    device.connected = isReady;
    if (isReady) {
      device.isHealthy = true;
      device.isStale = false;
    }
    device.lastSeenTime = Date.now();
    return { changed: true, connected: isReady };
  }

  /**
   * Records a boot event (`d_b`) from a device.
   * @param deviceName - The name of the device that booted.
   * @returns An object indicating if the state was changed.
   */
  public recordBoot(deviceName: string): { stateChanged: boolean } {
    const device = this._ensureDeviceExists(deviceName);
    const now = Date.now();
    device.lastSeenTime = now;
    device.lastBootTime = now;
    // A boot event always resets health status.
    device.isHealthy = true;
    device.isStale = false;
    return { stateChanged: true };
  }

  /**
   * Records a ping response (`d_p`) from a device.
   * @param deviceName - The name of the device that responded.
   * @returns An object indicating if the state was changed.
   */
  public recordPingResponse(deviceName: string): { stateChanged: boolean } {
    const device = this._ensureDeviceExists(deviceName);
    let stateChanged = false;
    if (device.isStale) {
      device.isStale = false;
      stateChanged = true;
    }
    // Also mark as healthy if it was previously unhealthy.
    if (!device.isHealthy) {
      device.isHealthy = true;
      stateChanged = true;
    }
    device.lastSeenTime = Date.now();
    return { stateChanged };
  }

  /**
   * Updates the health status of a device based on a watchdog check result.
   * @param deviceName - The name of the device to update.
   * @param result - The result from the Watchdog health check.
   * @returns An object indicating if the internal state was changed.
   */
  public updateHealthFromResult(
    deviceName: string,
    result: WatchdogResult
  ): { stateChanged: boolean } {
    const device = this.getDevice(deviceName);
    let stateChanged = false;

    if (!device) {
      return { stateChanged: false };
    }

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
        if (device.isHealthy) {
          device.isHealthy = false;
          stateChanged = true;
        }
        if (device.isStale) {
          device.isStale = false;
          stateChanged = true;
        }
        break;

      case "needs_ping":
        break;
    }

    return { stateChanged };
  }

  /**
   * Calculates the desired state for a "smart toggle" operation.
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
      { active: 0, total: 0 }
    );

    const prefix = this.otherDevicesPrefix;

    const otherCounts = otherActors.reduce(
      (acc, actorName) => {
        const state = this.otherActorsContext.get(`${prefix}.${actorName}.state`);
        if (typeof state === "boolean") {
          acc.total++;
          if (state === true) acc.active++;
        } else {
          // Collect all warnings instead of just the first one
          acc.warnings.push(`State for otherActor '${actorName}' not found or not a boolean.`);
        }
        return acc;
      },
      { active: 0, total: 0, warnings: [] as string[] } // Add a warnings array to the accumulator
    );
    const warning = otherCounts.warnings.join(' ');
    const totalCount = lshCounts.total + otherCounts.total;
    const activeCount = lshCounts.active + otherCounts.active;

    if (totalCount === 0) {
      return {
        stateToSet: false,
        active: 0,
        total: 0,
        warning: warning ?? "Smart Toggle: No valid actuators found to calculate state.",
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