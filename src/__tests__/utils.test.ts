import { formatAlertMessage } from "../utils";

describe("formatAlertMessage", () => {
  it("should create a correctly formatted message for a single device", () => {
    const unhealthyDevices = [
      { name: "living-room-light", reason: "Ping failed." },
    ];
    const expectedMessage =
      "‼️ *System Health Alert* ‼️\n\n" +
      "The following devices have stopped responding:\n" +
      "  - *living-room-light*: Ping failed.\n" +
      "\nPlease check their power and network connection."; // <-- CORREGGI QUESTA RIGA

    const result = formatAlertMessage(unhealthyDevices);
    expect(result).toBe(expectedMessage);
  });

  it("should create a correctly formatted message for multiple devices", () => {
    const unhealthyDevices = [
      { name: "device-1", reason: "Never seen." },
      { name: "device-2", reason: "Unresponsive." },
    ];
    const expectedMessage =
      "‼️ *System Health Alert* ‼️\n\n" +
      "The following devices have stopped responding:\n" +
      "  - *device-1*: Never seen.\n" +
      "  - *device-2*: Unresponsive.\n" +
      "\nPlease check their power and network connection.";

    const result = formatAlertMessage(unhealthyDevices);
    expect(result).toBe(expectedMessage);
  });
});
