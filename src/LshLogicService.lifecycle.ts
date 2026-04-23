import type { DeviceState, SystemConfig } from "./types";

/**
 * Collects actions to be performed at the end of a watchdog cycle.
 */
export type WatchdogActions = {
  devicesToPing: Set<string>;
  unhealthyDevicesForAlert: Array<{ name: string; reason: string }>;
  stateChanged: boolean;
  shouldProbeBridges: boolean;
};

/**
 * Describes the strongest currently known recovery path for a configured
 * device. This keeps startup verification, watchdog repair, and bridge-service
 * replies aligned on the same reachability model.
 */
export type DeviceRecoveryPath = "controller_reachable" | "bridge_only" | "offline";

/**
 * Collapses registry state into the three lifecycle recovery paths that matter
 * operationally for startup, watchdog, and bridge-repair logic.
 */
export const classifyDeviceRecoveryPath = (
  deviceState: DeviceState | undefined,
): DeviceRecoveryPath => {
  if (!deviceState || (!deviceState.connected && !deviceState.bridgeConnected)) {
    return "offline";
  }

  if (deviceState.bridgeConnected && deviceState.controllerLinkConnected === false) {
    return "bridge_only";
  }

  return "controller_reachable";
};

/**
 * Returns whether the watchdog should prefer a bridge-level probe for the
 * current lifecycle path instead of issuing controller-directed recovery.
 */
export const shouldProbeBridgeForRecoveryPath = (recoveryPath: DeviceRecoveryPath): boolean => {
  return recoveryPath !== "controller_reachable";
};

/**
 * Returns the first actor reference that does not resolve to a configured
 * device name, or `null` if the config is self-consistent.
 */
export const findUnknownActorReference = (
  config: SystemConfig,
): { sourceDeviceName: string; actorName: string } | null => {
  const knownDeviceNames = new Set(config.devices.map(({ name }) => name));

  for (const device of config.devices) {
    for (const buttonConfig of [
      ...(device.longClickButtons ?? []),
      ...(device.superLongClickButtons ?? []),
    ]) {
      for (const actor of buttonConfig.actors ?? []) {
        if (!knownDeviceNames.has(actor.name)) {
          return { sourceDeviceName: device.name, actorName: actor.name };
        }
      }
    }
  }

  return null;
};
