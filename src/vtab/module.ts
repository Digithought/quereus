import type { Database } from '../core/database'; // Assuming Database class exists
import type { Statement } from '../core/statement'; // Assuming Statement class exists
import type { VirtualTable } from './table';
import type { VirtualTableCursor } from './cursor';
import type { IndexInfo } from './indexInfo';
import type { SqlValue } from '../common/types';
import type { VTabConfig } from '../common/constants';
import type { SqliteContext } from '../func/context'; // Assuming SqliteContext exists

/**
 * Base interface for module-specific configuration passed to xCreate/xConnect.
 * Modules should define their own interface extending this if they need options.
 */
export interface BaseModuleConfig {}

/**
 * Interface defining the methods for a virtual table module implementation.
 * This is the TypeScript equivalent of the C sqlite3_module struct.
 *
 * Implementations should typically extend a base class rather than implementing
 * this directly to handle default behaviors and future additions gracefully.
 *
 * @template TTable The specific type of VirtualTable managed by this module.
 * @template TCursor The specific type of VirtualTableCursor used by this module.
 * @template TConfig The type defining module-specific configuration options.
 */
export interface VirtualTableModule<
	TTable extends VirtualTable,
	TCursor extends VirtualTableCursor<TTable>,
	TConfig extends BaseModuleConfig = BaseModuleConfig // Add generic config type
> {

	/**
	 * Create a new virtual table instance. Called by CREATE VIRTUAL TABLE.
	 * @param db The database connection.
	 * @param pAux Client data passed during module registration.
	 * @param moduleName The name the module was registered with.
	 * @param schemaName The name of the database schema (e.g., 'main', 'temp').
	 * @param tableName The name of the virtual table being created.
	 * @param options Module-specific configuration options derived from the USING clause arguments.
	 * @returns The new VirtualTable instance.
	 * @throws SqliteError on failure.
	 */
	xCreate(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: TConfig
	): TTable;

	/**
	 * Connect to (or create) a virtual table instance. Called for existing virtual tables when the schema is loaded.
	 * @param db The database connection.
	 * @param pAux Client data passed during module registration.
	 * @param moduleName The name the module was registered with.
	 * @param schemaName The name of the database schema.
	 * @param tableName The name of the virtual table being connected to.
	 * @param options Module-specific configuration options derived from the original CREATE VIRTUAL TABLE arguments.
	 * @returns The VirtualTable instance.
	 * @throws SqliteError on failure.
	 */
	xConnect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: TConfig
	): TTable;

	/**
	 * Determine the best query plan (index) for a given set of constraints and orderings.
	 * This method MUST be synchronous for performance. It modifies the passed IndexInfo object.
	 * @param table The virtual table instance.
	 * @param indexInfo Input constraints/orderings and output plan details.
	 * @returns StatusCode.OK on success, or an error code.
	 */
	xBestIndex(table: TTable, indexInfo: IndexInfo): number; // Sync

	/**
	 * Disconnect from a virtual table instance. Called when the database connection closes.
	 * @param table The virtual table instance.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xDisconnect(table: TTable): Promise<void>;

	/**
	 * Destroy a virtual table instance. Called by DROP TABLE.
	 * @param table The virtual table instance.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xDestroy(table: TTable): Promise<void>;

	/**
	 * Create a new cursor for scanning the virtual table.
	 * @param table The virtual table instance.
	 * @returns A promise resolving to the new VirtualTableCursor instance or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xOpen(table: TTable): Promise<TCursor>;

	/**
	 * Close a virtual table cursor.
	 * @param cursor The cursor instance.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xClose(cursor: TCursor): Promise<void>;

	/**
	 * Start or restart a search/scan on the virtual table.
	 * @param cursor The cursor instance.
	 * @param idxNum The index number chosen by xBestIndex.
	 * @param idxStr The index string chosen by xBestIndex.
	 * @param args Values corresponding to constraints marked in xBestIndex.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xFilter(cursor: TCursor, idxNum: number, idxStr: string | null, args: ReadonlyArray<SqlValue>): Promise<void>;

	/**
	 * Advance the cursor to the next row in the result set.
	 * @param cursor The cursor instance.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xNext(cursor: TCursor): Promise<void>;

	/**
	 * Check if the cursor has reached the end of the result set.
	 * @param cursor The cursor instance.
	 * @returns A promise resolving to true if EOF, false otherwise, or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xEof(cursor: TCursor): Promise<boolean>;

	/**
	 * Return the value for the i-th column of the current row.
	 * This method MUST be synchronous as it's called during result processing.
	 * @param cursor The cursor instance.
	 * @param context Context for setting the result (use context.result*(...)).
	 * @param i The column index (0-based).
	 * @returns StatusCode.OK on success, or an error code.
	 */
	xColumn(cursor: TCursor, context: SqliteContext, i: number): number; // Sync

	/**
	 * Return the rowid for the current row.
	 * @param cursor The cursor instance.
	 * @returns A promise resolving to the rowid (as bigint) or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xRowid(cursor: TCursor): Promise<bigint>;

	/**
	 * Perform an INSERT, UPDATE, or DELETE operation on the virtual table.
	 * @param table The virtual table instance.
	 * @param values For INSERT/UPDATE, the values to insert/update. For DELETE, the old row values. Length depends on operation.
	 * @param rowid For UPDATE/DELETE, the rowid of the row to modify. For INSERT, will be set to the new rowid.
	 * @returns A promise resolving on completion, potentially updating the rowid for INSERTs, or throwing an error (e.g., ConstraintError).
	 * @throws SqliteError or ConstraintError on failure.
	 */
	xUpdate(table: TTable, values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }>;

	/** Optional: Begin a transaction on the virtual table. */
	xBegin?(table: TTable): Promise<void>;
	/** Optional: Sync/commit changes within the virtual table transaction. */
	xSync?(table: TTable): Promise<void>;
	/** Optional: Commit the virtual table transaction. */
	xCommit?(table: TTable): Promise<void>;
	/** Optional: Rollback the virtual table transaction. */
	xRollback?(table: TTable): Promise<void>;

	/** Optional: Find an overloaded function implementation provided by this module. */
	// xFindFunction?(table: TTable, nArg: number, zName: string): { xFunc: Function, pArg?: unknown } | undefined; // TODO: Refine signature

	/** Optional: Rename the virtual table. */
	xRename?(table: TTable, zNew: string): Promise<void>;

	// --- Savepoint Methods (Optional) ---
	/** Optional: Begin a savepoint. */
	xSavepoint?(table: TTable, iSavepoint: number): Promise<void>;
	/** Optional: Release a savepoint. */
	xRelease?(table: TTable, iSavepoint: number): Promise<void>;
	/** Optional: Rollback to a savepoint. */
	xRollbackTo?(table: TTable, iSavepoint: number): Promise<void>;
	// -----------------------------------

	/** Optional: Check for shadow table name conflicts. Return true if name is a shadow name. */
	xShadowName?(name: string): boolean; // Sync

	// TODO: Add xIntegrity if needed later
	// xIntegrity?(table: TTable, schema: string | null, tableName: string, mFlags: number): Promise<{ errorMessage?: string }>;
}
