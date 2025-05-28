import { VirtualTable } from '../table.js';
import type { VirtualTableModule, SchemaChangeInfo } from '../module.js';
import type { Database } from '../../core/database.js';
import type { Row } from '../../common/types.js';
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
import { MemoryVirtualTableConnection } from './vtab-connection.js';

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

	/**
	 * @internal - Use MemoryTableModule.xConnect or xCreate
	 * Creates a connection-specific instance linked to a manager.
	 */
	constructor(
		db: Database,
		module: VirtualTableModule<any, any>,
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
	private ensureConnection(): MemoryTableConnection {
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
				logger.debugLog(`ensureConnection: Created new connection ${this.connection.connectionId} for table ${this.tableName}`);
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
		return new MemoryVirtualTableConnection(this.tableName, this.connection);
	}

	// New xQuery method for direct async iteration
	async* xQuery(filterInfo: FilterInfo): AsyncIterable<Row> {
		const conn = this.ensureConnection();
		logger.debugLog(`xQuery using connection ${conn.connectionId} (pending: ${conn.pendingTransactionLayer?.getLayerId()}, read: ${conn.readLayer.getLayerId()})`);
		const currentSchema = this.manager.tableSchema;
		if (!currentSchema) {
			logger.error('xQuery', this.tableName, 'Table schema is undefined');
			return;
		}
		const plan = buildScanPlanFromFilterInfo(filterInfo, currentSchema);
		logger.debugLog(`xQuery invoked for ${this.tableName} with plan: ${safeJsonStringify(plan)}`);

		const startLayer = conn.pendingTransactionLayer ?? conn.readLayer;
		logger.debugLog(`xQuery reading from layer ${startLayer.getLayerId()}`);

		// Delegate scanning to the manager, which handles layer recursion
		yield* this.manager.scanLayer(startLayer, plan);
	}

	// Note: xBestIndex is handled by the MemoryTableModule, not the table instance.

	/** Performs mutation through the connection's transaction layer */
	async xUpdate(
		operation: 'insert' | 'update' | 'delete',
		values: Row | undefined,
		oldKeyValues?: Row
	): Promise<Row | undefined> {
		const conn = this.ensureConnection();
		// Delegate mutation to the manager.
		// This assumes manager.performMutation will be updated to this signature and logic.
		return this.manager.performMutation(conn, operation, values, oldKeyValues);
	}

	/** Begins a transaction for this connection */
	async xBegin(): Promise<void> {
		this.ensureConnection().begin();
	}

	/** Commits this connection's transaction */
	async xCommit(): Promise<void> {
		// Only commit if a connection has actually been established
		if (this.connection) {
			await this.connection.commit();
		}
	}

	/** Rolls back this connection's transaction */
	async xRollback(): Promise<void> {
		// Only rollback if a connection has actually been established
		if (this.connection) {
			this.connection.rollback();
		}
	}

	/** Sync operation (currently no-op for memory table layers) */
	async xSync(): Promise<void> {
		// This might trigger background collapse in the manager in the future
		// await this.manager.tryCollapseLayers(); // Optional: trigger collapse on sync?
		return Promise.resolve();
	}

	/** Renames the underlying table via the manager */
	async xRename(newName: string): Promise<void> {
		logger.operation('Rename', this.tableName, { newName });
		await this.manager.renameTable(newName);
		// Update this instance's schema reference after rename
		this.tableSchema = this.manager.tableSchema;
	}

	// --- Savepoint operations ---
	async xSavepoint(savepointIndex: number): Promise<void> {
		const conn = this.ensureConnection();
		conn.createSavepoint(savepointIndex);
	}

	async xRelease(savepointIndex: number): Promise<void> {
		if (!this.connection) return; // No connection, no savepoints to release
		this.connection.releaseSavepoint(savepointIndex);
	}

	async xRollbackTo(savepointIndex: number): Promise<void> {
		if (!this.connection) return; // No connection, no savepoints to rollback to
		this.connection.rollbackToSavepoint(savepointIndex);
	}
	// --- End Savepoint operations ---


	/** Handles schema changes via the manager */
	async xAlterSchema(changeInfo: SchemaChangeInfo): Promise<void> {
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
	async xDisconnect(): Promise<void> {
		if (this.connection) {
			// Manager handles cleanup and potential layer collapse trigger
			this.manager.disconnect(this.connection.connectionId);
			this.connection = null; // Clear connection reference on this instance
		}
	}

	// --- Index DDL methods delegate to the manager ---
	async xCreateIndex(indexSchema: IndexSchema): Promise<void> {
		logger.operation('Create Index', this.tableName, { indexName: indexSchema.name });
		await this.manager.createIndex(indexSchema);
		this.tableSchema = this.manager.tableSchema; // Refresh local schema ref
	}

	async xDropIndex(indexName: string): Promise<void> {
		logger.operation('Drop Index', this.tableName, { indexName });
		await this.manager.dropIndex(indexName);
		// Update schema reference
		this.tableSchema = this.manager.tableSchema;
	}
	// --- End Index DDL methods ---
}

// Helper function (moved from MemoryTableCursor and adapted)
// function buildScanPlanInternal(filterInfo: FilterInfo, tableSchema: TableSchema): ScanPlan { ... MOVED ... }


