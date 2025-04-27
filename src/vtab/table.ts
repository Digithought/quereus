import type { VirtualTableModule, SchemaChangeInfo } from './module.js';
import type { Database } from '../core/database.js';
import type { TableSchema } from '../schema/table.js';
import type { VirtualTableCursor } from './cursor.js';
import type { SqlValue } from '../common/types.js';
import type { IndexSchema } from '../schema/table.js';

/**
 * Base class representing a virtual table instance.
 * Module implementations should subclass this to provide specific table behavior.
 */
export abstract class VirtualTable {
	public readonly module: VirtualTableModule<any, any>;
	public readonly db: Database;
	public readonly tableName: string;
	public readonly schemaName: string;
	public errorMessage?: string;
	public tableSchema?: TableSchema;

	constructor(db: Database, module: VirtualTableModule<any, any>, schemaName: string, tableName: string) {
		this.db = db;
		this.module = module;
		this.schemaName = schemaName;
		this.tableName = tableName;
	}

	/**
	 * Sets an error message for the VTable
	 * @param message The error message string
	 */
	protected setErrorMessage(message: string | undefined): void {
		this.errorMessage = message;
	}

	/**
	 * Disconnects from this virtual table connection instance
	 * Called when the database connection closes or the statement is finalized
	 * @throws SqliteError on failure
	 */
	abstract xDisconnect(): Promise<void>;

	/**
	 * Creates a new cursor for scanning this virtual table
	 * @returns A new cursor instance for this table
	 * @throws SqliteError on failure
	 */
	abstract xOpen(): Promise<VirtualTableCursor<this, any>>;

	/**
	 * Performs an INSERT, UPDATE, or DELETE operation
	 * @param values For INSERT/UPDATE, the values to insert/update. For DELETE, often just the rowid
	 * @param rowid For UPDATE/DELETE, the rowid of the row to modify. Null for INSERT
	 * @returns Object with rowid property (for INSERT) or empty object
	 * @throws SqliteError or ConstraintError on failure
	 */
	abstract xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }>;

	/**
	 * Begins a transaction on this virtual table
	 */
	xBegin?(): Promise<void>;

	/**
	 * Syncs changes within the virtual table transaction
	 */
	xSync?(): Promise<void>;

	/**
	 * Commits the virtual table transaction
	 */
	xCommit?(): Promise<void>;

	/**
	 * Rolls back the virtual table transaction
	 */
	xRollback?(): Promise<void>;

	/**
	 * Renames the virtual table
	 * @param newName The new name for the table
	 */
	xRename?(newName: string): Promise<void>;

	/**
	 * Begins a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	xSavepoint?(savepointIndex: number): Promise<void>;

	/**
	 * Releases a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	xRelease?(savepointIndex: number): Promise<void>;

	/**
	 * Rolls back to a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	xRollbackTo?(savepointIndex: number): Promise<void>;

	/**
	 * Checks if the given name would conflict with this table's shadow names
	 * @param name The name to check
	 * @returns true if there's a conflict
	 */
	xShadowName?(name: string): boolean;

	/**
	 * Modifies the schema of this virtual table
	 * @param changeInfo Object describing the schema modification
	 * @throws SqliteError or ConstraintError on failure
	 */
	xAlterSchema?(changeInfo: SchemaChangeInfo): Promise<void>;

	/**
	 * Creates a secondary index on the virtual table
	 * @param indexInfo The index definition
	 */
	xCreateIndex?(indexInfo: IndexSchema): Promise<void>;

	/**
	 * Drops a secondary index from the virtual table
	 * @param indexName The name of the index to drop
	 */
	xDropIndex?(indexName: string): Promise<void>;
}
