/**
 * @file A collection of small, pure, and reusable utility functions
 * that are used across the application.
 */
import type { Actor } from "./types";

/**
 * Creates a promise that resolves after a specified number of milliseconds.
 * This is a non-blocking delay, useful for staggering commands.
 * @param ms - The number of milliseconds to wait.
 * @returns A promise that resolves when the timeout is complete.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Formats a list of devices into a human-readable alert message.
 * @param devices - An array of objects, each with a device name and a reason.
 * @param status - The type of alert to generate, which determines the message header.
 * @param details - Additional details to include in the message.
 * @returns A formatted string suitable for notifications (e.g., Telegram with Markdown).
 */
export const formatAlertMessage = (
  devices: { name: string; reason: string }[],
  status: "unhealthy" | "healthy",
  details?: unknown,
): string => {
  let message = "";
  if (status === "unhealthy") {
    message = "‼️ *System Health Alert* ‼️\n\n";
    message += "The following event occurred:\n";
  } else {
    message = "✅ *System Health Recovery* ✅\n\n";
    message += "The following devices are now back online:\n";
  }

  devices.forEach((device) => {
    message += `  - *${device.name}*: ${device.reason}\n`;
  });

  // Check if details exist and are of a type we can stringify meaningfully.
  if (details !== undefined && details !== null) {
    message += "\n*Details:*\n";
    message += formatAlertDetails(details);
    message += "\n";
  }

  if (status === "unhealthy") {
    message += "\nPlease check power and network connections where applicable.";
  }
  return message;
};

const formatAlertDetails = (details: unknown): string => {
  if (details instanceof Error) {
    return details.stack ?? details.message;
  }

  if (typeof details === "object") {
    return JSON.stringify(details, null, 2);
  }

  if (
    typeof details === "string" ||
    typeof details === "number" ||
    typeof details === "boolean" ||
    typeof details === "bigint"
  ) {
    return String(details);
  }

  if (typeof details === "symbol") {
    return details.toString();
  }

  return "";
};

/**
 * Performs a shallow comparison of two arrays to check if they contain the
 * same primitive values in the same order.
 * @param a - The first array.
 * @param b - The second array.
 * @returns `true` if the arrays are identical, otherwise `false`.
 */
export const areSameArray = <T>(a: T[], b: T[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/**
 * Merges multiple actor entries that target the same device into a single,
 * deterministic actor definition.
 * `allActuators=true` dominates any partial subsets for that device.
 */
export const normalizeActors = (actors: Actor[]): Actor[] => {
  const normalizedActors = new Map<
    string,
    {
      actor: Actor;
      seenActuators: Set<number>;
    }
  >();

  for (const actor of actors) {
    const existing = normalizedActors.get(actor.name);
    if (!existing) {
      normalizedActors.set(actor.name, {
        actor: {
          name: actor.name,
          allActuators: actor.allActuators,
          actuators: actor.allActuators ? [] : [...actor.actuators],
        },
        seenActuators: new Set(actor.allActuators ? [] : actor.actuators),
      });
      continue;
    }

    if (existing.actor.allActuators) {
      continue;
    }

    if (actor.allActuators) {
      existing.actor.allActuators = true;
      existing.actor.actuators = [];
      existing.seenActuators.clear();
      continue;
    }

    for (const actuatorId of actor.actuators) {
      if (!existing.seenActuators.has(actuatorId)) {
        existing.seenActuators.add(actuatorId);
        existing.actor.actuators.push(actuatorId);
      }
    }
  }

  return Array.from(normalizedActors.values(), ({ actor }) => actor);
};
