import { VirtualTable } from '../table.js';
import type { AnyVirtualTableModule, SchemaChangeInfo } from '../module.js';
import type { Database } from '../../core/database.js';
import type { Row, SqlValue, CompareFn, UpdateResult } from '../../common/types.js';
import { type IndexSchema, type TableSchema } from '../../schema/table.js';
import { MemoryTableManager } from './layer/manager.js';
import type { MemoryTableConnection } from './layer/connection.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { FilterInfo } from '../filter-info.js';
import { buildScanPlanFromFilterInfo } from './layer/scan-plan.js';
import type { ColumnDef as ASTColumnDef } from '../../parser/ast.js'; // Assuming this will be updated for renameColumn
import { createMemoryTableLoggers } from './utils/logging.js';
import { safeJsonStringify } from '../../util/serialization.js';
import type { VirtualTableConnection } from '../connection.js';
import { MemoryVirtualTableConnection } from './connection.js';
import type { ConflictResolution } from '../../common/constants.js';
import type { VTableEventEmitter } from '../events.js';
import { compareSqlValues } from '../../util/comparison.js';

const logger = createMemoryTableLoggers('table');

/**
 * Represents a connection-specific instance of an in-memory table using the layer-based MVCC model.
 * This class acts as a thin wrapper around the shared MemoryTableManager,
 * holding the connection state.
 */
export class MemoryTable extends VirtualTable {
	/** @internal The shared manager handling layers, schema, and global state */
	public readonly manager: MemoryTableManager;
	/** @internal Connection state specific to this table instance (lazily initialized) */
	private connection: MemoryTableConnection | null = null;
	/** @internal Cached VirtualTableConnection wrapper to avoid re-creation */
	private cachedVtabConnection: MemoryVirtualTableConnection | null = null;

	/**
	 * @internal - Use MemoryTableModule.connect or create
	 * Creates a connection-specific instance linked to a manager.
	 */
	constructor(
		db: Database,
		module: AnyVirtualTableModule,
		manager: MemoryTableManager // Pass the shared manager instance
	) {
		// Use manager's schema and name for the base class constructor
		super(db, module, manager.schemaName, manager.tableName);
		this.manager = manager;
		// Set the tableSchema directly from the manager's current canonical schema
		// This ensures the VirtualTable base class has the correct schema reference.
		this.tableSchema = manager.tableSchema;
	}

	/** Returns the canonical schema from the manager */
	getSchema(): TableSchema | undefined {
		// Always return the potentially updated schema from the manager
		return this.manager.tableSchema;
	}

	/** Checks read-only status via the manager */
	isReadOnly(): boolean {
		// Access readOnly via a public method on the manager
		return this.manager.isReadOnly;
	}

	/** Ensures the connection to the manager is established */
	private async ensureConnection(): Promise<MemoryTableConnection> {
		if (!this.connection) {
			// Check if there's already an active connection for this table in the database
			const existingConnections = this.db.getConnectionsForTable(this.tableName);
			if (existingConnections.length > 0 && existingConnections[0] instanceof MemoryVirtualTableConnection) {
				const memoryVirtualConnection = existingConnections[0] as MemoryVirtualTableConnection;
				this.connection = memoryVirtualConnection.getMemoryConnection();
				logger.debugLog(`ensureConnection: Reused existing connection ${this.connection.connectionId} for table ${this.tableName}`);
			} else {
				// Establish connection state with the manager upon first use
				this.connection = this.manager.connect();

				// Create a VirtualTableConnection wrapper and register it with the database
				const vtabConnection = new MemoryVirtualTableConnection(this.tableName, this.connection);
				await this.db.registerConnection(vtabConnection);

				logger.debugLog(`ensureConnection: Created and registered new connection ${this.connection.connectionId} for table ${this.tableName}`);
			}
		}
		return this.connection;
	}

	/** Sets an existing connection for this table instance (for transaction reuse) */
	setConnection(memoryConnection: MemoryTableConnection): void {
		logger.debugLog(`Setting connection ${memoryConnection.connectionId} for table ${this.tableName}`);
		this.connection = memoryConnection;
	}

	/** Creates a new VirtualTableConnection for transaction support */
	createConnection(): VirtualTableConnection {
		const memoryConnection = this.manager.connect();
		return new MemoryVirtualTableConnection(this.tableName, memoryConnection);
	}

	/** Gets the current connection if this table maintains one internally */
	getConnection(): VirtualTableConnection | undefined {
		if (!this.connection) {
			return undefined;
		}
		if (!this.cachedVtabConnection || this.cachedVtabConnection.getMemoryConnection() !== this.connection) {
			this.cachedVtabConnection = new MemoryVirtualTableConnection(this.tableName, this.connection);
		}
		return this.cachedVtabConnection;
	}

	/**
	 * Get the event emitter for mutation and schema hooks.
	 */
	getEventEmitter(): VTableEventEmitter | undefined {
		return this.manager.getEventEmitter();
	}

	// Direct async iteration for query execution
	async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const conn = await this.ensureConnection();
		logger.debugLog(`query using connection ${conn.connectionId} (pending: ${conn.pendingTransactionLayer?.getLayerId()}, read: ${conn.readLayer.getLayerId()})`);
		const currentSchema = this.manager.tableSchema;
		if (!currentSchema) {
			logger.error('query', this.tableName, 'Table schema is undefined');
			return;
		}
		const plan = buildScanPlanFromFilterInfo(filterInfo, currentSchema);
		logger.debugLog(`query invoked for ${this.tableName} with plan: ${safeJsonStringify(plan)}`);

		const startLayer = conn.pendingTransactionLayer ?? conn.readLayer;
		logger.debugLog(`query reading from layer ${startLayer.getLayerId()}`);

		// Delegate scanning to the manager, which handles layer recursion
		yield* this.manager.scanLayer(startLayer, plan);
	}

	// Note: getBestAccessPlan is handled by the MemoryTableModule, not the table instance.

	/** Performs mutation through the connection's transaction layer */
	async update(args: import('../table.js').UpdateArgs): Promise<UpdateResult> {
		const conn = await this.ensureConnection();
		// Delegate mutation to the manager.
		// Note: mutationStatement is ignored by memory table (could be logged if needed)
		return this.manager.performMutation(conn, args.operation, args.values, args.oldKeyValues, args.onConflict);
	}

	/** Begins a transaction for this connection */
	async begin(): Promise<void> {
		(await this.ensureConnection()).begin();
	}

	/** Commits this connection's transaction */
	async commit(): Promise<void> {
		// Only commit if a connection has actually been established
		if (this.connection) {
			await this.connection.commit();
		}
	}

	/** Rolls back this connection's transaction */
	async rollback(): Promise<void> {
		// Only rollback if a connection has actually been established
		if (this.connection) {
			this.connection.rollback();
		}
	}

	/** Sync operation (currently no-op for memory table layers) */
	async sync(): Promise<void> {
		// This might trigger background collapse in the manager in the future
		// await this.manager.tryCollapseLayers(); // Optional: trigger collapse on sync?
		return Promise.resolve();
	}

	/** Renames the underlying table via the manager */
	async rename(newName: string): Promise<void> {
		logger.operation('Rename', this.tableName, { newName });
		await this.manager.renameTable(newName);
		// Update this instance's schema reference after rename
		this.tableSchema = this.manager.tableSchema;
	}

	// --- Savepoint operations ---
	async savepoint(savepointIndex: number): Promise<void> {
		const conn = await this.ensureConnection();
		conn.createSavepoint(savepointIndex);
	}

	async release(savepointIndex: number): Promise<void> {
		if (!this.connection) return; // No connection, no savepoints to release
		this.connection.releaseSavepoint(savepointIndex);
	}

	async rollbackTo(savepointIndex: number): Promise<void> {
		if (!this.connection) return; // No connection, no savepoints to rollback to
		this.connection.rollbackToSavepoint(savepointIndex);
	}
	// --- End Savepoint operations ---


	/** Handles schema changes via the manager */
	async alterSchema(changeInfo: SchemaChangeInfo): Promise<void> {
		const originalManagerSchema = this.manager.tableSchema; // For potential error recovery
		try {
			switch (changeInfo.type) {
				case 'addColumn':
					await this.manager.addColumn(changeInfo.columnDef);
					break;
				case 'dropColumn':
					await this.manager.dropColumn(changeInfo.columnName);
					break;
				case 'renameColumn':
					if (!('newColumnDefAst' in changeInfo)) {
						throw new QuereusError('SchemaChangeInfo for renameColumn missing newColumnDefAst', StatusCode.INTERNAL);
					}
					await this.manager.renameColumn(changeInfo.oldName, changeInfo.newColumnDefAst as ASTColumnDef);
					break;
				default: {
					const exhaustiveCheck: never = changeInfo;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					throw new QuereusError(`Unhandled schema change: ${(exhaustiveCheck as any)?.type}`, StatusCode.INTERNAL);
				}
			}
			this.tableSchema = this.manager.tableSchema; // Refresh local schema ref
		} catch (e) {
			logger.error('Schema Change', this.tableName, e);
			// Manager DDL methods should handle reverting their own BaseLayer schema updates on error.
			// Refresh local schema ref to ensure it's consistent with manager after potential error/revert.
			this.tableSchema = originalManagerSchema;
			// It might be safer for manager DDL to not alter its own this.tableSchema until baseLayer op succeeds.
			// And if baseLayer op fails, manager DDL reverts baseLayer.tableSchema.
			// Then here, we always sync from manager: this.tableSchema = this.manager.tableSchema;
			throw e;
		}
	}

	/** Disconnects this connection instance from the manager */
	async disconnect(): Promise<void> {
		if (this.connection) {
			// Manager handles cleanup and potential layer collapse trigger
			await this.manager.disconnect(this.connection.connectionId);
			this.connection = null;
			this.cachedVtabConnection = null;
		}
	}

	// --- Index DDL methods delegate to the manager ---
	async createIndex(indexSchema: IndexSchema): Promise<void> {
		logger.operation('Create Index', this.tableName, { indexName: indexSchema.name });
		await this.manager.createIndex(indexSchema);
		this.tableSchema = this.manager.tableSchema; // Refresh local schema ref
	}

	async dropIndex(indexName: string): Promise<void> {
		logger.operation('Drop Index', this.tableName, { indexName });
		await this.manager.dropIndex(indexName);
		// Update schema reference
		this.tableSchema = this.manager.tableSchema;
	}
	// --- End Index DDL methods ---

	// --- Isolation Layer Support ---

	/**
	 * Extract primary key values from a row.
	 * Returns the PK column values in PK order.
	 */
	extractPrimaryKey(row: Row): SqlValue[] {
		const pkIndices = this.getPrimaryKeyIndices();
		return pkIndices.map(i => row[i]);
	}

	/**
	 * Compare two rows by their primary key values.
	 * Uses compareSqlValues for each PK column in order.
	 * @returns negative if a < b, 0 if equal, positive if a > b
	 */
	comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number {
		for (let i = 0; i < a.length; i++) {
			const cmp = compareSqlValues(a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	}

	/**
	 * Get the primary key column indices in the row.
	 * Returns indices based on the table's primary key definition.
	 */
	getPrimaryKeyIndices(): number[] {
		const schema = this.tableSchema;
		if (!schema) return [];
		return schema.primaryKeyDefinition.map(pkDef => pkDef.index);
	}

	/**
	 * Get a comparator function for a specific index.
	 * Used when merging index scans from overlay and underlying tables.
	 */
	getIndexComparator(indexName: string): CompareFn | undefined {
		const schema = this.tableSchema;
		if (!schema) return undefined;

		const index = schema.indexes?.find(idx => idx.name.toLowerCase() === indexName.toLowerCase());
		if (!index) return undefined;

		return (a: SqlValue, b: SqlValue): number => compareSqlValues(a, b);
	}
	// --- End Isolation Layer Support ---
}

// Helper function (moved from MemoryTableCursor and adapted)
// function buildScanPlanInternal(filterInfo: FilterInfo, tableSchema: TableSchema): ScanPlan { ... MOVED ... }


