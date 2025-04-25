import type { Database } from '../core/database'; // Assuming Database class exists
import type { VirtualTable } from './table';
import type { VirtualTableCursor } from './cursor';
import type { IndexInfo } from './indexInfo';
import type { ColumnDef } from '../parser/ast'; // <-- Add parser AST import
import type { TableSchema } from '../schema/table'; // Add import for TableSchema

/**
 * Base interface for module-specific configuration passed to xCreate/xConnect.
 * Modules should define their own interface extending this if they need options.
 */
export interface BaseModuleConfig {}

/**
 * Interface defining the methods for a virtual table module implementation.
 * This is the TypeScript equivalent of the C sqlite3_module struct.
 * The module primarily acts as a factory for connection-specific VirtualTable instances.
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
	 * Create the persistent definition of a virtual table. Called by CREATE VIRTUAL TABLE.
	 * This defines the schema and potentially initializes storage.
	 * @param db The database connection.
	 * @param pAux Client data passed during module registration.
	 * @param moduleName The name the module was registered with.
	 * @param schemaName The name of the database schema (e.g., 'main', 'temp').
	 * @param tableName The name of the virtual table being created.
	 * @param options Module-specific configuration options derived from the USING clause arguments.
	 * @returns The new VirtualTable instance (representing the schema definition).
	 * @throws SqliteError on failure.
	 */
	xCreate(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: TConfig
	): TTable; // Returns the created table instance/definition

	/**
	 * Connect to an existing virtual table definition. Called when the schema is loaded
	 * or a connection needs to interact with the table.
	 * This returns a connection-specific instance.
	 * @param db The database connection.
	 * @param pAux Client data passed during module registration.
	 * @param moduleName The name the module was registered with.
	 * @param schemaName The name of the database schema.
	 * @param tableName The name of the virtual table being connected to.
	 * @param options Module-specific configuration options derived from the original CREATE VIRTUAL TABLE arguments.
	 * @returns The connection-specific VirtualTable instance.
	 * @throws SqliteError on failure.
	 */
	xConnect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: TConfig
	): TTable; // Returns the connection-specific table instance

	/**
	 * Determine the best query plan (index) for a given set of constraints and orderings.
	 * This method MUST be synchronous for performance. It modifies the passed IndexInfo object.
	 * Called by the compiler during query planning.
	 * @param db The database connection (for context, potentially accessing schema).
	 * @param tableInfo The schema information for the specific table instance being planned.
	 * @param indexInfo Input constraints/orderings and output plan details.
	 * @returns StatusCode.OK on success, or an error code.
	 */
	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number; // Sync

	/**
	 * Destroy the underlying persistent representation of the virtual table, if applicable.
	 * Called by DROP TABLE.
	 * @param db The database connection.
	 * @param pAux Client data passed during module registration.
	 * @param moduleName The name the module was registered with.
	 * @param schemaName The name of the database schema.
	 * @param tableName The name of the virtual table being destroyed.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	xDestroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void>;

	/** Optional: Check for shadow table name conflicts (this is usually static per module). */
	xShadowName?(name: string): boolean; // Sync
}

// --- Add Schema Change Info Type --- //
// Keep this here as it's part of the interface contract, even if xAlterSchema moved
/** Defines the structure for schema change information passed to xAlterSchema */
export type SchemaChangeInfo =
	| { type: 'addColumn'; columnDef: ColumnDef }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string };
// ----------------------------------- //
