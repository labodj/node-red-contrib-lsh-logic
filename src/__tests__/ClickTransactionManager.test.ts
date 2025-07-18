/**
 * @file Unit tests for the ClickTransactionManager class.
 * These tests verify the core logic of the two-phase commit protocol for network clicks.
 */
import { ClickTransactionManager } from "../ClickTransactionManager";
import { Actor } from "../types";

describe("ClickTransactionManager", () => {
  /** The instance of the ClickTransactionManager class under test. */
  let manager: ClickTransactionManager;
  /** Test constant for the click timeout in seconds. */
  const CLICK_TIMEOUT_SEC = 10;

  beforeEach(() => {
    manager = new ClickTransactionManager(CLICK_TIMEOUT_SEC);
    // Use fake timers to control time-based logic like timeouts without waiting.
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Restore real timers after each test to avoid side effects.
    jest.useRealTimers();
  });

  it("should start a transaction correctly", () => {
    expect(manager.getPendingCount()).toBe(0);
    manager.startTransaction("key1", [], []);
    expect(manager.getPendingCount()).toBe(1);
  });

  it("should consume a pending transaction and return its details", () => {
    const actors: Actor[] = [
      { name: "actor1", allActuators: true, actuators: [] },
    ];
    manager.startTransaction("key1", actors, ["other1"]);

    const consumed = manager.consumeTransaction("key1");

    expect(consumed).not.toBeNull();
    expect(consumed?.actors).toEqual(actors);
    expect(consumed?.otherActors).toEqual(["other1"]);
    // The transaction should be removed from the pending list after consumption.
    expect(manager.getPendingCount()).toBe(0);
  });

  it("should return null when consuming a non-existent transaction", () => {
    const consumed = manager.consumeTransaction("non-existent-key");
    expect(consumed).toBeNull();
  });

  it("should not clean up a recent transaction", () => {
    manager.startTransaction("key1", [], []);

    // Advance time by less than the timeout period.
    jest.advanceTimersByTime((CLICK_TIMEOUT_SEC - 1) * 1000);

    const cleanedCount = manager.cleanupExpired();
    expect(cleanedCount).toBe(0);
    expect(manager.getPendingCount()).toBe(1);
  });

  it("should clean up an expired transaction", () => {
    manager.startTransaction("key1", [], []);

    // Advance time by more than the timeout period.
    jest.advanceTimersByTime((CLICK_TIMEOUT_SEC + 1) * 1000);

    const cleanedCount = manager.cleanupExpired();
    expect(cleanedCount).toBe(1);
    expect(manager.getPendingCount()).toBe(0);
  });
});
