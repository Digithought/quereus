/**
 * Transaction coordinator for virtual table modules.
 *
 * Manages a shared WriteBatch across all tables in a transaction,
 * providing multi-table atomicity.
 */

import { QuereusError, StatusCode } from '@quereus/quereus';
import type { DataChangeEvent, StoreEventEmitter } from './events.js';
import type { KVStore } from './kv-store.js';

/** Operation recorded in the transaction. */
interface PendingOp {
  type: 'put' | 'delete';
  key: Uint8Array;
  value?: Uint8Array;
}

/** Savepoint snapshot. */
interface Savepoint {
  opIndex: number;
  eventIndex: number;
}

/** Callback for transaction lifecycle events. */
export interface TransactionCallbacks {
  onCommit: () => void;
  onRollback: () => void;
}

/**
 * Coordinates transactions across multiple tables.
 *
 * All mutations within a transaction are buffered in a shared WriteBatch.
 * On commit, the batch is written atomically and events are fired.
 * On rollback, the batch and events are discarded.
 */
export class TransactionCoordinator {
  private store: KVStore;
  private eventEmitter?: StoreEventEmitter;

  // Transaction state
  private inTransaction = false;
  private pendingOps: PendingOp[] = [];
  private pendingEvents: DataChangeEvent[] = [];
  private savepoints: Map<number, Savepoint> = new Map();
  private callbacks: TransactionCallbacks[] = [];

  constructor(store: KVStore, eventEmitter?: StoreEventEmitter) {
    this.store = store;
    this.eventEmitter = eventEmitter;
  }

  /** Register callbacks for transaction lifecycle events. */
  registerCallbacks(callbacks: TransactionCallbacks): void {
    this.callbacks.push(callbacks);
  }

  /** Check if a transaction is active. */
  isInTransaction(): boolean {
    return this.inTransaction;
  }

  /** Begin a transaction. */
  begin(): void {
    if (this.inTransaction) {
      // Already in transaction - no-op (matches SQLite semantics)
      return;
    }
    this.inTransaction = true;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepoints.clear();
  }

  /** Queue a put operation. */
  put(key: Uint8Array, value: Uint8Array): void {
    if (!this.inTransaction) {
      throw new QuereusError('Cannot queue operation outside transaction', StatusCode.MISUSE);
    }
    this.pendingOps.push({ type: 'put', key, value });
  }

  /** Queue a delete operation. */
  delete(key: Uint8Array): void {
    if (!this.inTransaction) {
      throw new QuereusError('Cannot queue operation outside transaction', StatusCode.MISUSE);
    }
    this.pendingOps.push({ type: 'delete', key });
  }

  /** Queue a data change event (fired on commit). */
  queueEvent(event: DataChangeEvent): void {
    if (!this.inTransaction) {
      // If not in transaction, emit immediately
      this.eventEmitter?.emitDataChange(event);
      return;
    }
    this.pendingEvents.push(event);
  }

  /** Commit the transaction. */
  async commit(): Promise<void> {
    if (!this.inTransaction) {
      return;
    }

    try {
      // Write all pending operations atomically
      if (this.pendingOps.length > 0) {
        const batch = this.store.batch();
        for (const op of this.pendingOps) {
          if (op.type === 'put') {
            batch.put(op.key, op.value!);
          } else {
            batch.delete(op.key);
          }
        }
        await batch.write();
      }

      // Fire all pending events
      for (const event of this.pendingEvents) {
        this.eventEmitter?.emitDataChange(event);
      }

      // Notify callbacks
      for (const cb of this.callbacks) {
        cb.onCommit();
      }
    } finally {
      this.clearTransaction();
    }
  }

  /** Rollback the transaction. */
  rollback(): void {
    if (!this.inTransaction) {
      return;
    }

    // Notify callbacks
    for (const cb of this.callbacks) {
      cb.onRollback();
    }

    this.clearTransaction();
  }

  /** Create a savepoint. */
  createSavepoint(index: number): void {
    if (!this.inTransaction) {
      // Start implicit transaction
      this.begin();
    }
    this.savepoints.set(index, {
      opIndex: this.pendingOps.length,
      eventIndex: this.pendingEvents.length,
    });
  }

  /** Release a savepoint (no-op, just removes from map). */
  releaseSavepoint(index: number): void {
    this.savepoints.delete(index);
  }

  /** Rollback to a savepoint. */
  rollbackToSavepoint(index: number): void {
    const savepoint = this.savepoints.get(index);
    if (!savepoint) {
      throw new QuereusError(`Savepoint ${index} not found`, StatusCode.NOTFOUND);
    }

    // Truncate operations and events back to savepoint
    this.pendingOps = this.pendingOps.slice(0, savepoint.opIndex);
    this.pendingEvents = this.pendingEvents.slice(0, savepoint.eventIndex);

    // Remove this savepoint and any created after it
    for (const [idx] of this.savepoints) {
      if (idx >= index) {
        this.savepoints.delete(idx);
      }
    }
  }

  /** Clear all transaction state. */
  private clearTransaction(): void {
    this.inTransaction = false;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepoints.clear();
  }

  /** Get the underlying store for direct reads. */
  getStore(): KVStore {
    return this.store;
  }
}

