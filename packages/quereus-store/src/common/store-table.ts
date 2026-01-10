/**
 * Generic KVStore-backed Virtual Table implementation.
 *
 * This is a platform-agnostic table implementation that works with any
 * KVStore implementation (LevelDB, IndexedDB, or custom stores).
 *
 * Storage architecture:
 *   - Data store: {schema}.{table} - row data keyed by encoded PK
 *   - Index stores: {schema}.{table}_idx_{name} - one per secondary index
 *   - Stats store: {schema}.{table}_stats - row count and metadata
 */

import {
	VirtualTable,
	IndexConstraintOp,
	ConflictResolution,
	QuereusError,
	ConstraintError,
	StatusCode,
	type Database,
	type TableSchema,
	type Row,
	type FilterInfo,
	type SqlValue,
	type VirtualTableConnection,
	type UpdateArgs,
	type VirtualTableModule,
} from '@quereus/quereus';

import type { KVStore } from './kv-store.js';
import type { StoreEventEmitter } from './events.js';
import type { TransactionCoordinator } from './transaction.js';
import { StoreConnection } from './store-connection.js';
import {
	buildDataKey,
	buildIndexKey,
	buildFullScanBounds,
} from './key-builder.js';
import {
	serializeRow,
	deserializeRow,
	serializeStats,
	deserializeStats,
	type TableStats,
} from './serialization.js';
import type { EncodeOptions } from './encoding.js';

/** Number of mutations before persisting statistics. */
const STATS_FLUSH_INTERVAL = 100;

/** Single key used in the stats store (stats store has only one entry). */
const STATS_KEY = new Uint8Array(0);

/**
 * Configuration for a store table.
 */
export interface StoreTableConfig {
	/** Collation for text keys. Default: 'NOCASE'. */
	collation?: 'BINARY' | 'NOCASE';
	/** Additional platform-specific options. */
	[key: string]: unknown;
}

/**
 * Interface for the store module that manages this table.
 * Provides access to stores and coordinators.
 */
export interface StoreTableModule {
	/** Get the data store for a table. */
	getStore(tableKey: string, config: StoreTableConfig): Promise<KVStore>;
	/** Get an index store for a table. */
	getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore>;
	/** Get the stats store for a table. */
	getStatsStore(schemaName: string, tableName: string): Promise<KVStore>;
	/** Get a coordinator for a table. */
	getCoordinator(tableKey: string, config: StoreTableConfig): Promise<TransactionCoordinator>;
	/** Save table DDL to persistent storage. */
	saveTableDDL(tableSchema: TableSchema): Promise<void>;
}

/**
 * Generic KVStore-backed virtual table.
 *
 * This class provides the core table functionality shared across all
 * storage backends. Platform-specific behavior is delegated to the
 * StoreTableModule.
 */
export class StoreTable extends VirtualTable {
	protected storeModule: StoreTableModule;
	protected config: StoreTableConfig;
	protected store: KVStore | null = null;
	protected storeInitPromise: Promise<KVStore> | null = null;
	protected indexStores: Map<string, KVStore> = new Map();
	protected statsStore: KVStore | null = null;
	protected coordinator: TransactionCoordinator | null = null;
	protected connection: StoreConnection | null = null;
	protected eventEmitter?: StoreEventEmitter;
	protected encodeOptions: EncodeOptions;
	protected ddlSaved = false;

	// Statistics tracking
	protected cachedStats: TableStats | null = null;
	protected pendingStatsDelta = 0;
	protected mutationCount = 0;
	protected statsFlushPending = false;

	constructor(
		db: Database,
		storeModule: StoreTableModule,
		tableSchema: TableSchema,
		config: StoreTableConfig,
		eventEmitter?: StoreEventEmitter,
		isConnected = false
	) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		super(db, storeModule as unknown as VirtualTableModule<any, any>, tableSchema.schemaName, tableSchema.name);
		this.storeModule = storeModule;
		this.tableSchema = tableSchema;
		this.config = config;
		this.eventEmitter = eventEmitter;
		this.encodeOptions = { collation: config.collation || 'NOCASE' };
		this.ddlSaved = isConnected;
	}

	/** Get the table configuration. */
	getConfig(): StoreTableConfig {
		return this.config;
	}

	/** Get the table schema. */
	getSchema(): TableSchema {
		return this.tableSchema!;
	}

	/**
	 * Ensure the data store is open and DDL is persisted.
	 * Uses a promise-based singleton pattern to prevent race conditions
	 * when multiple concurrent queries access the same table.
	 */
	protected ensureStore(): Promise<KVStore> {
		if (this.store) {
			return Promise.resolve(this.store);
		}

		if (this.storeInitPromise) {
			return this.storeInitPromise;
		}

		this.storeInitPromise = this.initializeStore();
		return this.storeInitPromise;
	}

	/**
	 * Internal method to actually initialize the store.
	 * Only called once per table instance.
	 */
	private async initializeStore(): Promise<KVStore> {
		const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();

		try {
			this.store = await this.storeModule.getStore(tableKey, this.config);

			if (!this.store) {
				throw new Error(`getStore returned null/undefined for ${tableKey}`);
			}

			// Save DDL on first access (only for newly created tables)
			if (!this.ddlSaved && this.tableSchema) {
				await this.storeModule.saveTableDDL(this.tableSchema);
				this.ddlSaved = true;
			}

			return this.store;
		} catch (error) {
			this.storeInitPromise = null;
			throw error;
		}
	}

	/**
	 * Get or create an index store for the given index name.
	 */
	protected async ensureIndexStore(indexName: string): Promise<KVStore> {
		let indexStore = this.indexStores.get(indexName);
		if (!indexStore) {
			indexStore = await this.storeModule.getIndexStore(this.schemaName, this.tableName, indexName);
			this.indexStores.set(indexName, indexStore);
		}
		return indexStore;
	}

	/**
	 * Get or create the stats store.
	 */
	protected async ensureStatsStore(): Promise<KVStore> {
		if (!this.statsStore) {
			this.statsStore = await this.storeModule.getStatsStore(this.schemaName, this.tableName);
		}
		return this.statsStore;
	}

	/**
	 * Ensure the coordinator is available and connection is registered.
	 */
	protected async ensureCoordinator(): Promise<TransactionCoordinator> {
		if (!this.coordinator) {
			const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();
			this.coordinator = await this.storeModule.getCoordinator(tableKey, this.config);

			this.coordinator.registerCallbacks({
				onCommit: () => this.applyPendingStats(),
				onRollback: () => this.discardPendingStats(),
			});
		}

		if (!this.connection) {
			this.connection = new StoreConnection(this.tableName, this.coordinator);

			const dbInternal = this.db as unknown as {
				registerConnection(conn: VirtualTableConnection): Promise<void>;
			};
			await dbInternal.registerConnection(this.connection);
		}

		return this.coordinator;
	}

	/** Apply pending stats on commit. */
	protected applyPendingStats(): void {
		if (this.pendingStatsDelta === 0) return;

		if (!this.cachedStats) {
			this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
		}
		this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + this.pendingStatsDelta);
		this.cachedStats.updatedAt = Date.now();
		this.mutationCount += Math.abs(this.pendingStatsDelta);
		this.pendingStatsDelta = 0;

		if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
			this.statsFlushPending = true;
			queueMicrotask(() => this.flushStats());
		}
	}

	/** Discard pending stats on rollback. */
	protected discardPendingStats(): void {
		this.pendingStatsDelta = 0;
	}

	/** Flush statistics to the stats store. */
	protected async flushStats(): Promise<void> {
		this.statsFlushPending = false;
		this.mutationCount = 0;

		if (!this.cachedStats) {
			return;
		}

		const statsStore = await this.ensureStatsStore();
		await statsStore.put(STATS_KEY, serializeStats(this.cachedStats));
	}

	/** Create a new connection for transaction support. */
	async createConnection(): Promise<VirtualTableConnection> {
		await this.ensureCoordinator();
		return this.connection!;
	}

	/** Get the current connection. */
	getConnection(): VirtualTableConnection | undefined {
		return this.connection ?? undefined;
	}

	/** Extract primary key values from a row. */
	protected extractPK(row: Row): SqlValue[] {
		const schema = this.tableSchema!;
		return schema.primaryKeyDefinition.map(pk => row[pk.index]);
	}

	/** Query the table with optional filters. */
	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const store = await this.ensureStore();

		const pkAccess = this.analyzePKAccess(filterInfo);

		if (pkAccess.type === 'point') {
			const key = buildDataKey(pkAccess.values!, this.encodeOptions);
			const value = await store.get(key);
			if (value) {
				const row = deserializeRow(value);
				if (this.matchesFilters(row, filterInfo)) {
					yield row;
				}
			}
			return;
		}

		if (pkAccess.type === 'range') {
			yield* this.scanPKRange(store, pkAccess, filterInfo);
			return;
		}

		// Full table scan
		const bounds = buildFullScanBounds();
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo)) {
				yield row;
			}
		}
	}

	/** Analyze filter info to determine PK access pattern. */
	protected analyzePKAccess(filterInfo: FilterInfo): PKAccessPattern {
		const schema = this.tableSchema!;
		const pkColumns = schema.primaryKeyDefinition.map(pk => pk.index);

		if (pkColumns.length === 0) {
			return { type: 'scan' };
		}

		// Check for equality on all PK columns
		const eqValues: SqlValue[] = new Array(pkColumns.length);
		let allEq = true;

		for (let i = 0; i < pkColumns.length; i++) {
			const pkColIdx = pkColumns[i];
			const eqConstraintEntry = filterInfo.constraints?.find(
				c => c.constraint.iColumn === pkColIdx && c.constraint.op === IndexConstraintOp.EQ
			);
			if (eqConstraintEntry && eqConstraintEntry.argvIndex > 0) {
				eqValues[i] = filterInfo.args[eqConstraintEntry.argvIndex - 1];
			} else {
				allEq = false;
				break;
			}
		}

		if (allEq) {
			return { type: 'point', values: eqValues };
		}

		// Check for range constraints on first PK column
		const firstPkCol = pkColumns[0];
		const rangeOps = [IndexConstraintOp.LT, IndexConstraintOp.LE, IndexConstraintOp.GT, IndexConstraintOp.GE];
		const rangeConstraints = filterInfo.constraints?.filter(
			c => c.constraint.iColumn === firstPkCol && rangeOps.includes(c.constraint.op)
		) || [];

		if (rangeConstraints.length > 0) {
			return {
				type: 'range',
				columnIndex: firstPkCol,
				constraints: rangeConstraints.map(c => ({
					columnIndex: c.constraint.iColumn,
					op: c.constraint.op,
					value: c.argvIndex > 0 ? filterInfo.args[c.argvIndex - 1] : undefined,
				})),
			};
		}

		return { type: 'scan' };
	}

	/** Scan a range of PK values. */
	protected async *scanPKRange(
		store: KVStore,
		_access: PKAccessPattern,
		filterInfo: FilterInfo
	): AsyncIterable<Row> {
		const bounds = buildFullScanBounds();

		// TODO: Refine bounds based on range constraints
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo)) {
				yield row;
			}
		}
	}

	/** Check if a row matches the filter constraints. */
	protected matchesFilters(row: Row, filterInfo: FilterInfo): boolean {
		if (!filterInfo.constraints || filterInfo.constraints.length === 0) {
			return true;
		}

		for (const constraintEntry of filterInfo.constraints) {
			const { constraint, argvIndex } = constraintEntry;
			if (constraint.iColumn < 0 || argvIndex <= 0) {
				continue;
			}

			const rowValue = row[constraint.iColumn];
			const filterValue = filterInfo.args[argvIndex - 1];

			if (!this.compareValues(rowValue, constraint.op, filterValue)) {
				return false;
			}
		}

		return true;
	}

	/** Compare two values according to an operator. */
	protected compareValues(a: SqlValue, op: IndexConstraintOp, b: SqlValue): boolean {
		if (a === null || b === null) {
			return op === IndexConstraintOp.EQ ? a === b : false;
		}

		switch (op) {
			case IndexConstraintOp.EQ:
				return a === b || (typeof a === 'string' && typeof b === 'string' &&
					this.config.collation === 'NOCASE' && a.toLowerCase() === b.toLowerCase());
			case IndexConstraintOp.NE: return a !== b;
			case IndexConstraintOp.LT: return a < b;
			case IndexConstraintOp.LE: return a <= b;
			case IndexConstraintOp.GT: return a > b;
			case IndexConstraintOp.GE: return a >= b;
			default: return true;
		}
	}

	/** Perform an update operation (INSERT, UPDATE, DELETE). */
	async update(args: UpdateArgs): Promise<Row | undefined> {
		const store = await this.ensureStore();
		const coordinator = await this.ensureCoordinator();
		const inTransaction = coordinator.isInTransaction();
		const schema = this.tableSchema!;
		const { operation, values, oldKeyValues } = args;

		switch (operation) {
			case 'insert': {
				if (!values) throw new QuereusError('INSERT requires values', StatusCode.MISUSE);
				const pk = this.extractPK(values);
				const key = buildDataKey(pk, this.encodeOptions);

				// Check for existing row (for conflict handling)
				const existing = await store.get(key);
				if (existing && args.onConflict !== ConflictResolution.REPLACE) {
					throw new ConstraintError('UNIQUE constraint failed: primary key');
				}

				const serializedRow = serializeRow(values);
				if (inTransaction) {
					coordinator.put(key, serializedRow);
				} else {
					await store.put(key, serializedRow);
				}

				// Update secondary indexes
				await this.updateSecondaryIndexes(inTransaction, null, values, pk);

				// Track statistics (only count as new if not replacing)
				if (!existing) {
					this.trackMutation(+1, inTransaction);
				}

				// Queue or emit event
				const insertEvent = {
					type: 'insert' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: pk,
					newRow: values,
				};
				if (inTransaction) {
					coordinator.queueEvent(insertEvent);
				} else {
					this.eventEmitter?.emitDataChange(insertEvent);
				}

				return values;
			}

			case 'update': {
				if (!values || !oldKeyValues) throw new QuereusError('UPDATE requires values and oldKeyValues', StatusCode.MISUSE);
				const oldPk = this.extractPK(oldKeyValues);
				const newPk = this.extractPK(values);
				const oldKey = buildDataKey(oldPk, this.encodeOptions);
				const newKey = buildDataKey(newPk, this.encodeOptions);

				// Get old row for index updates
				const oldRowData = await store.get(oldKey);
				const oldRow = oldRowData ? deserializeRow(oldRowData) : null;

				// Delete old key if PK changed
				if (!this.keysEqual(oldPk, newPk)) {
					if (inTransaction) {
						coordinator.delete(oldKey);
					} else {
						await store.delete(oldKey);
					}
				}

				const serializedRow = serializeRow(values);
				if (inTransaction) {
					coordinator.put(newKey, serializedRow);
				} else {
					await store.put(newKey, serializedRow);
				}

				// Update secondary indexes
				await this.updateSecondaryIndexes(inTransaction, oldRow, values, newPk);

				// Queue or emit event
				const updateEvent = {
					type: 'update' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: newPk,
					oldRow: oldRow || undefined,
					newRow: values,
				};
				if (inTransaction) {
					coordinator.queueEvent(updateEvent);
				} else {
					this.eventEmitter?.emitDataChange(updateEvent);
				}

				return values;
			}

			case 'delete': {
				if (!oldKeyValues) throw new QuereusError('DELETE requires oldKeyValues', StatusCode.MISUSE);
				const pk = this.extractPK(oldKeyValues);
				const key = buildDataKey(pk, this.encodeOptions);

				// Get old row for index cleanup
				const oldRowData = await store.get(key);
				const oldRow = oldRowData ? deserializeRow(oldRowData) : null;

				if (inTransaction) {
					coordinator.delete(key);
				} else {
					await store.delete(key);
				}

				// Remove from secondary indexes
				if (oldRow) {
					await this.updateSecondaryIndexes(inTransaction, oldRow, null, pk);
					this.trackMutation(-1, inTransaction);
				}

				// Queue or emit event
				const deleteEvent = {
					type: 'delete' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: pk,
					oldRow: oldRow || undefined,
				};
				if (inTransaction) {
					coordinator.queueEvent(deleteEvent);
				} else {
					this.eventEmitter?.emitDataChange(deleteEvent);
				}

				return undefined;
			}

			default:
				throw new QuereusError(`Unknown operation: ${operation}`, StatusCode.MISUSE);
		}
	}

	/** Update secondary indexes after a row change. */
	protected async updateSecondaryIndexes(
		inTransaction: boolean,
		oldRow: Row | null,
		newRow: Row | null,
		pk: SqlValue[]
	): Promise<void> {
		const schema = this.tableSchema!;
		const indexes = schema.indexes || [];

		for (const index of indexes) {
			const indexStore = await this.ensureIndexStore(index.name);
			const indexCols = index.columns.map(c => c.index);

			// Remove old index entry
			if (oldRow) {
				const oldIndexValues = indexCols.map(i => oldRow[i]);
				const oldIndexKey = buildIndexKey(oldIndexValues, pk, this.encodeOptions);

				if (inTransaction && this.coordinator) {
					// For transactions, we need to track index operations separately
					// For now, apply directly (transaction support for indexes is TODO)
					await indexStore.delete(oldIndexKey);
				} else {
					await indexStore.delete(oldIndexKey);
				}
			}

			// Add new index entry
			if (newRow) {
				const newIndexValues = indexCols.map(i => newRow[i]);
				const newIndexKey = buildIndexKey(newIndexValues, pk, this.encodeOptions);
				// Index value is empty - we just need the key for lookups
				const emptyValue = new Uint8Array(0);

				if (inTransaction && this.coordinator) {
					// For transactions, we need to track index operations separately
					// For now, apply directly (transaction support for indexes is TODO)
					await indexStore.put(newIndexKey, emptyValue);
				} else {
					await indexStore.put(newIndexKey, emptyValue);
				}
			}
		}
	}

	/** Check if two PK arrays are equal. */
	protected keysEqual(a: SqlValue[], b: SqlValue[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	/** Disconnect from the store. */
	async disconnect(): Promise<void> {
		// Called by Quereus after each scan completes.
		// Do NOT clear the store - it's shared across concurrent queries.
		// Only flush pending stats if there are mutations.
		if (this.mutationCount > 0 && this.store) {
			await this.flushStats();
		}
		// Store remains available for subsequent queries.
		// Use destroy() to fully clean up the table.
	}

	/** Get the current estimated row count. */
	async getEstimatedRowCount(): Promise<number> {
		if (this.cachedStats) {
			return this.cachedStats.rowCount;
		}

		const statsStore = await this.ensureStatsStore();
		const statsData = await statsStore.get(STATS_KEY);

		if (statsData) {
			this.cachedStats = deserializeStats(statsData);
			return this.cachedStats.rowCount;
		}

		// No stats yet, return 0
		return 0;
	}

	/** Track a mutation and schedule lazy stats persistence. */
	protected trackMutation(delta: number, inTransaction = false): void {
		if (inTransaction) {
			// Buffer during transaction - stats will be applied at commit
			this.pendingStatsDelta += delta;
			return;
		}

		if (!this.cachedStats) {
			this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
		}

		this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + delta);
		this.cachedStats.updatedAt = Date.now();
		this.mutationCount++;

		// Schedule lazy flush after threshold
		if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
			this.statsFlushPending = true;
			queueMicrotask(() => this.flushStats());
		}
	}
}

/** PK access pattern analysis result. */
interface PKAccessPattern {
	type: 'point' | 'range' | 'scan';
	values?: SqlValue[];
	columnIndex?: number;
	constraints?: Array<{ columnIndex: number; op: IndexConstraintOp; value?: SqlValue }>;
}
