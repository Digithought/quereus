import type { Database } from '../core/database.js'; // Assuming Database class exists
import type { VirtualTable } from './table.js';
import type { IndexInfo } from './index-info.js';
import type { ColumnDef } from '../parser/ast.js'; // <-- Add parser AST import
import type { TableSchema } from '../schema/table.js'; // Add import for TableSchema

/**
 * Base interface for module-specific configuration passed to xCreate/xConnect.
 * Modules should define their own interface extending this if they need options.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface BaseModuleConfig {}

/**
 * Interface defining the methods for a virtual table module implementation.
 * The module primarily acts as a factory for connection-specific VirtualTable instances.
 *
 * @template TTable The specific type of VirtualTable managed by this module.
 * @template TConfig The type defining module-specific configuration options.
 */
export interface VirtualTableModule<
	TTable extends VirtualTable,
	TConfig extends BaseModuleConfig = BaseModuleConfig
> {

	/**
	 * Creates the persistent definition of a virtual table.
	 * Called by CREATE VIRTUAL TABLE to define schema and initialize storage.
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema (e.g., 'main', 'temp')
	 * @param tableName The name of the virtual table being created
	 * @param options Module-specific configuration options from the USING clause
	 * @returns The new VirtualTable instance
	 * @throws SqliteError on failure
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
	 * Connects to an existing virtual table definition.
	 * Called when the schema is loaded or a connection needs to interact with the table.
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table to connect to
	 * @param options Module-specific configuration options from the original CREATE VIRTUAL TABLE
	 * @returns The connection-specific VirtualTable instance
	 * @throws SqliteError on failure
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
	 * Determines the best query plan for a given set of constraints and orderings.
	 * This method MUST be synchronous for performance. It modifies the passed IndexInfo object.
	 *
	 * @param db The database connection
	 * @param tableInfo The schema information for the table being planned
	 * @param indexInfo Input constraints/orderings and output plan details
	 * @returns StatusCode.OK on success, or an error code
	 */
	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number;

	/**
	 * Destroys the underlying persistent representation of the virtual table.
	 * Called by DROP TABLE.
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table being destroyed
	 * @throws SqliteError on failure
	 */
	xDestroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void>;

	/**
	 * Checks for shadow table name conflicts
	 * @param name The name to check
	 * @returns true if the name would conflict
	 */
	xShadowName?(name: string): boolean;
}

/**
 * Defines the structure for schema change information passed to xAlterSchema
 */
export type SchemaChangeInfo =
	| { type: 'addColumn'; columnDef: ColumnDef }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string };
