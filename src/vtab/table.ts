import type { VirtualTableModule, SchemaChangeInfo } from './module.js';
import type { Database } from '../core/database.js';
import type { TableSchema } from '../schema/table.js';
import type { Row } from '../common/types.js';
import type { IndexSchema } from '../schema/table.js';
import type { FilterInfo } from './filter-info.js';
import type { RowOp } from '../parser/ast.js';

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
	 * @throws QuereusError on failure
	 */
	abstract xDisconnect(): Promise<void>;

	/**
	 * (Optional) Opens a direct data stream for this virtual table based on filter criteria.
	 * This is an alternative to the cursor-based xOpen/filter/next model.
	 * @param filterInfo Information from xBestIndex and query parameters.
	 * @returns An AsyncIterable yielding Row tuples.
	 * @throws QuereusError on failure
	 */
	xQuery?(filterInfo: FilterInfo): AsyncIterable<Row>;

	/**
	 * Performs an INSERT, UPDATE, or DELETE operation
	 * @param operation The operation to perform (insert, update, delete)
	 * @param values For INSERT/UPDATE, the values to insert/update. For DELETE, undefined
	 * @param oldKeyValues For UPDATE/DELETE, the old key values of the row to modify. Undefined for INSERT
	 * @returns new row for INSERT/UPDATE, undefined for DELETE
	 * @throws QuereusError or ConstraintError on failure
	 */
	abstract xUpdate(
		operation: RowOp,
		values: Row | undefined,
		oldKeyValues?: Row
	): Promise<Row | undefined>;

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
	 * Modifies the schema of this virtual table
	 * @param changeInfo Object describing the schema modification
	 * @throws QuereusError or ConstraintError on failure
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
