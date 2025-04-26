import type { VirtualTableModule, SchemaChangeInfo } from './module';
import type { Database } from '../core/database';
import type { TableSchema } from '../schema/table';
import type { VirtualTableCursor } from './cursor';
import type { IndexInfo } from './indexInfo';
import type { SqlValue } from '../common/types';
import type { FunctionSchema } from '../schema/function';
import type { Statement } from '../core/statement';
import { StatusCode } from '../common/types';
import { SqliteError } from '../common/errors';
import type { IndexSchema } from '../schema/table';

/**
 * Base class (or interface) representing an instance of a virtual table,
 * specific to a connection.
 * Module implementations will typically subclass this.
 */
export abstract class VirtualTable {
	public readonly module: VirtualTableModule<any, any>; // Reference back to the module
	public readonly db: Database; // Database connection
	public readonly tableName: string;
	public readonly schemaName: string;
	public errorMessage?: string; // For storing error messages (like C API's zErrMsg)
	public tableSchema?: TableSchema; // The specific schema for this instance

	constructor(db: Database, module: VirtualTableModule<any, any>, schemaName: string, tableName: string) {
		this.db = db;
		this.module = module;
		this.schemaName = schemaName;
		this.tableName = tableName;
	}

	/**
	 * Sets an error message for the VTable, freeing any previous message.
	 * Mimics the C API's zErrMsg handling.
	 * @param message The error message string.
	 */
	protected setErrorMessage(message: string | undefined): void {
		// In JS/TS, we don't need to manually free like in C with sqlite3_mprintf/sqlite3_free.
		// Just assign the new message. If it's undefined, the error state is cleared.
		this.errorMessage = message;
	}

	// --- Instance-Specific Methods (Moved from VirtualTableModule) --- //

	/**
	 * Disconnect from this virtual table connection instance.
	 * Called when the database connection closes or the statement using it is finalized.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	abstract xDisconnect(): Promise<void>;

	/**
	 * Create a new cursor for scanning this virtual table instance.
	 * The returned cursor type should be compatible with the module's specific cursor type.
	 * @returns A promise resolving to the new VirtualTableCursor instance or throwing an error.
	 * @throws SqliteError on failure.
	 */
	abstract xOpen(): Promise<VirtualTableCursor<this, any>>;

	/**
	 * Perform an INSERT, UPDATE, or DELETE operation on this virtual table instance.
	 * @param values For INSERT/UPDATE, the values to insert/update. For DELETE, often just the rowid.
	 * @param rowid For UPDATE/DELETE, the rowid of the row to modify. May be null for INSERT.
	 * @returns A promise resolving with the rowid of the inserted row (for INSERT), or an empty object otherwise, or throwing an error.
	 * @throws SqliteError or ConstraintError on failure.
	 */
	abstract xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }>;

	/** Optional: Begin a transaction on this virtual table instance. */
	xBegin?(): Promise<void>;
	/** Optional: Sync/commit changes within the virtual table transaction. */
	xSync?(): Promise<void>;
	/** Optional: Commit the virtual table transaction. */
	xCommit?(): Promise<void>;
	/** Optional: Rollback the virtual table transaction. */
	xRollback?(): Promise<void>;

	/** Optional: Find an overloaded function implementation provided by this module, potentially specific to this table instance. */
	// xFindFunction?(nArg: number, zName: string): { xFunc: Function, pArg?: unknown } | undefined;

	/** Optional: Rename the virtual table. */
	xRename?(newName: string): Promise<void>;

	// --- Savepoint Methods (Optional) ---
	/** Optional: Begin a savepoint. */
	xSavepoint?(savepointIndex: number): Promise<void>;
	/** Optional: Release a savepoint. */
	xRelease?(savepointIndex: number): Promise<void>;
	/** Optional: Rollback to a savepoint. */
	xRollbackTo?(savepointIndex: number): Promise<void>;
	// -----------------------------------

	/** Optional: Check for shadow table name conflicts (usually static, but could be instance-specific). */
	xShadowName?(name: string): boolean; // Sync

	/**
	 * Optional: Modifies the schema of this virtual table instance.
	 * Called by the `SchemaChange` VDBE opcode.
	 * @param changeInfo An object describing the schema modification.
	 * @returns A promise resolving on successful schema alteration or throwing an error.
	 * @throws SqliteError or ConstraintError on failure.
	 */
	xAlterSchema?(changeInfo: SchemaChangeInfo): Promise<void>;

	/** Optional: Create a secondary index on the virtual table instance. */
	xCreateIndex?(indexInfo: IndexSchema): Promise<void>;

	/** Optional: Drop a secondary index from the virtual table instance. */
	xDropIndex?(indexName: string): Promise<void>;

	// ------------------------------------------------------------------- //
}
