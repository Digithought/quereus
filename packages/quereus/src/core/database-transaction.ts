/**
 * Transaction management for the Database.
 *
 * This module handles transaction lifecycle including:
 * - Explicit transactions (BEGIN/COMMIT/ROLLBACK)
 * - Implicit transactions (autocommit mode)
 * - Savepoint management
 * - Change log tracking for assertion evaluation
 * - Coordinating commits across virtual table connections
 */

import { createLogger } from '../common/logger.js';
import type { SqlValue } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import type { DatabaseEventEmitter } from './database-events.js';
import type { DeferredConstraintQueue } from '../runtime/deferred-constraint-queue.js';

const log = createLogger('core:transaction');
const debugLog = log.extend('debug');
const errorLog = log.extend('error');

/**
 * Source of a transaction - explicit (SQL BEGIN) or implicit (autocommit).
 */
export type TransactionSource = 'explicit' | 'implicit';

/**
 * Interface for Database features needed by the TransactionManager.
 * This decouples the manager from the full Database class.
 */
export interface TransactionManagerContext {
	/** Get all active virtual table connections */
	getAllConnections(): VirtualTableConnection[];
	/** Get the database event emitter */
	getEventEmitter(): DatabaseEventEmitter;
	/** Get the deferred constraint queue */
	getDeferredConstraints(): DeferredConstraintQueue;
	/** Run global assertions before commit */
	runGlobalAssertions(): Promise<void>;
	/** Run deferred row constraints before commit */
	runDeferredRowConstraints(): Promise<void>;
}

/**
 * Manages transaction state and lifecycle for a Database instance.
 *
 * Handles both explicit transactions (BEGIN/COMMIT/ROLLBACK) and implicit
 * transactions (autocommit). Coordinates transaction operations across all
 * active virtual table connections.
 */
export class TransactionManager {
	private isAutocommit = true;
	private inTransaction = false;
	private transactionSource: TransactionSource | null = null;

	/** Per-transaction change tracking: base table name → serialized PK tuples */
	private changeLog: Map<string, Set<string>> = new Map();
	/** Savepoint layers for change tracking */
	private changeLogLayers: Array<Map<string, Set<string>>> = [];

	/** Flag to prevent new connections from starting transactions during constraint evaluation */
	private evaluatingDeferredConstraints = false;
	/** Flag indicating we're in a coordinated multi-connection commit */
	private inCoordinatedCommit = false;

	constructor(private readonly ctx: TransactionManagerContext) {}

	// ============================================================================
	// Transaction State Queries
	// ============================================================================

	/** Whether the database is in autocommit mode */
	getAutocommit(): boolean {
		return this.isAutocommit;
	}

	/** Whether a transaction is currently active */
	isInTransaction(): boolean {
		return this.inTransaction;
	}

	/** Get the source of the current transaction, or null if not in a transaction */
	getTransactionSource(): TransactionSource | null {
		return this.transactionSource;
	}

	/** Check if we're in an implicit transaction */
	isImplicitTransaction(): boolean {
		return this.transactionSource === 'implicit';
	}

	/** Check if we should skip auto-beginning transactions on newly registered connections */
	isEvaluatingDeferredConstraints(): boolean {
		return this.evaluatingDeferredConstraints;
	}

	/** Check if we're in a coordinated commit (allows sibling layer validation) */
	isInCoordinatedCommit(): boolean {
		return this.inCoordinatedCommit;
	}

	// ============================================================================
	// Transaction Control
	// ============================================================================

	/**
	 * Begins a transaction on all active connections.
	 * Called by both explicit BEGIN and implicit transaction start.
	 */
	async beginTransaction(source: TransactionSource): Promise<void> {
		if (this.inTransaction) {
			if (source === 'explicit') {
				if (this.transactionSource === 'implicit') {
					// Upgrade implicit to explicit
					debugLog('Upgrading implicit transaction to explicit (BEGIN encountered).');
					this.transactionSource = 'explicit';
					this.clearChangeLog();
					return;
				}
				throw new QuereusError('Cannot begin transaction: already in a transaction', StatusCode.ERROR);
			}
			// Implicit while already in a transaction - no-op
			return;
		}

		debugLog(`Beginning ${source} transaction.`);

		// Start batching events for this transaction
		this.ctx.getEventEmitter().startBatch();

		// Begin transaction on all active connections
		const connections = this.ctx.getAllConnections();
		for (const connection of connections) {
			try {
				await connection.begin();
			} catch (error) {
				errorLog(`Error beginning transaction on connection ${connection.connectionId}: %O`, error);
				throw error;
			}
		}

		this.inTransaction = true;
		this.isAutocommit = false;
		this.transactionSource = source;

		if (source === 'explicit') {
			this.clearChangeLog();
		}
	}

	/**
	 * Commits the current transaction on all connections.
	 * Runs deferred constraints and assertions before committing.
	 */
	async commitTransaction(): Promise<void> {
		if (!this.inTransaction) {
			debugLog('No transaction to commit (already in autocommit mode).');
			return;
		}

		debugLog(`Committing ${this.transactionSource} transaction.`);

		// Snapshot connections before evaluating deferred constraints
		const connectionsToCommit = this.ctx.getAllConnections();

		let commitSucceeded = false;
		try {
			// Evaluate global assertions and deferred row constraints BEFORE committing
			await this.ctx.runGlobalAssertions();
			await this.ctx.runDeferredRowConstraints();

			// Mark coordinated commit to relax layer validation for sibling layers
			this.inCoordinatedCommit = true;
			try {
				// Commit sequentially to avoid race conditions with layer promotion
				for (const connection of connectionsToCommit) {
					try {
						await connection.commit();
					} catch (error) {
						errorLog(`Error committing transaction on connection ${connection.connectionId}: %O`, error);
						throw error;
					}
				}
				commitSucceeded = true;
			} finally {
				this.inCoordinatedCommit = false;
			}
		} catch (e) {
			// On pre-commit assertion failure (or commit error), rollback all connections
			const conns = this.ctx.getAllConnections();
			await Promise.allSettled(conns.map(c => c.rollback()));
			throw e;
		} finally {
			this.inTransaction = false;
			this.isAutocommit = true;
			this.transactionSource = null;
			this.clearChangeLog();

			// Flush or discard batched events based on commit success
			if (commitSucceeded) {
				this.ctx.getEventEmitter().flushBatch();
			} else {
				this.ctx.getEventEmitter().discardBatch();
			}
		}
	}

	/**
	 * Rolls back the current transaction on all connections.
	 */
	async rollbackTransaction(): Promise<void> {
		if (!this.inTransaction) {
			debugLog('No transaction to rollback (already in autocommit mode).');
			return;
		}

		debugLog(`Rolling back ${this.transactionSource} transaction.`);

		// Rollback all active connections
		const connections = this.ctx.getAllConnections();
		const rollbackPromises = connections.map(async (connection) => {
			try {
				await connection.rollback();
			} catch (error) {
				errorLog(`Error rolling back transaction on connection ${connection.connectionId}: %O`, error);
			}
		});

		await Promise.allSettled(rollbackPromises);

		// Discard batched events on rollback
		this.ctx.getEventEmitter().discardBatch();

		this.inTransaction = false;
		this.isAutocommit = true;
		this.transactionSource = null;
		this.clearChangeLog();
	}

	/**
	 * Ensures we're in a transaction. If in autocommit mode, starts an implicit transaction.
	 */
	async ensureTransaction(): Promise<void> {
		if (!this.inTransaction && this.isAutocommit) {
			await this.beginTransaction('implicit');
		}
	}

	/**
	 * Commits if we're in an implicit transaction.
	 */
	async autocommitIfNeeded(): Promise<void> {
		if (this.transactionSource === 'implicit') {
			await this.commitTransaction();
		}
	}

	/**
	 * Rolls back if we're in an implicit transaction (on error).
	 */
	async autorollbackIfNeeded(): Promise<void> {
		if (this.transactionSource === 'implicit') {
			await this.rollbackTransaction();
		}
	}

	/**
	 * Upgrades an implicit transaction to explicit.
	 * Used when SAVEPOINT is encountered.
	 */
	upgradeToExplicitTransaction(): void {
		if (this.transactionSource === 'implicit') {
			debugLog('Upgrading implicit transaction to explicit (savepoint encountered).');
			this.transactionSource = 'explicit';
		}
	}

	// ============================================================================
	// Deferred Constraint Evaluation
	// ============================================================================

	/**
	 * Run deferred row constraints with proper flag management.
	 */
	async runDeferredRowConstraints(): Promise<void> {
		this.evaluatingDeferredConstraints = true;
		try {
			await this.ctx.getDeferredConstraints().runDeferredRows();
		} finally {
			this.evaluatingDeferredConstraints = false;
		}
	}

	// ============================================================================
	// Change Log Management
	// ============================================================================

	/** Serialize a composite primary key tuple for set storage */
	private serializeKeyTuple(values: SqlValue[]): string {
		return JSON.stringify(values);
	}

	/** Add a key tuple to the current change log for a base table */
	private addChange(baseTable: string, keyTuple: SqlValue[]): void {
		const target = this.changeLogLayers.length > 0
			? this.changeLogLayers[this.changeLogLayers.length - 1]
			: this.changeLog;
		const key = baseTable.toLowerCase();
		if (!target.has(key)) target.set(key, new Set());
		target.get(key)!.add(this.serializeKeyTuple(keyTuple));
	}

	/** Record an INSERT operation */
	recordInsert(baseTable: string, newKey: SqlValue[]): void {
		this.addChange(baseTable, newKey);
	}

	/** Record a DELETE operation */
	recordDelete(baseTable: string, oldKey: SqlValue[]): void {
		this.addChange(baseTable, oldKey);
	}

	/** Record an UPDATE operation */
	recordUpdate(baseTable: string, oldKey: SqlValue[], newKey: SqlValue[]): void {
		this.addChange(baseTable, oldKey);
		// If the PK changed, also record the new key
		if (this.serializeKeyTuple(oldKey) !== this.serializeKeyTuple(newKey)) {
			this.addChange(baseTable, newKey);
		}
	}

	/** Get the set of changed base tables */
	getChangedBaseTables(): Set<string> {
		const result = new Set<string>();
		const collect = (m: Map<string, Set<string>>) => {
			for (const [t, s] of m) {
				if (s.size > 0) result.add(t);
			}
		};
		collect(this.changeLog);
		for (const layer of this.changeLogLayers) collect(layer);
		return result;
	}

	/** Gather all changed PK tuples for a base table across layers */
	getChangedKeyTuples(base: string): SqlValue[][] {
		const lower = base.toLowerCase();
		const tuples: SqlValue[][] = [];
		const collect = (m: Map<string, Set<string>>): void => {
			const set = m.get(lower);
			if (!set) return;
			for (const s of set) tuples.push(JSON.parse(s) as SqlValue[]);
		};
		collect(this.changeLog);
		for (const layer of this.changeLogLayers) collect(layer);
		return tuples;
	}

	/** Clear all change tracking */
	clearChangeLog(): void {
		this.changeLog.clear();
		this.changeLogLayers = [];
		this.ctx.getDeferredConstraints().clear();
	}

	// ============================================================================
	// Savepoint Layer Management
	// ============================================================================

	/** Begin a new savepoint layer */
	beginSavepointLayer(): void {
		this.changeLogLayers.push(new Map());
		this.ctx.getDeferredConstraints().beginLayer();
		this.ctx.getEventEmitter().beginSavepointLayer();
	}

	/** Rollback the current savepoint layer */
	rollbackSavepointLayer(): void {
		this.changeLogLayers.pop();
		this.ctx.getDeferredConstraints().rollbackLayer();
		this.ctx.getEventEmitter().rollbackSavepointLayer();
	}

	/** Release the current savepoint layer, merging into parent */
	releaseSavepointLayer(): void {
		const top = this.changeLogLayers.pop();
		if (!top) return;

		const target = this.changeLogLayers.length > 0
			? this.changeLogLayers[this.changeLogLayers.length - 1]
			: this.changeLog;

		for (const [table, set] of top) {
			if (!target.has(table)) target.set(table, new Set());
			const tgt = target.get(table)!;
			for (const k of set) tgt.add(k);
		}

		this.ctx.getDeferredConstraints().releaseLayer();
		this.ctx.getEventEmitter().releaseSavepointLayer();
	}
}
