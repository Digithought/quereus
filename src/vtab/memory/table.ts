// src/vtab/memory/table.ts
import { VirtualTable } from '../table.js';
import type { VirtualTableCursor } from '../cursor.js';
import type { VirtualTableModule, SchemaChangeInfo } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import type { Database } from '../../core/database.js';
import type { SqlValue } from '../../common/types.js';
import { type TableSchema, type IndexSchema } from '../../schema/table.js';
import { MemoryTableManager } from './layer/manager.js';
import type { MemoryTableConnection } from './layer/connection.js';
import { MemoryTableCursor } from './cursor.js';
import type { ColumnDef } from '../../parser/ast.js';
import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/constants.js';

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
		module: VirtualTableModule<any, any, any>,
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
		return this.manager.isReadOnly();
	}

	/** Ensures the connection to the manager is established */
	private ensureConnection(): MemoryTableConnection {
		if (!this.connection) {
			// Establish connection state with the manager upon first use
			this.connection = this.manager.connect();
		}
		return this.connection;
	}

	/**
	 * Opens a cursor for this connection's view of the table.
	 */
	async xOpen(): Promise<VirtualTableCursor<this>> {
		const conn = this.ensureConnection();
		// Create a new cursor instance associated with *this* table instance (connection)
		return new MemoryTableCursor(this, conn) as unknown as VirtualTableCursor<this>;
	}

	// Note: xBestIndex is handled by the MemoryTableModule, not the table instance.

	/** Performs mutation through the connection's transaction layer */
	async xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint; }> {
		const conn = this.ensureConnection();
		// Delegate mutation to the manager, passing the connection state
		return this.manager.performMutation(conn, values, rowid);
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
		try {
			// Delegate directly to the manager's schema modification methods
			switch (changeInfo.type) {
				case 'addColumn':
					await this.manager.addColumn(changeInfo.columnDef);
					break;
				case 'dropColumn':
					await this.manager.dropColumn(changeInfo.columnName);
					break;
				case 'renameColumn':
					await this.manager.renameColumn(changeInfo.oldName, changeInfo.newName);
					break;
				default:
					// This should not happen if types are correct
					const exhaustiveCheck: never = changeInfo;
					throw new SqliteError(`Unhandled schema change type: ${(exhaustiveCheck as any)?.type}`, StatusCode.INTERNAL);
			}
			// Update this instance's schema reference after alteration succeeds
			this.tableSchema = this.manager.tableSchema;
		} catch (e) {
			console.error(`Failed to apply schema change (${(changeInfo as any).type}) to ${this.tableName}:`, e);
			// Refresh schema reference in case of partial failure?
			this.tableSchema = this.manager.tableSchema;
			throw e; // Re-throw the error
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
	async xCreateIndex(indexInfo: IndexSchema): Promise<void> {
		await this.manager.createIndex(indexInfo);
		// Update schema reference
		this.tableSchema = this.manager.tableSchema;
	}

	async xDropIndex(indexName: string): Promise<void> {
		await this.manager.dropIndex(indexName);
		// Update schema reference
		this.tableSchema = this.manager.tableSchema;
	}
	// --- End Index DDL methods ---
}


