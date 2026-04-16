import type { PendingClickTransaction, Actor } from "./types";

export class ClickTransactionManager {
  /** A registry of all ongoing click transactions, keyed by a unique identifier. */
  private pendingClicks: Map<string, PendingClickTransaction> = new Map();
  /** Tracks the active correlation key for each logical click slot (device + button + type). */
  private activeSlots: Map<string, string> = new Map();
  /** The configured timeout for click transactions, in milliseconds. */
  private readonly clickTimeoutMs: number;

  /**
   * Constructs a new ClickTransactionManager.
   * @param clickTimeoutSec - The time in seconds before a pending click expires.
   */
  constructor(clickTimeoutSec: number) {
    this.clickTimeoutMs = clickTimeoutSec * 1000;
  }

  /**
   * Removes a transaction from every internal registry, regardless of whether it
   * completed successfully or expired.
   */
  private discardTransaction(correlationKey: string, transaction: PendingClickTransaction): void {
    this.pendingClicks.delete(correlationKey);
    if (this.activeSlots.get(transaction.slotKey) === correlationKey) {
      this.activeSlots.delete(transaction.slotKey);
    }
  }

  /**
   * Starts a new click transaction, storing the associated actors and a timestamp.
   * This is the first phase of the two-phase commit protocol.
   * @param slotKey - A stable key for the logical click slot (e.g., 'deviceName.7.1').
   * @param correlationKey - The unique correlation key for this specific click attempt.
   * @param actors - The primary LSH actors to be controlled.
   * @param otherActors - The secondary external actors to be controlled.
   */
  public startTransaction(
    slotKey: string,
    correlationKey: string,
    actors: Actor[],
    otherActors: string[],
  ): void {
    const previousCorrelationKey = this.activeSlots.get(slotKey);
    if (previousCorrelationKey) {
      this.pendingClicks.delete(previousCorrelationKey);
    }

    this.activeSlots.set(slotKey, correlationKey);
    this.pendingClicks.set(correlationKey, {
      slotKey,
      actors,
      otherActors,
      timestamp: Date.now(),
    });
  }

  /**
   * Confirms and consumes a transaction, retrieving its details for execution.
   * If the transaction exists, it is removed from the pending registry to prevent re-execution.
   * This is the second phase of the two-phase commit protocol.
   * @param correlationKey - The unique correlation key for the transaction to consume.
   * @returns The transaction details if it was pending, otherwise `null`.
   */
  public consumeTransaction(
    correlationKey: string,
  ): { actors: Actor[]; otherActors: string[] } | null {
    const transaction = this.pendingClicks.get(correlationKey);
    if (!transaction) {
      return null;
    }

    // Treat timeout as a hard semantic boundary. A late CONFIRM must never
    // execute just because the periodic cleanup sweep has not run yet.
    if (Date.now() - transaction.timestamp > this.clickTimeoutMs) {
      this.discardTransaction(correlationKey, transaction);
      return null;
    }

    // The transaction is confirmed, so remove it from the pending list.
    this.discardTransaction(correlationKey, transaction);
    return {
      actors: transaction.actors,
      otherActors: transaction.otherActors,
    };
  }

  /**
   * Periodically cleans up and removes expired click transactions.
   * This prevents memory leaks from unconfirmed clicks (e.g., if a device
   * loses power after sending the initial request).
   * @returns The number of transactions that were cleaned up.
   */
  public cleanupExpired(): number {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [correlationKey, transaction] of this.pendingClicks) {
      if (now - transaction.timestamp > this.clickTimeoutMs) {
        this.discardTransaction(correlationKey, transaction);
        cleanedCount++;
      }
    }
    return cleanedCount;
  }

  /**
   * Clears every pending click transaction.
   * This is used when a config reload invalidates the assumptions under which
   * the pending transactions were validated.
   * @returns The number of transactions that were discarded.
   */
  public clearAll(): number {
    const clearedCount = this.pendingClicks.size;
    this.pendingClicks.clear();
    this.activeSlots.clear();
    return clearedCount;
  }

  /**
   * Gets the current number of pending clicks. Useful for testing and monitoring.
   * @returns The number of pending clicks.
   */
  public getPendingCount(): number {
    return this.pendingClicks.size;
  }
}
