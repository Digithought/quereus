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
  store?: KVStore;
  key: Uint8Array;
  value?: Uint8Array;
}

/** Hex-encode a key for use as a Map key. */
function keyToHex(key: Uint8Array): string {
  return Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * View of buffered ops targeting a specific store, with last-write-wins semantics.
 */
export interface PendingStoreOps {
  /** Pending puts (key/value) for this store, keyed by hex-encoded key. */
  puts: Map<string, { key: Uint8Array; value: Uint8Array }>;
  /** Hex-encoded keys with a pending delete for this store. */
  deletes: Set<string>;
}

/** Savepoint snapshot recording position in the operation/event arrays. */
interface SavepointSnapshot {
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
  private savepointStack: SavepointSnapshot[] = [];
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
    this.savepointStack = [];
  }

  /** Queue a put operation. If store is provided, targets that store instead of the default. */
  put(key: Uint8Array, value: Uint8Array, store?: KVStore): void {
    if (!this.inTransaction) {
      throw new QuereusError('Cannot queue operation outside transaction', StatusCode.MISUSE);
    }
    this.pendingOps.push({ type: 'put', store, key, value });
  }

  /** Queue a delete operation. If store is provided, targets that store instead of the default. */
  delete(key: Uint8Array, store?: KVStore): void {
    if (!this.inTransaction) {
      throw new QuereusError('Cannot queue operation outside transaction', StatusCode.MISUSE);
    }
    this.pendingOps.push({ type: 'delete', store, key });
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
      // Group pending operations by target store
      if (this.pendingOps.length > 0) {
        const opsByStore = new Map<KVStore, PendingOp[]>();
        for (const op of this.pendingOps) {
          const target = op.store ?? this.store;
          let ops = opsByStore.get(target);
          if (!ops) { ops = []; opsByStore.set(target, ops); }
          ops.push(op);
        }

        // Write a batch per store
        for (const [targetStore, ops] of opsByStore) {
          const batch = targetStore.batch();
          for (const op of ops) {
            if (op.type === 'put') {
              batch.put(op.key, op.value!);
            } else {
              batch.delete(op.key);
            }
          }
          await batch.write();
        }
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

  /** Create a savepoint at the given depth. */
  createSavepoint(_depth: number): void {
    if (!this.inTransaction) {
      // Start implicit transaction
      this.begin();
    }
    this.savepointStack.push({
      opIndex: this.pendingOps.length,
      eventIndex: this.pendingEvents.length,
    });
  }

  /** Release savepoints down to the target depth. */
  releaseSavepoint(targetDepth: number): void {
    this.savepointStack.length = targetDepth;
  }

  /** Rollback to a savepoint at the target depth (preserves the savepoint). */
  rollbackToSavepoint(targetDepth: number): void {
    if (targetDepth >= this.savepointStack.length) {
      throw new QuereusError(`Savepoint depth ${targetDepth} not found`, StatusCode.NOTFOUND);
    }

    const snapshot = this.savepointStack[targetDepth];

    // Truncate operations and events back to the snapshot
    this.pendingOps = this.pendingOps.slice(0, snapshot.opIndex);
    this.pendingEvents = this.pendingEvents.slice(0, snapshot.eventIndex);

    // Remove savepoints above the target, but preserve the target itself
    this.savepointStack.length = targetDepth + 1;
  }

  /** Clear all transaction state. */
  private clearTransaction(): void {
    this.inTransaction = false;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepointStack = [];
  }

  /** Get the underlying store for direct reads. */
  getStore(): KVStore {
    return this.store;
  }

  /**
   * Snapshot pending ops targeting the given store (or the default if omitted),
   * collapsed to last-write-wins. Used by reads that need to see
   * intra-transaction writes (e.g. UNIQUE constraint checks).
   */
  getPendingOpsForStore(store?: KVStore): PendingStoreOps {
    const target = store ?? this.store;
    const puts = new Map<string, { key: Uint8Array; value: Uint8Array }>();
    const deletes = new Set<string>();
    for (const op of this.pendingOps) {
      const opStore = op.store ?? this.store;
      if (opStore !== target) continue;
      const hex = keyToHex(op.key);
      if (op.type === 'put') {
        puts.set(hex, { key: op.key, value: op.value! });
        deletes.delete(hex);
      } else {
        deletes.add(hex);
        puts.delete(hex);
      }
    }
    return { puts, deletes };
  }
}

