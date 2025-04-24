import type { Database } from '../core/database'; // Assuming Database class exists
import type { Statement } from '../core/statement'; // Assuming Statement class exists
import type { VirtualTable } from './table';
import type { VirtualTableCursor } from './cursor';
import type { IndexInfo } from './indexInfo';
import type { SqlValue } from '../common/types';
import type { VTabConfig } from '../common/constants';
import type { SqliteContext } from '../func/context'; // Assuming SqliteContext exists
import type { FunctionSchema } from '../schema/function'; // Add import
import type { ColumnDef, ColumnConstraint, TableConstraint } from '../parser/ast'; // <-- Add parser AST import

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

	/**
	 * Optional: Modifies the schema of the virtual table instance.
	 * Called by the `SchemaChange` VDBE opcode generated by `ALTER TABLE ADD/DROP/RENAME COLUMN`.
	 * Implementations should handle modifications to both the schema definition
	 * and the underlying data representation. This operation should ideally
	 * acquire necessary locks to prevent concurrent access issues.
	 * @param table The virtual table instance.
	 * @param changeInfo An object describing the schema modification.
	 * @returns A promise resolving on successful schema alteration or throwing an error.
	 * @throws SqliteError or ConstraintError on failure (e.g., dropping PK, type mismatch).
	 */
	xAlterSchema?(table: TTable, changeInfo: SchemaChangeInfo): Promise<void>;

	/**
	 * Optional: Seeks to a row relative to a given base pointer/rowid.
	 * Used by the SeekRel VDBE opcode for window function frame calculations (ROWS PRECEDING/FOLLOWING).
	 * If not implemented, SeekRel will fail for cursors associated with this module.
	 * @param cursor The cursor instance to operate on.
	 * @param basePointer The pointer/rowid of the row to seek relative to.
	 * @param offset The relative offset (positive for following, negative for preceding).
	 * @returns A promise resolving to the pointer/rowid of the target row, or null if the seek goes out of bounds or is unsupported.
	 * @throws SqliteError on failure.
	 */
	seekRelative?(cursor: TCursor, basePointer: any, offset: number): Promise<SqlValue | null>;

	/**
	 * Optional: Aggregates a value over a specified frame within the cursor's current result set.
	 * Used by the AggFrame VDBE opcode.
	 * @param cursor The cursor instance.
	 * @param funcDef The aggregate function definition.
	 * @param frameStartPtr Pointer/rowid of the first row in the frame.
	 * @param frameEndPtr Pointer/rowid of the last row in the frame (can be null for unbounded following?).
	 * @param argColIdx Index of the column argument within the cursor's rows (-1 for functions like COUNT(*)).
	 * @returns A promise resolving to the final aggregated value.
	 * @throws SqliteError on failure.
	 */
	xAggregateFrame?(cursor: TCursor, funcDef: FunctionSchema, frameStartPtr: any, frameEndPtr: any, argColIdx: number): Promise<SqlValue>;

	/**
	 * Optional: Retrieves a specific column value from the row identified by the given pointer.
	 * Used by the FrameValue VDBE opcode.
	 * @param cursor The cursor instance.
	 * @param pointer Pointer/rowid of the target row.
	 * @param colIdx Index of the column to retrieve.
	 * @returns A promise resolving to the column value or null if row/column not found.
	 * @throws SqliteError on failure.
	 */
	xColumnAtPointer?(cursor: TCursor, pointer: any, colIdx: number): Promise<SqlValue | null>;
}

// --- Add Schema Change Info Type ---
/** Defines the structure for schema change information passed to xAlterSchema */
export type SchemaChangeInfo =
	| { type: 'addColumn'; columnDef: ColumnDef }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string };
// -----------------------------------
