/**
 * @file Manages the in-memory state of all known devices.
 * This class is responsible for creating, updating, and querying device states,
 * but does not handle I/O (like logging or sending messages).
 */

import {
  DeviceRegistry,
  DeviceState,
  DeviceConfPayload,
  Actor,
  ActuatorIndexMap,
} from "./types";

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
  private otherDevicesPrefix: string;
  /** A reference to the context reader (flow or global) for fetching external states. */
  private otherActorsContext: ContextReader;

  /**
   * Creates a default, empty state object for a new device.
   * This "shell" entry is typically created when a message is received
   * from a device before its 'conf' message has been processed.
   * @param deviceName - The name of the new device.
   * @returns The newly created `DeviceState` object.
   * @private
   */
  constructor(otherDevicesPrefix: string, otherActorsContext: ContextReader) {
    this.otherDevicesPrefix = otherDevicesPrefix;
    this.otherActorsContext = otherActorsContext;
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
   * Creates a default, empty state object for a new device.
   * @param deviceName - The name of the new device.
   * @returns The newly created `DeviceState` object.
   */
  private createShellDevice(deviceName: string): DeviceState {
    const shell: DeviceState = {
      name: deviceName,
      connected: true,
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
    this.registry[deviceName] = shell;
    return shell;
  }

  /**
   * Updates the registry with configuration details from a device's 'conf' message.
   * @param deviceName - The name of the device.
   * @param details - The payload from the 'conf' topic.
   */
  public storeDeviceDetails(
    deviceName: string,
    details: DeviceConfPayload
  ): void {
    let device =
      this.registry[deviceName] || this.createShellDevice(deviceName);

    const actuatorIndexes: ActuatorIndexMap = details.ai.reduce(
      (acc, id, index) => {
        acc[id] = index;
        return acc;
      },
      {} as ActuatorIndexMap
    );

    device = {
      ...device,
      name: deviceName,
      lastSeenTime: Date.now(),
      lastDetailsTime: Date.now(),
      actuatorsIDs: details.ai,
      buttonsIDs: details.bi,
      actuatorIndexes,
    };

    if (device.actuatorStates.length !== details.ai.length) {
      device.actuatorStates = new Array(details.ai.length).fill(false);
    }

    this.registry[deviceName] = device;
  }

  /**
   * Updates the actuator states for a specific device.
   * @param deviceName - The name of the device.
   * @param states - The array of booleans from the 'state' topic payload.
   * @returns `true` if the device was newly created, `false` otherwise.
   * @throws An `Error` if the state array length doesn't match the known configuration.
   */
  public storeDeviceState(deviceName: string, states: boolean[]): boolean {
    let isNew = false;
    let device = this.registry[deviceName];
    if (!device) {
      device = this.createShellDevice(deviceName);
      isNew = true;
    }

    if (
      device.lastDetailsTime > 0 &&
      device.actuatorsIDs.length !== states.length
    ) {
      throw new Error(
        `State mismatch for ${deviceName}: expected ${device.actuatorsIDs.length} states, received ${states.length}.`
      );
    }

    device.actuatorStates = states;
    device.lastSeenTime = Date.now();
    return isNew;
  }

  /**
   * Updates the connection status of a device based on Homie $state messages.
   * @param deviceName - The name of the device.
   * @param homieState - The state string from the Homie topic (e.g., "ready", "lost").
   * @returns An object indicating if the connection state changed and the new status.
   */
  public storeConnectionState(
    deviceName: string,
    homieState: string
  ): { changed: boolean; connected: boolean } {
    let device = this.registry[deviceName];
    if (!device) {
      device = this.createShellDevice(deviceName);
      device.connected = false; // A new device is not connected until 'ready'
    }

    const wasConnected = device.connected;
    const isReady = homieState === "ready";

    if (wasConnected === isReady) {
      return { changed: false, connected: isReady };
    }

    device.connected = isReady;
    if (isReady) {
      // Business rule: When a device comes online (Homie 'ready'),
      // its health status is reset to a healthy, non-stale state.
      // This clears any previous 'stale' or 'unhealthy' flags from the watchdog.
      device.isHealthy = true;
      device.isStale = false;
      device.lastSeenTime = Date.now();
    }
    return { changed: true, connected: isReady };
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
    let activeCount = 0;
    let totalCount = 0;
    let warning: string | undefined;

    for (const actor of actors) {
      const device = this.registry[actor.name];
      if (!device) continue;

      if (actor.allActuators) {
        totalCount += device.actuatorStates.length;
        activeCount += device.actuatorStates.filter((s) => s === true).length;
      } else {
        for (const actuatorId of actor.actuators) {
          const index = device.actuatorIndexes[actuatorId];
          if (
            index !== undefined &&
            device.actuatorStates[index] !== undefined
          ) {
            totalCount++;
            if (device.actuatorStates[index] === true) {
              activeCount++;
            }
          }
        }
      }
    }

    const prefix = this.otherDevicesPrefix;
    for (const actorName of otherActors) {
      const state = this.otherActorsContext.get(`${prefix}.${actorName}.state`);
      if (typeof state === "boolean") {
        totalCount++;
        if (state === true) activeCount++;
      } else {
        warning = `State for otherActor '${actorName}' not found or not a boolean.`;
      }
    }

    if (totalCount === 0) {
      return {
        stateToSet: false,
        active: 0,
        total: 0,
        warning: "Smart Toggle: No valid actuators found to calculate state.",
      };
    }

    // This is the core "Smart Toggle" logic: turn the lights ON only if
    // less than half of them are already on. Otherwise, turn them all OFF.
    const shouldTurnOn = activeCount < totalCount / 2.0;
    return {
      stateToSet: shouldTurnOn,
      active: activeCount,
      total: totalCount,
      warning,
    };
  }
}
