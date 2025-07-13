/**
 * @file Unit tests for the utility functions.
 */
import { sleep, formatAlertMessage, areSameArray } from "../utils";

describe("sleep", () => {
  it("sleep should resolve after the specified time", async () => {
    jest.useFakeTimers();
    const sleepPromise = sleep(1000);
    jest.advanceTimersByTime(1000);
    await expect(sleepPromise).resolves.toBeUndefined();
    jest.useRealTimers();
  });
});

describe("formatAlertMessage", () => {
  it("should create a correctly formatted message for an unhealthy device", () => {
    const unhealthyDevices = [
      { name: "living-room-light", reason: "Ping failed." },
    ];
    const expectedMessage =
      "‼️ *System Health Alert* ‼️\n\n" +
      "The following event occurred:\n" +
      "  - *living-room-light*: Ping failed.\n" +
      "\nPlease check power and network connections where applicable.";

    const result = formatAlertMessage(unhealthyDevices, "unhealthy");
    expect(result).toBe(expectedMessage);
  });

  it("should create a correctly formatted message for a healthy device", () => {
    const healthyDevices = [
      { name: "living-room-light", reason: "Device is now connected." },
    ];
    const expectedMessage =
      "✅ *System Health Recovery* ✅\n\n" +
      "The following devices are now back online:\n" +
      "  - *living-room-light*: Device is now connected.\n";

    const result = formatAlertMessage(healthyDevices, "healthy");
    expect(result).toBe(expectedMessage);
  });

  it("should include details when provided", () => {
    const unhealthyDevices = [{ name: "device-1", reason: "Action failed" }];
    const details = { p: "c_nc", bi: "B1" };
    const result = formatAlertMessage(unhealthyDevices, "unhealthy", details);
    expect(result).toContain("*Details:*");
    expect(result).toContain('"p": "c_nc"');
  });

  describe("areSameArray", () => {
    it("should return true for two identical arrays of primitives", () => {
      expect(areSameArray([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(areSameArray(["a", "b"], ["a", "b"])).toBe(true);
      expect(areSameArray([true, false], [true, false])).toBe(true);
    });

    it("should return false for arrays with different lengths", () => {
      expect(areSameArray([1, 2, 3], [1, 2])).toBe(false);
    });

    it("should return false for arrays with different values", () => {
      expect(areSameArray([1, 2, 3], [1, 5, 3])).toBe(false);
    });

    it("should return false for arrays with same values in different order", () => {
      expect(areSameArray([1, 2, 3], [3, 2, 1])).toBe(false);
    });

    it("should return true for two empty arrays", () => {
      expect(areSameArray([], [])).toBe(true);
    });

    it("should return false for arrays of different types", () => {
      // @ts-expect-error - Intentionally testing different types to ensure strict equality.
      expect(areSameArray([1, 2, 3], ["1", "2", "3"])).toBe(false);
    });
  });
});
