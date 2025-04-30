import type { Layer } from './interface.js';
import type { TransactionLayer } from './transaction.js';
import type { MemoryTableManager } from './manager.js'; // Assuming manager class name
import type { LayerCursorInternal } from './cursor.js';
import type { ScanPlan } from './scan-plan.js';
import { BaseLayerCursorInternal } from './base-cursor.js';
import { TransactionLayerCursorInternal } from './transaction-cursor.js';
import { createLogger } from '../../../common/logger.js'; // Import logger

let connectionCounter = 0;
const log = createLogger('vtab:memory:layer:connection'); // Create logger
const warnLog = log.extend('warn');
const debugLog = log; // Use base log for debug level

/**
 * Represents the state of a single connection to a MemoryTable
 * within the layer-based MVCC model.
 */
export class MemoryTableConnection {
	public readonly connectionId: number;
	public readonly tableManager: MemoryTableManager; // Reference back to the manager
	public readLayer: Layer; // The committed layer snapshot this connection reads from
	public pendingTransactionLayer: TransactionLayer | null = null; // Uncommitted changes for this connection
	private savepoints: Map<number, TransactionLayer> = new Map(); // Savepoint name -> Layer snapshot

	constructor(manager: MemoryTableManager, initialReadLayer: Layer) {
		this.connectionId = connectionCounter++;
		this.tableManager = manager;
		this.readLayer = initialReadLayer;
	}

	/**
	 * Creates the internal cursor chain for a given scan plan, starting from the
	 * appropriate layer (pending layer if active, otherwise the connection's read layer).
	 */
	createLayerCursor(plan: ScanPlan): LayerCursorInternal {
		const startLayer = this.pendingTransactionLayer ?? this.readLayer;
		return this._buildCursorRecursive(startLayer, plan);
	}

	/** Recursive helper to build the cursor chain */
	private _buildCursorRecursive(layer: Layer, plan: ScanPlan): LayerCursorInternal {
		const parentLayer = layer.getParent();

		if (!parentLayer) {
			// Reached the BaseLayer
			if (!(layer instanceof this.tableManager.getBaseLayerConstructor())) {
				throw new Error("Cursor creation error: Layer chain did not end with a valid BaseLayer.");
			}
			// Cast is safe due to check above and BaseLayer being the only layer type with null parent
			return new BaseLayerCursorInternal(layer as InstanceType<ReturnType<MemoryTableManager['getBaseLayerConstructor']>>, plan);
		} else {
			// Create parent cursor first
			const parentCursor = this._buildCursorRecursive(parentLayer, plan);

			// Create TransactionLayer cursor for the current layer
			if (!(layer instanceof this.tableManager.getTransactionLayerConstructor())) {
				// Clean up parent cursor if we fail here
				try { parentCursor.close(); } catch { /* ignore */ }
				throw new Error("Cursor creation error: Non-base layer was not a valid TransactionLayer.");
			}
			// Cast is safe due to the check above
			return new TransactionLayerCursorInternal(layer as TransactionLayer, plan, parentCursor);
		}
	}

	/** Begins a transaction by creating a new pending layer */
	begin(): void {
		if (this.pendingTransactionLayer) {
			// Nested transactions might require savepoint logic later,
			// but for now, starting a new transaction when one is pending is an error or no-op.
			// Let's treat it as a no-op for basic BEGIN.
			// Use namespaced warn logger
			warnLog(`Connection %d: BEGIN called while already in a transaction.`, this.connectionId);
			return;
		}
		// Create a new transaction layer on top of the current read layer
		this.pendingTransactionLayer = new (this.tableManager.getTransactionLayerConstructor())(this.readLayer);
	}

	/** Commits the current transaction */
	async commit(): Promise<void> {
		if (!this.pendingTransactionLayer) {
			// Commit without an active transaction is a no-op
			return;
		}
		await this.tableManager.commitTransaction(this);
		// commitTransaction handles updating connection state (readLayer, pendingTransactionLayer)
		this.savepoints.clear(); // Clear savepoints on commit
	}

	/** Rolls back the current transaction */
	rollback(): void {
		if (!this.pendingTransactionLayer) {
			// Rollback without an active transaction is a no-op
			return;
		}
		// Simply discard the pending layer
		this.pendingTransactionLayer = null;
		this.savepoints.clear(); // Clear savepoints on rollback
	}

	/** Creates a savepoint with the given identifier */
	createSavepoint(savepointIndex: number): void {
		if (!this.pendingTransactionLayer) {
			// SQLite treats SAVEPOINT outside a transaction as an implicit BEGIN + SAVEPOINT
			this.begin();
		}

		if (!this.pendingTransactionLayer) {
			throw new Error(`Failed to create transaction for savepoint ${savepointIndex}`);
		}

		// Store the current state of the pending transaction layer
		this.savepoints.set(savepointIndex, this.pendingTransactionLayer);
		// Use namespaced debug logger
		debugLog(`Connection %d: Created savepoint at index %d`, this.connectionId, savepointIndex);
	}

	/** Releases a savepoint and any higher-numbered savepoints */
	releaseSavepoint(savepointIndex: number): void {
		if (!this.pendingTransactionLayer) return; // No transaction, nothing to release

		// Remove this savepoint and any with higher indices
		for (const idx of Array.from(this.savepoints.keys())) {
			if (idx >= savepointIndex) {
				this.savepoints.delete(idx);
			}
		}
		// Use namespaced debug logger
		debugLog(`Connection %d: Released savepoint %d`, this.connectionId, savepointIndex);
	}

	/** Rolls back to a savepoint while preserving the transaction */
	rollbackToSavepoint(savepointIndex: number): void {
		if (!this.pendingTransactionLayer) return; // No transaction, nothing to rollback to

		const savepoint = this.savepoints.get(savepointIndex);
		if (!savepoint) {
			// Use namespaced warn logger
			warnLog(`Connection %d: Savepoint %d not found for rollback.`, this.connectionId, savepointIndex);
			return;
		}

		// Restore the pending layer to the savepoint state
		// This is a simplified approach - in a real implementation we'd need to clone the layer
		// or maintain a more sophisticated layer history
		this.pendingTransactionLayer = savepoint;

		// Remove this savepoint and any with higher indices
		for (const idx of Array.from(this.savepoints.keys())) {
			if (idx >= savepointIndex) {
				this.savepoints.delete(idx);
			}
		}

		// Use namespaced debug logger
		debugLog(`Connection %d: Rolled back to savepoint %d`, this.connectionId, savepointIndex);
	}
}
