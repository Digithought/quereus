import { Schema } from './schema';
import type { Database } from '../core/database'; // Use Database type
import type { TableSchema } from './table';
import type { FunctionSchema } from './function';
import { SqliteError, MisuseError } from '../common/errors';
import { StatusCode } from '../common/constants';
import type { VirtualTableModule } from '../vtab/module';
import type { VirtualTable } from '../vtab/table';
import type { ColumnSchema } from './column';
import { createDefaultColumnSchema } from './column';
import { buildColumnIndexMap, findPrimaryKeyDefinition } from './table';
import { Parser } from '../parser/parser'; // Import the parser
import type * as AST from '../parser/ast'; // Import AST types
import type { ViewSchema } from './view'; // Import ViewSchema
import { SchemaTableModule } from '../vtab/schema-table';
import { SqlDataType } from '../common/types'; // Import SqlDataType

/**
 * Manages all schemas associated with a database connection (main, temp, attached).
 * Handles lookup resolution according to SQLite's rules.
 */
export class SchemaManager {
	private schemas: Map<string, Schema> = new Map();
	private currentSchemaName: string = 'main';
	private modules: Map<string, VirtualTableModule<any, any>> = new Map();
	private defaultVTabModule: string | null = null; // Default module name
	private db: Database; // Reference back to the Database instance

	constructor(db: Database) {
		this.db = db;
		// Ensure 'main' and 'temp' schemas always exist
		this.schemas.set('main', new Schema('main'));
		this.schemas.set('temp', new Schema('temp'));
	}

	/** Sets the current default schema for unqualified names. */
	setCurrentSchema(name: string): void {
		if (this.schemas.has(name.toLowerCase())) {
			this.currentSchemaName = name.toLowerCase();
		} else {
			console.warn(`Attempted to set current schema to non-existent schema: ${name}`);
		}
	}

	/** Gets the name of the current default schema. */
	getCurrentSchemaName(): string {
		return this.currentSchemaName;
	}

	/** Registers a virtual table module. */
	registerModule(name: string, module: VirtualTableModule<any, any>): void {
		const lowerName = name.toLowerCase();
		if (this.modules.has(lowerName)) {
			console.warn(`Replacing existing virtual table module: ${lowerName}`);
		}
		this.modules.set(lowerName, module);
		console.log(`Registered VTab module: ${lowerName}`);
	}

	/** Retrieves a registered virtual table module by name. */
	getModule(name: string): VirtualTableModule<any, any> | undefined {
		return this.modules.get(name.toLowerCase());
	}

	/** Sets the default virtual table module to use when USING is omitted. */
	setDefaultVTabModule(name: string | null): void {
		if (name === null) {
			this.defaultVTabModule = null;
			console.log("Default VTab module cleared.");
			return;
		}
		const lowerName = name.toLowerCase();
		if (this.modules.has(lowerName)) {
			this.defaultVTabModule = lowerName;
			console.log(`Default VTab module set to: ${lowerName}`);
		} else {
			throw new SqliteError(`Cannot set default VTab module: module '${lowerName}' not registered.`);
		}
	}

	/** Gets the currently configured default virtual table module name. */
	getDefaultVTabModuleName(): string | null {
		return this.defaultVTabModule;
	}

	/** Gets a specific schema by name, or undefined if not found. */
	getSchema(name: string): Schema | undefined {
		return this.schemas.get(name.toLowerCase());
	}

	/** Gets the 'main' schema. */
	getMainSchema(): Schema {
		return this.schemas.get('main')!; // Should always exist
	}

	/** Gets the 'temp' schema. */
	getTempSchema(): Schema {
		return this.schemas.get('temp')!; // Should always exist
	}

	/** @internal Returns iterator over managed schemas */
	_getAllSchemas(): IterableIterator<Schema> {
		return this.schemas.values();
	}

	/** Adds a schema (e.g., for ATTACH). Throws if name conflicts. */
	addSchema(name: string): Schema {
		const lowerName = name.toLowerCase();
		if (this.schemas.has(lowerName)) {
			throw new SqliteError(`Schema '${name}' already exists`, StatusCode.ERROR);
		}
		const schema = new Schema(name);
		this.schemas.set(lowerName, schema);
		console.log(`SchemaManager: Added schema '${name}'`);
		return schema;
	}

	/** Removes a schema (e.g., for DETACH). Returns true if found and removed. */
	removeSchema(name: string): boolean {
		const lowerName = name.toLowerCase();
		if (lowerName === 'main' || lowerName === 'temp') {
			throw new SqliteError(`Cannot detach schema '${name}'`, StatusCode.ERROR);
		}
		const schema = this.schemas.get(lowerName);
		if (schema) {
			// TODO: Need to ensure associated VTabs are disconnected/destroyed?
			// This might require iterating tables and calling module methods.
			// For now, just remove the schema container.
			schema.clearFunctions(); // Call function destructors
			schema.clearTables();
			schema.clearViews();
			this.schemas.delete(lowerName);
			console.log(`SchemaManager: Removed schema '${name}'`);
			return true;
		}
		return false;
	}

	/**
	 * @internal Finds a table or virtual table by name across schemas.
	 */
	_findTable(tableName: string, dbName?: string | null): TableSchema | undefined {
		const lowerTableName = tableName.toLowerCase();

		// --- Handle sqlite_schema dynamically ---
		if (lowerTableName === 'sqlite_schema') {
			const moduleInfo = this.db._getVtabModule('sqlite_schema');
			if (!moduleInfo) {
				console.error("sqlite_schema module not registered!");
				return undefined; // Should not happen if registered in Database constructor
			}
			// Dynamically construct the TableSchema for sqlite_schema
			// Use the columns defined statically in the module
			const columns: ColumnSchema[] = SchemaTableModule.COLUMNS.map((col: { name: string; type: SqlDataType; collation?: string }) => ({
				name: col.name,
				affinity: col.type,
				notNull: false,
				primaryKey: false, // sqlite_schema has no explicit PK in this representation
				pkOrder: 0,
				defaultValue: null,
				collation: col.collation ?? 'BINARY', // Ensure collation exists
				hidden: false,
				generated: false,
			}));
			// Convert the static record into a ReadonlyMap
			const columnIndexMap = new Map<string, number>(Object.entries(SchemaTableModule.COLUMN_INDEX_MAP));

			// Define checkConstraints explicitly as required by TableSchema - Removed intermediate variable
			// const checkConstraints: ReadonlyArray<{ name?: string, expr: AST.Expression }> = [];

			return {
				name: 'sqlite_schema',
				schemaName: 'main', // Belongs conceptually to main
				columns: Object.freeze(columns),
				columnIndexMap: Object.freeze(columnIndexMap),
				primaryKeyDefinition: [], // No explicit PK
				checkConstraints: Object.freeze([] as ReadonlyArray<{ name?: string, expr: AST.Expression }>), // Define inline, typed, and frozen
				isVirtual: true,
				vtabModule: moduleInfo.module,
				vtabInstance: undefined, // Instance created via xConnect
				vtabAuxData: moduleInfo.auxData,
				vtabArgs: [], // No creation args
				vtabModuleName: 'sqlite_schema',
				// Add missing properties
				isWithoutRowid: false,
				isStrict: false,
				isView: false,
			} satisfies TableSchema; // Use 'satisfies' for type checking without changing type
		}
		// --------------------------------------

		if (dbName) {
			// Search specific schema
			const schema = this.schemas.get(dbName.toLowerCase());
			return schema?.getTable(lowerTableName);
		} else {
			// Search order: main, then temp (and attached later)
			const mainSchema = this.schemas.get('main');
			let table = mainSchema?.getTable(lowerTableName);
			if (table) return table;

			const tempSchema = this.schemas.get('temp');
			table = tempSchema?.getTable(lowerTableName);
			return table; // Return temp table if found, otherwise undefined
		}
	}

	/**
	 * Finds a table by name, searching schemas according to SQLite rules.
	 * If dbName is provided, searches only that schema.
	 * Otherwise, searches current (usually 'main'), then 'temp'.
	 * (Note: Attach search order would be added later if needed).
	 * @param tableName Name of the table.
	 * @param dbName Optional specific schema name to search.
	 * @returns The TableSchema or undefined if not found.
	 */
	findTable(tableName: string, dbName?: string | null): TableSchema | undefined {
		return this._findTable(tableName, dbName);
	}

	/**
	* Finds a function by name and arg count, searching schemas.
	* SQLite looks in the connection-global space first, then potentially schema-specific?
	* For now, let's assume functions are global across the connection (simpler).
	* We'll register them on the 'main' schema internally, but lookup won't require schema name.
	* @param funcName Name of the function.
	* @param nArg Number of arguments.
	* @returns The FunctionSchema or undefined if not found.
	*/
	findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		// Simplified: Assume functions are connection-global for now
		// Look up in the 'main' schema where we store them
		return this.getMainSchema().getFunction(funcName, nArg);
	}

	/**
	 * Declares a virtual table's schema based on a CREATE VIRTUAL TABLE string.
	 * This is intended to be called from VTab `xCreate`/`xConnect` methods.
	 * @param schemaName The schema the table belongs to ('main', 'temp', etc.)
	 * @param createTableSql The full `CREATE VIRTUAL TABLE ...` string.
	 * @param associatedVtab The VirtualTable instance to link.
	 * @param auxData The auxData associated with the module registration.
	 * @returns The created TableSchema.
	 * @throws SqliteError on parsing or definition errors.
	 */
	declareVtab(
		schemaName: string,
		createTableSql: string, // Expecting full CREATE TABLE statement
		associatedVtab: VirtualTable,
		auxData?: unknown,
		// vtabArgs are now parsed from the SQL
	): TableSchema {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) {
			throw new SqliteError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}

		console.log(`SchemaManager: Declaring VTab in '${schemaName}' using SQL: ${createTableSql}`);

		// --- Use the Parser ---
		let createVtabAst: AST.CreateTableStmt;
		try {
			const parser = new Parser();
			const ast = parser.parse(createTableSql);
			if (ast.type !== 'createTable') {
				throw new SqliteError(`Expected CREATE TABLE statement, got ${ast.type}`, StatusCode.ERROR);
			}
			createVtabAst = ast as AST.CreateTableStmt;
		} catch (e: any) {
			throw new SqliteError(`Failed to parse CREATE TABLE statement: ${e.message}`, StatusCode.ERROR);
		}

		const tableName = createVtabAst.table.name;
		const vtabArgs = createVtabAst.moduleArgs; // Get args from AST

		if (schema.getTable(tableName)) {
			// Handle IF NOT EXISTS
			if (createVtabAst.ifNotExists) {
				console.log(`SchemaManager: VTab ${tableName} already exists in schema ${schemaName}, skipping creation (IF NOT EXISTS).`);
				// Return existing schema? Or should xCreate/xConnect handle this?
				// For now, let's return the existing one, assuming xConnect logic handles it.
				return schema.getTable(tableName)!;
			}
			throw new SqliteError(`Table ${tableName} already exists in schema ${schemaName}`, StatusCode.ERROR);
		}

		// --- Simplified Column Definition (Placeholder) ---
		// A robust implementation requires the module to provide its schema definition,
		// often by parsing the arguments passed (vtabArgs) or having a predefined structure.
		// The `CREATE VIRTUAL TABLE` statement itself doesn't define columns directly.
		// For now, we create a placeholder schema. Modules like MemoryTable will
		// override this with their actual columns during their setup.
		console.warn(`SchemaManager.declareVtab: Using placeholder column definition for ${tableName}. VTab module should define actual columns.`);
		const placeholderColumns: ColumnSchema[] = [
			createDefaultColumnSchema('column1'),
			createDefaultColumnSchema('column2')
		];
		// --- End Simplified Column Definition ---

		const tableSchema: TableSchema = {
			name: tableName,
			schemaName: schema.name,
			checkConstraints: [],
			columns: Object.freeze(placeholderColumns),
			columnIndexMap: Object.freeze(buildColumnIndexMap(placeholderColumns)),
			primaryKeyDefinition: Object.freeze(findPrimaryKeyDefinition(placeholderColumns)), // Use helper
			isVirtual: true,
			vtabModule: associatedVtab.module,
			vtabInstance: associatedVtab,
			vtabAuxData: auxData,
			vtabArgs: Object.freeze(vtabArgs || []), // Use parsed args
			// Store the registered module name used in the CREATE stmt
			vtabModuleName: createVtabAst.moduleName,
			// Add missing properties
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		};

		schema.addTable(tableSchema);
		return tableSchema;
	}

	/**
	 * Retrieves a view schema definition.
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema.
	 * @param viewName The name of the view.
	 * @returns The ViewSchema or undefined if not found.
	 */
	getView(schemaName: string | null, viewName: string): ViewSchema | undefined { // NEW METHOD
		const targetSchemaName = schemaName ?? this.currentSchemaName;
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getView(viewName);
	}

	/**
	 * Retrieves any schema item (table or view) by name. Checks views first.
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema.
	 * @param itemName The name of the table or view.
	 * @returns The TableSchema or ViewSchema, or undefined if not found.
	 */
	getSchemaItem(schemaName: string | null, itemName: string): TableSchema | ViewSchema | undefined { // UPDATED METHOD
		const targetSchemaName = schemaName ?? this.currentSchemaName;
		const schema = this.schemas.get(targetSchemaName);
		if (!schema) return undefined;
		// Prioritize views over tables if names conflict (consistent with some DBs)
		const view = schema.getView(itemName);
		if (view) return view;
		return schema.getTable(itemName);
	}

	/**
	 * Drops a table from the specified schema.
	 * @param schemaName The name of the schema.
	 * @param tableName The name of the table to drop.
	 * @returns True if the table was found and dropped, false otherwise.
	 */
	dropTable(schemaName: string, tableName: string): boolean {
		const schema = this.schemas.get(schemaName);
		if (!schema) return false;

		// Find the table first to potentially call vtab->xDestroy
		const tableSchema = schema.getTable(tableName);
		let destroyPromise: Promise<void> | null = null;
		if (tableSchema?.isVirtual && tableSchema.vtabInstance && tableSchema.vtabModule?.xDestroy) {
			console.log(`Calling xDestroy for VTab ${schemaName}.${tableName}`);
			destroyPromise = tableSchema.vtabModule.xDestroy(tableSchema.vtabInstance).catch(err => {
				console.error(`Error during VTab xDestroy for ${schemaName}.${tableName}:`, err);
				// Decide whether to proceed with schema removal despite xDestroy error
			});
		}

		// Remove from schema map immediately
		const removed = schema.removeTable(tableName);

		// Await destruction if needed *after* removing from schema map
		// Consider the implications if xDestroy fails - the schema entry is gone.
		if (destroyPromise) {
			// We don't await here directly to avoid blocking, but maybe should?
			destroyPromise.then(() => console.log(`xDestroy completed for VTab ${schemaName}.${tableName}`));
		}

		return removed;
	}

	/**
	 * Drops a view from the specified schema.
	 * @param schemaName The name of the schema.
	 * @param viewName The name of the view to drop.
	 * @returns True if the view was found and dropped, false otherwise.
	 */
	dropView(schemaName: string, viewName: string): boolean { // NEW METHOD
		const schema = this.schemas.get(schemaName);
		if (!schema) return false;
		return schema.removeView(viewName);
	}

	/** Clears all schema items (tables, functions, views) */
	clearAll(): void { // UPDATED METHOD
		this.schemas.forEach(schema => {
			// Call clearTables which might handle VTab disconnect later?
			// For now, just clear maps. VTab disconnect happens at DB close.
			schema.clearTables();
			schema.clearFunctions(); // Calls destructors
			schema.clearViews();
		});
		// Optionally re-initialize built-ins? Or assume they are added again externally.
		console.log("SchemaManager: Cleared all schemas.");
	}

	/**
	 * Retrieves a schema object, throwing if it doesn't exist.
	 * @param name Schema name ('main', 'temp', or custom). Case-insensitive.
	 * @returns The Schema object.
	 * @throws SqliteError if the schema does not exist.
	 */
	getSchemaOrFail(name: string): Schema {
		const schema = this.schemas.get(name.toLowerCase());
		if (!schema) {
			throw new SqliteError(`Schema not found: ${name}`);
		}
		return schema;
	}

	/**
	 * Retrieves a table from the specified schema.
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema.
	 * @param tableName The name of the table.
	 * @returns The TableSchema or undefined if not found.
	 */
	getTable(schemaName: string | null, tableName: string): TableSchema | undefined {
		const targetSchemaName = schemaName ?? this.currentSchemaName;
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getTable(tableName);
	}
}
