/**
 * @file Manages the state and lifecycle of two-phase commit network click transactions.
 * This class handles the creation, consumption, and expiration of pending clicks,
 * abstracting the timing logic away from the main orchestrator.
 */
import { ClickTransactionRegistry, Actor } from "./types";

export class ClickTransactionManager {
  /** A registry of all ongoing click transactions, keyed by a unique identifier. */
  private pendingClicks: ClickTransactionRegistry = {};
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
   * Starts a new click transaction, storing the associated actors.
   * @param transactionKey - A unique key for the transaction (e.g., 'deviceName.B1.lc').
   * @param actors - The primary actors to be controlled.
   * @param otherActors - The secondary actors to be controlled.
   */
  public startTransaction(
    transactionKey: string,
    actors: Actor[],
    otherActors: string[]
  ): void {
    this.pendingClicks[transactionKey] = {
      actors,
      otherActors,
      timestamp: Date.now(),
    };
  }

  /**
   * Confirms a transaction and retrieves its details for execution.
   * If the transaction exists, it is consumed (removed).
   * @param transactionKey - The unique key for the transaction.
   * @returns The transaction details if it was pending, otherwise `null`.
   */
  public consumeTransaction(
    transactionKey: string
  ): { actors: Actor[]; otherActors: string[] } | null {
    const transaction = this.pendingClicks[transactionKey];
    if (!transaction) {
      return null;
    }
    // The transaction is confirmed, remove it from the pending list.
    delete this.pendingClicks[transactionKey];
    return {
      actors: transaction.actors,
      otherActors: transaction.otherActors,
    };
  }

  /**
   * Periodically cleans up and removes expired click transactions.
   * @returns The number of transactions that were cleaned up.
   */
  public cleanupExpired(): number {
    const now = Date.now();
    let cleanedCount = 0;
    for (const key in this.pendingClicks) {
      if (now - this.pendingClicks[key].timestamp > this.clickTimeoutMs) {
        delete this.pendingClicks[key];
        cleanedCount++;
      }
    }
    return cleanedCount;
  }

  /**
   * Gets the current number of pending clicks. Useful for testing.
   * @returns The number of pending clicks.
   */
  public getPendingCount(): number {
    return Object.keys(this.pendingClicks).length;
  }
}
