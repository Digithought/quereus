/**
 * Generic VirtualTableConnection implementation for KVStore-backed tables.
 *
 * Delegates transaction operations to a shared TransactionCoordinator.
 */

import type { VirtualTableConnection } from '@quereus/quereus';
import type { TransactionCoordinator } from './transaction.js';

let connectionCounter = 0;

/**
 * Connection to a KVStore-backed table.
 * All connections share a TransactionCoordinator for multi-table atomicity.
 */
export class StoreConnection implements VirtualTableConnection {
  public readonly connectionId: string;
  public readonly tableName: string;
  private coordinator: TransactionCoordinator;

  constructor(tableName: string, coordinator: TransactionCoordinator) {
    this.connectionId = `store-${tableName}-${++connectionCounter}`;
    this.tableName = tableName;
    this.coordinator = coordinator;
  }

  /** Begin a transaction. */
  begin(): void {
    this.coordinator.begin();
  }

  /** Commit the transaction. */
  async commit(): Promise<void> {
    await this.coordinator.commit();
  }

  /** Rollback the transaction. */
  rollback(): void {
    this.coordinator.rollback();
  }

  /** Create a savepoint. */
  createSavepoint(index: number): void {
    this.coordinator.createSavepoint(index);
  }

  /** Release a savepoint. */
  releaseSavepoint(index: number): void {
    this.coordinator.releaseSavepoint(index);
  }

  /** Rollback to a savepoint. */
  rollbackToSavepoint(index: number): void {
    this.coordinator.rollbackToSavepoint(index);
  }

  /** Disconnect (rolls back if in transaction). */
  async disconnect(): Promise<void> {
    if (this.coordinator.isInTransaction()) {
      this.coordinator.rollback();
    }
  }

  /** Get the coordinator for mutation operations. */
  getCoordinator(): TransactionCoordinator {
    return this.coordinator;
  }
}

