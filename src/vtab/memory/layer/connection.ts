import type { Layer } from './interface.js';
import { TransactionLayer } from './transaction.js'; // Changed to value import
import type { MemoryTableManager } from './manager.js';
import { createLogger } from '../../../common/logger.js';
import type { Row } from '../../../common/types.js';

let connectionCounter = 0;
const log = createLogger('vtab:memory:layer:connection');
const warnLog = log.extend('warn');
const debugLog = log;

/**
 * Represents the state of a single connection to a MemoryTable
 * within the layer-based MVCC model.
 */
export class MemoryTableConnection {
	public readonly connectionId: number;
	public readonly tableManager: MemoryTableManager;
	public readLayer: Layer;
	public pendingTransactionLayer: TransactionLayer | null = null;
	public explicitTransaction: boolean = false; // Track if transaction was explicitly started
	private savepoints: Map<number, TransactionLayer> = new Map();

	constructor(manager: MemoryTableManager, initialReadLayer: Layer) {
		this.connectionId = connectionCounter++;
		this.tableManager = manager;
		this.readLayer = initialReadLayer;
	}

	/** Begins a transaction by creating a new pending layer */
	begin(): void {
		if (this.pendingTransactionLayer) {
			// If there's already a pending transaction, commit it first if it's not explicit
			if (!this.explicitTransaction) {
				// This is likely an auto-created transaction from mutations, commit it silently
				// Note: We can't call commit() here as it's async, so we'll just discard it
				// This is safe because auto-created transactions should be immediately committed anyway
				this.pendingTransactionLayer = null;
				this.savepoints.clear();
			} else {
				// Nested explicit transactions - treat as no-op for now
				warnLog(`Connection %d: BEGIN called while already in a transaction.`, this.connectionId);
				return;
			}
		}

		// Create TransactionLayer based on the manager's current committed layer
		// This ensures the parent check in commitTransaction will pass
		this.pendingTransactionLayer = new TransactionLayer(this.tableManager.currentCommittedLayer);
		this.explicitTransaction = true; // Mark as explicitly started
	}

	/** Commits the current transaction */
	async commit(): Promise<void> {
		if (!this.pendingTransactionLayer) {
			// Commit without an active transaction is a no-op
			return;
		}

		await this.tableManager.commitTransaction(this);
		// commitTransaction handles updating connection state (readLayer, pendingTransactionLayer)
		this.clearTransactionState();
	}

	/** Rolls back the current transaction */
	rollback(): void {
		if (!this.pendingTransactionLayer) {
			// Rollback without an active transaction is a no-op
			return;
		}

		// Reset readLayer to the current committed layer
		this.readLayer = this.tableManager.currentCommittedLayer;

		// Simply discard the pending layer
		this.pendingTransactionLayer = null;
		this.clearTransactionState();
	}

	/** Helper method to clear transaction-related state */
	private clearTransactionState(): void {
		this.savepoints.clear();
		this.explicitTransaction = false;
	}

	/** Creates a savepoint with the given identifier */
	createSavepoint(savepointIndex: number): void {
		if (savepointIndex < 0) {
			throw new Error(`Invalid savepoint index: ${savepointIndex}. Must be non-negative.`);
		}

		if (!this.pendingTransactionLayer) {
			// Quereus treats SAVEPOINT outside a transaction as an implicit BEGIN + SAVEPOINT
			this.begin();
		}

		if (!this.pendingTransactionLayer) {
			throw new Error(`Failed to create transaction for savepoint ${savepointIndex}`);
		}

		// Create a snapshot of the current transaction state
		const savepointLayer = this.createTransactionSnapshot(this.pendingTransactionLayer);

		// Store the snapshot as the savepoint
		this.savepoints.set(savepointIndex, savepointLayer);

		// Continue using the current layer for future operations
		// Future changes will only affect this layer, not the snapshot
	}

	/**
	 * Creates a snapshot of a transaction layer by copying its effective data to a new independent layer.
	 * This is necessary because BTree inheritance can cause shared mutable state issues.
	 * The snapshot becomes immutable and independent of the source layer.
	 */
	private createTransactionSnapshot(sourceLayer: TransactionLayer): TransactionLayer {
		// Create a new transaction layer based on the source layer's parent
		// This ensures the snapshot is independent of the source layer
		const snapshotLayer = new TransactionLayer(sourceLayer.getParent());

		// Copy all data from the source layer to the snapshot
		const primaryTree = sourceLayer.getModificationTree('primary');
		if (!primaryTree) {
			// Empty transaction layer - just return the empty snapshot
			snapshotLayer.markCommitted();
			return snapshotLayer;
		}

		const firstPath = primaryTree.first();
		if (!firstPath) {
			// No data in the tree - return the empty snapshot
			snapshotLayer.markCommitted();
			return snapshotLayer;
		}

		// Copy all rows from the source layer
		const { primaryKeyExtractorFromRow } = sourceLayer.getPkExtractorsAndComparators(sourceLayer.getSchema());
		const iterator = primaryTree.ascending(firstPath);

		for (const path of iterator) {
			const row = primaryTree.at(path);
			if (row) {
				try {
					// Extract primary key and record the row in the snapshot
					const primaryKey = primaryKeyExtractorFromRow(row as Row);
					snapshotLayer.recordUpsert(primaryKey, row as Row, null);
				} catch (error) {
					warnLog(`Connection %d: Failed to copy row to savepoint snapshot: %o`, this.connectionId, error);
				}
			}
		}

		// Mark the snapshot as committed to make it immutable
		snapshotLayer.markCommitted();

		return snapshotLayer;
	}

	/** Releases a savepoint and any higher-numbered savepoints */
	releaseSavepoint(savepointIndex: number): void {
		if (!this.pendingTransactionLayer) return; // No transaction, nothing to release

		if (savepointIndex < 0) {
			warnLog(`Connection %d: Invalid savepoint index %d for release.`, this.connectionId, savepointIndex);
			return;
		}

		// Remove this savepoint and any with higher indices
		for (const idx of Array.from(this.savepoints.keys())) {
			if (idx >= savepointIndex) {
				this.savepoints.delete(idx);
			}
		}
		debugLog(`Connection %d: Released savepoint %d`, this.connectionId, savepointIndex);
	}

	/** Rolls back to a savepoint while preserving the transaction */
	rollbackToSavepoint(savepointIndex: number): void {
		if (!this.pendingTransactionLayer) return; // No transaction, nothing to rollback to

		if (savepointIndex < 0) {
			warnLog(`Connection %d: Invalid savepoint index %d for rollback.`, this.connectionId, savepointIndex);
			return;
		}

		const savepoint = this.savepoints.get(savepointIndex);
		if (!savepoint) {
			warnLog(`Connection %d: Savepoint %d not found for rollback.`, this.connectionId, savepointIndex);
			return;
		}

		// Restore the transaction layer to the savepoint state
		// Instead of creating a new layer, we directly set the pending layer to the savepoint
		this.pendingTransactionLayer = savepoint;

		// Remove this savepoint and any with higher indices
		for (const idx of Array.from(this.savepoints.keys())) {
			if (idx >= savepointIndex) {
				this.savepoints.delete(idx);
			}
		}
	}

	public clearSavepoints(): void {
		this.savepoints.clear();
	}
}
