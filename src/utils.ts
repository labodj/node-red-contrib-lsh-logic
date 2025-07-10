/**
 * Creates a promise that resolves after a specified number of milliseconds.
 * A utility function for creating non-blocking delays.
 * @param ms - The number of milliseconds to wait.
 * @returns A promise that resolves when the timeout is complete.
 */
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Corresponds to the original "Format Alert Message" function node.
 * @param unhealthyDevices - The array of unhealthy device objects.
 * @returns A formatted string suitable for notifications.
 */
export const formatAlertMessage = (
  unhealthyDevices: { name: string; reason: string }[]
): string => {
  let message = "‼️ *System Health Alert* ‼️\n\n";
  message += "The following devices have stopped responding:\n";

  unhealthyDevices.forEach((device) => {
    message += `  - *${device.name}*: ${device.reason}\n`;
  });

  message += "\nPlease check their power and network connection.";
  return message;
};

/**
 * Compares two simple arrays to check if they contain the same values in the same order.
 * This is a shallow comparison, suitable for arrays of primitive types.
 *
 * @param a - The first array.
 * @param b - The second array.
 * @returns `true` if the arrays are identical, otherwise `false`.
 * @template T - The type of elements in the array.
 */
export const areSameArray = <T>(a: T[], b: T[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);