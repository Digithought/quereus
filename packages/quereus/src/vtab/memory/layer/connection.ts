import type { Layer } from './interface.js';
import { TransactionLayer } from './transaction.js';
import type { MemoryTableManager } from './manager.js';
import { createLogger } from '../../../common/logger.js';
import { StatusCode, type Row } from '../../../common/types.js';
import { quereusError } from '../../../common/errors.js';

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

	/** Begins a transaction by marking explicitTransaction. The pending layer is created lazily on first mutation */
	begin(): void {
		if (this.pendingTransactionLayer) {
			// Already in transaction – same SQLite semantics: BEGIN is a no-op
			this.explicitTransaction = true; // upgrade auto txn to explicit
			return;
		}

		// Do NOT create a TransactionLayer yet.  It will be created lazily by
		// ensureTransactionLayer() on the first data-mutation, so its parent
		// will always be the then-current committed layer.
		this.explicitTransaction = true;

		debugLog(`Connection %d: BEGIN (lazy layer creation)`, this.connectionId);
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
		// Important: We need to ensure we're reading from a clean state
		this.readLayer = this.tableManager.currentCommittedLayer;

		// Simply discard the pending layer
		this.pendingTransactionLayer = null;
		this.clearTransactionState();

		debugLog(`Connection %d: Rolled back transaction, readLayer reset to ${this.readLayer.getLayerId()}`,
			this.connectionId);
	}

	/** Helper method to clear transaction-related state */
	private clearTransactionState(): void {
		this.savepoints.clear();
		this.explicitTransaction = false;
	}

	/** Creates a savepoint with the given identifier */
	createSavepoint(savepointIndex: number): void {
		if (savepointIndex < 0) {
			quereusError(`Invalid savepoint index: ${savepointIndex}. Must be non-negative.`, StatusCode.INTERNAL);
		}

		if (!this.pendingTransactionLayer) {
			// Start an implicit transaction and create a fresh layer immediately so the savepoint has something to snapshot
			this.pendingTransactionLayer = new TransactionLayer(this.tableManager.currentCommittedLayer);
			// Not marking explicitTransaction; this is still auto-txn unless caller ran BEGIN earlier.
		}

		if (!this.pendingTransactionLayer) {
			quereusError(`Failed to create transaction for savepoint ${savepointIndex}`);
		}

		// Create a snapshot of the current transaction state
		const savepointLayer = this.createTransactionSnapshot(this.pendingTransactionLayer);

		// Store the snapshot as the savepoint
		this.savepoints.set(savepointIndex, savepointLayer);

		// A SAVEPOINT implicitly puts the connection into explicit-transaction mode
		// so that subsequent statements do NOT auto-commit and invalidate the savepoint.
		this.explicitTransaction = true;
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

		// Copy change tracking state
		if (sourceLayer.isTrackingChanges()) {
			snapshotLayer.copyChangeTrackingFrom(sourceLayer);
		}

		// Copy all data from the source layer to the snapshot
		const primaryTree = sourceLayer.getModificationTree('primary');
		if (!primaryTree) {
			// Empty transaction layer - just return the empty snapshot
			snapshotLayer.markCommitted();
			return snapshotLayer;
		}

		const firstPath = primaryTree.first();
		if (!firstPath.on) {
			// No data in the tree - return the empty snapshot
			snapshotLayer.markCommitted();
			return snapshotLayer;
		}

		// Copy all rows from the source layer
		const { primaryKeyExtractorFromRow } = sourceLayer.getPkExtractorsAndComparators(sourceLayer.getSchema());
		for (const path of primaryTree.ascending(firstPath)) {
			const row = primaryTree.at(path)!;
			try {
				// Extract primary key and record the row in the snapshot
				const primaryKey = primaryKeyExtractorFromRow(row as Row);
				snapshotLayer.recordUpsert(primaryKey, row as Row, null);
			} catch (error) {
				warnLog(`Connection %d: Failed to copy row to savepoint snapshot: %o`, this.connectionId, error);
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
