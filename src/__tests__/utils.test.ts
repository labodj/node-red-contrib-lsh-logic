/**
 * @file Unit tests for the utility functions.
 */
import type { Actor } from "../types";
import { formatAlertMessage, areSameArray, normalizeActors } from "../utils";

describe("formatAlertMessage", () => {
  it("should format the base alert templates for unhealthy and healthy devices", () => {
    const cases = [
      {
        devices: [{ name: "living-room-light", reason: "Ping failed." }],
        status: "unhealthy" as const,
        expectedMessage:
          "‼️ *System Health Alert* ‼️\n\n" +
          "The following event occurred:\n" +
          "  - *living-room-light*: Ping failed.\n" +
          "\nPlease check power and network connections where applicable.",
      },
      {
        devices: [{ name: "living-room-light", reason: "Device is now connected." }],
        status: "healthy" as const,
        expectedMessage:
          "✅ *System Health Recovery* ✅\n\n" +
          "The following devices are now back online:\n" +
          "  - *living-room-light*: Device is now connected.\n",
      },
    ];

    for (const { devices, status, expectedMessage } of cases) {
      expect(formatAlertMessage(devices, status)).toBe(expectedMessage);
    }
  });

  it("should render structured, primitive and Error details", () => {
    const unhealthyDevices = [{ name: "device-1", reason: "Action failed" }];
    const detailsCases = [
      {
        details: { p: "c_nc", bi: "B1" },
        expectedSubstring: '"p": "c_nc"',
      },
      {
        details: "A simple string detail",
        expectedSubstring: "A simple string detail",
      },
      {
        details: Object.assign(new Error("boom"), { stack: "custom-stack" }),
        expectedSubstring: "custom-stack",
      },
      {
        details: (() => {
          const error = new Error("boom");
          error.stack = undefined;
          return error;
        })(),
        expectedSubstring: "boom",
      },
    ];

    for (const { details, expectedSubstring } of detailsCases) {
      const result = formatAlertMessage(unhealthyDevices, "unhealthy", details);
      expect(result).toContain("*Details:*");
      expect(result).toContain(expectedSubstring);
    }
  });
});

describe("areSameArray", () => {
  it("should compare primitive arrays by value, length and order", () => {
    expect(areSameArray([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(areSameArray(["a", "b"], ["a", "b"])).toBe(true);
    expect(areSameArray([true, false], [true, false])).toBe(true);
    expect(areSameArray([1, 2, 3], [1, 2])).toBe(false);
    expect(areSameArray([1, 2, 3], [3, 2, 1])).toBe(false);
  });
});

describe("normalizeActors", () => {
  it("merges duplicate subsets targeting the same device", () => {
    const actors: Actor[] = [
      { name: "actor-1", allActuators: false, actuators: [1, 2] },
      { name: "actor-1", allActuators: false, actuators: [2, 3] },
      { name: "actor-2", allActuators: false, actuators: [7] },
    ];

    expect(normalizeActors(actors)).toEqual([
      { name: "actor-1", allActuators: false, actuators: [1, 2, 3] },
      { name: "actor-2", allActuators: false, actuators: [7] },
    ]);
  });

  it("lets allActuators dominate any partial subsets for the same device", () => {
    const actors: Actor[] = [
      { name: "actor-1", allActuators: false, actuators: [2] },
      { name: "actor-1", allActuators: true, actuators: [] },
      { name: "actor-1", allActuators: false, actuators: [3] },
    ];

    expect(normalizeActors(actors)).toEqual([
      { name: "actor-1", allActuators: true, actuators: [] },
    ]);
  });
});
