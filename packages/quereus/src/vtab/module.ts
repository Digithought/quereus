import type { Database } from '../core/database.js'; // Assuming Database class exists
import type { VirtualTable } from './table.js';

import type { ColumnDef, Expression } from '../parser/ast.js'; // <-- Add parser AST import
import type { TableSchema, IndexSchema } from '../schema/table.js'; // Add import for TableSchema and IndexSchema
import type { BestAccessPlanRequest, BestAccessPlanResult } from './best-access-plan.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { ModuleCapabilities } from './capabilities.js';

/**
 * Base interface for module-specific configuration passed to create/connect.
 * Modules should define their own interface extending this if they need options.
 */
export interface BaseModuleConfig {
	/** When true, the module should provide read-only access to the committed (pre-transaction) state */
	_readCommitted?: boolean;
}

/**
 * Assessment result from a module's supports() method indicating
 * whether it can execute a plan subtree and at what cost.
 */
export interface SupportAssessment {
	/** Estimated cost comparable to local evaluation cost */
	cost: number;
	/** Optional context data persisted for the emitter */
	ctx?: unknown;
}

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
	 * This method is async to allow modules to perform storage initialization
	 * (e.g., creating IndexedDB object stores) before returning. This ensures
	 * the table's storage is ready before any schema change events are processed.
	 *
	 * @param db The database connection
	 * @param tableSchema The schema definition for the table being created
	 * @returns Promise resolving to the new VirtualTable instance
	 * @throws QuereusError on failure
	 */
	create(
		db: Database,
		tableSchema: TableSchema,
	): Promise<TTable>;

	/**
	 * Connects to an existing virtual table definition.
	 * Called when the schema is loaded or a connection needs to interact with the table.
	 *
	 * This method is async to allow modules to perform async initialization when connecting
	 * to existing tables (e.g., opening IndexedDB transactions, loading metadata).
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table to connect to
	 * @param options Module-specific configuration options from the original CREATE VIRTUAL TABLE
	 * @param tableSchema Optional table schema when connecting during import (columns, PK, etc.)
	 * @returns Promise resolving to the connection-specific VirtualTable instance
	 * @throws QuereusError on failure
	 */
	connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: TConfig,
		tableSchema?: TableSchema
	): Promise<TTable>;

	/**
	 * Determines if this module can execute a plan subtree starting at the given node.
	 * Used for query push-down to virtual table modules that support arbitrary queries.
	 *
	 * @param node The root node of the subtree to evaluate
	 * @returns Assessment with cost and optional context, or undefined if not supported
	 */
	supports?(
		node: PlanNode
	): SupportAssessment | undefined;

	/**
	 * Modern, type-safe access planning interface.
	 * Preferred over xBestIndex for new implementations.
	 *
	 * @param db The database connection
	 * @param tableInfo The schema information for the table being planned
	 * @param request Planning request with constraints and requirements
	 * @returns Access plan result describing the chosen strategy
	 */
	getBestAccessPlan?(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult;

	/**
	 * Destroys the underlying persistent representation of the virtual table.
	 * Called by DROP TABLE.
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table being destroyed
	 * @throws QuereusError on failure
	 */
	destroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void>;

	/**
	 * Creates an index on a virtual table.
	 * Called by CREATE INDEX.
	 *
	 * @param db The database connection
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table
	 * @param indexSchema The schema definition for the index being created
	 * @throws QuereusError on failure
	 */
	createIndex?(
		db: Database,
		schemaName: string,
		tableName: string,
		indexSchema: IndexSchema
	): Promise<void>;

	/**
	 * Drops an index from a virtual table.
	 * Called by DROP INDEX.
	 *
	 * @param db The database connection
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table that owns the index
	 * @param indexName The name of the index to drop
	 * @throws QuereusError on failure
	 */
	dropIndex?(
		db: Database,
		schemaName: string,
		tableName: string,
		indexName: string
	): Promise<void>;

	/**
	 * Checks for shadow table name conflicts
	 * @param name The name to check
	 * @returns true if the name would conflict
	 */
	shadowName?(name: string): boolean;

	/**
	 * Returns capability flags for this module.
	 * Used for runtime capability discovery.
	 */
	getCapabilities?(): ModuleCapabilities;

	/**
	 * Alter an existing table's structure. Called by ALTER TABLE for
	 * data-affecting changes (ADD COLUMN, DROP COLUMN, RENAME COLUMN).
	 * RENAME TABLE is schema-only and does not call this method.
	 *
	 * Returns the updated TableSchema after the operation. The engine
	 * registers this in the schema catalog.
	 *
	 * If not implemented, the engine rejects data-affecting ALTER operations.
	 */
	alterTable?(
		db: Database,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
	): Promise<TableSchema>;
}

/**
 * Defines the structure for schema change information passed to xAlterSchema
 */
export type SchemaChangeInfo =
	| { type: 'addColumn'; columnDef: ColumnDef }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string; newColumnDefAst?: ColumnDef }
	| { type: 'alterPrimaryKey'; newPkColumns: ReadonlyArray<{ index: number; desc: boolean }> }
	| {
		/**
		 * ALTER COLUMN with exactly one attribute change.
		 *
		 * Module contract:
		 *   - setNotNull=true with rows containing NULL → throw CONSTRAINT.
		 *     If a DEFAULT is currently set on the column, the module should
		 *     first backfill NULL values with the default and then tighten.
		 *   - setDataType: schema-only if physical type unchanged; otherwise the
		 *     module must convert each row and throw MISMATCH on loss (narrowing,
		 *     NaN, overflow).
		 *   - setDefault / drop default: schema-only. New inserts pick up the
		 *     new default; existing rows are untouched.
		 */
		type: 'alterColumn';
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: Expression | null;
	};

/**
 * Type alias for the common usage pattern where specific table and config types are not known.
 * Use this for storage scenarios like the SchemaManager where modules of different types are stored together.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyVirtualTableModule = VirtualTableModule<any, any>;
