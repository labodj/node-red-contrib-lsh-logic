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
