import { Schema } from './schema.js';
import type { Database } from '../core/database.js';
import type { TableSchema } from './table.js';
import type { FunctionSchema } from './function.js';
import { QuereusError, MisuseError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { VirtualTableModule } from '../vtab/module.js';
import type { VirtualTable } from '../vtab/table.js';
import type { ColumnSchema } from './column.js';
import { createDefaultColumnSchema } from './column.js';
import { buildColumnIndexMap, findPrimaryKeyDefinition } from './table.js';
import { Parser } from '../parser/parser.js';
import type * as AST from '../parser/ast.js';
import type { ViewSchema } from './view.js';
import { SchemaTableModule } from '../vtab/schema/table.js';
import { SqlDataType } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import type { BaseModuleConfig } from '../vtab/module.js';
import { opsToMask, type RowOpMask } from './table.js';

const log = createLogger('schema:manager');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log;

/**
 * Generic options passed to VTab modules during CREATE TABLE.
 * Modules are responsible for interpreting these.
 */
export interface GenericModuleCallOptions extends BaseModuleConfig {
	moduleArgs?: readonly string[];
	statementColumns?: readonly AST.ColumnDef[];
	statementConstraints?: readonly AST.TableConstraint[];
	withoutRowid?: boolean;
	isTemporary?: boolean;
}

/**
 * Manages all schemas associated with a database connection (main, temp, attached).
 * Handles lookup resolution according to SQLite's rules.
 */
export class SchemaManager {
	private schemas: Map<string, Schema> = new Map();
	private currentSchemaName: string = 'main';
	private modules: Map<string, { module: VirtualTableModule<any, any>, auxData?: unknown }> = new Map();
	private defaultVTabModuleName: string = 'memory';
	private defaultVTabModuleArgs: string[] = [];
	private db: Database;

	/**
	 * Creates a new schema manager
	 *
	 * @param db Reference to the parent Database instance
	 */
	constructor(db: Database) {
		this.db = db;
		// Ensure 'main' and 'temp' schemas always exist
		this.schemas.set('main', new Schema('main'));
		this.schemas.set('temp', new Schema('temp'));
	}

	/**
	 * Sets the current default schema for unqualified names
	 *
	 * @param name Schema name to set as current
	 */
	setCurrentSchema(name: string): void {
		if (this.schemas.has(name.toLowerCase())) {
			this.currentSchemaName = name.toLowerCase();
		} else {
			warnLog(`Attempted to set current schema to non-existent schema: %s`, name);
		}
	}

	/**
	 * Gets the name of the current default schema
	 *
	 * @returns Current schema name
	 */
	getCurrentSchemaName(): string {
		return this.currentSchemaName;
	}

	/**
	 * Registers a virtual table module
	 *
	 * @param name Module name
	 * @param module Module implementation
	 * @param auxData Optional client data associated with the module registration
	 */
	registerModule(name: string, module: VirtualTableModule<any, any>, auxData?: unknown): void {
		const lowerName = name.toLowerCase();
		if (this.modules.has(lowerName)) {
			warnLog(`Replacing existing virtual table module: %s`, lowerName);
		}
		this.modules.set(lowerName, { module, auxData });
		log(`Registered VTab module: %s`, lowerName);
	}

	/**
	 * Retrieves a registered virtual table module by name
	 *
	 * @param name Module name to look up
	 * @returns The module and its auxData, or undefined if not found
	 */
	getModule(name: string): { module: VirtualTableModule<any, any>, auxData?: unknown } | undefined {
		return this.modules.get(name.toLowerCase());
	}

	/**
	 * Sets the default virtual table module to use when USING is omitted
	 *
	 * @param name Module name. Must be a registered module.
	 * @throws QuereusError if the module name is not registered
	 */
	setDefaultVTabModuleName(name: string): void {
		const lowerName = name.toLowerCase();
		if (this.modules.has(lowerName)) {
			this.defaultVTabModuleName = lowerName;
			log(`Default VTab module name set to: %s`, lowerName);
		} else {
			warnLog(`Setting default VTab module to \'${lowerName}\', which is not currently registered in SchemaManager. Ensure it gets registered.`);
			this.defaultVTabModuleName = lowerName;
		}
	}

	/**
	 * Gets the currently configured default virtual table module name
	 *
	 * @returns The default module name
	 */
	getDefaultVTabModuleName(): string {
		return this.defaultVTabModuleName;
	}

	/** @internal Sets the default VTab args directly */
	setDefaultVTabArgs(args: string[]): void {
		this.defaultVTabModuleArgs = [...args];
		log('Default VTab module args set to: %o', args);
	}

	/** @internal Sets the default VTab args by parsing a JSON string */
	setDefaultVTabArgsFromJson(argsJsonString: string): void {
		try {
			const parsedArgs = JSON.parse(argsJsonString);
			if (!Array.isArray(parsedArgs) || !parsedArgs.every(arg => typeof arg === 'string')) {
				throw new Error("JSON value must be an array of strings.");
			}
			this.setDefaultVTabArgs(parsedArgs);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Invalid JSON for default_vtab_args: ${msg}`, StatusCode.ERROR);
		}
	}

	/**
	 * Gets the default virtual table module arguments.
	 * @returns A copy of the default arguments array.
	 */
	getDefaultVTabArgs(): string[] {
		return [...this.defaultVTabModuleArgs];
	}

	/**
	 * Gets the default virtual table module name and arguments.
	 * @returns An object containing the module name and arguments.
	 */
	getDefaultVTabModule(): { name: string; args: string[] } {
		return {
			name: this.defaultVTabModuleName,
			args: [...this.defaultVTabModuleArgs],
		};
	}

	/**
	 * Gets a specific schema by name
	 *
	 * @param name Schema name to retrieve
	 * @returns The schema or undefined if not found
	 */
	getSchema(name: string): Schema | undefined {
		return this.schemas.get(name.toLowerCase());
	}

	/**
	 * Gets the 'main' schema
	 *
	 * @returns The main schema
	 */
	getMainSchema(): Schema {
		return this.schemas.get('main')!;
	}

	/**
	 * Gets the 'temp' schema
	 *
	 * @returns The temp schema
	 */
	getTempSchema(): Schema {
		return this.schemas.get('temp')!;
	}

	/**
	 * @internal Returns iterator over all managed schemas
	 */
	_getAllSchemas(): IterableIterator<Schema> {
		return this.schemas.values();
	}

	/**
	 * Adds a new schema (e.g., for ATTACH)
	 *
	 * @param name Name of the schema to add
	 * @returns The newly created schema
	 * @throws QuereusError if the name conflicts with an existing schema
	 */
	addSchema(name: string): Schema {
		const lowerName = name.toLowerCase();
		if (this.schemas.has(lowerName)) {
			throw new QuereusError(`Schema '${name}' already exists`, StatusCode.ERROR);
		}
		const schema = new Schema(name);
		this.schemas.set(lowerName, schema);
		log(`Added schema '%s'`, name);
		return schema;
	}

	/**
	 * Removes a schema (e.g., for DETACH)
	 *
	 * @param name Name of the schema to remove
	 * @returns true if found and removed, false otherwise
	 * @throws QuereusError if attempting to remove 'main' or 'temp'
	 */
	removeSchema(name: string): boolean {
		const lowerName = name.toLowerCase();
		if (lowerName === 'main' || lowerName === 'temp') {
			throw new QuereusError(`Cannot detach schema '${name}'`, StatusCode.ERROR);
		}
		const schema = this.schemas.get(lowerName);
		if (schema) {
			schema.clearFunctions();
			schema.clearTables();
			schema.clearViews();
			this.schemas.delete(lowerName);
			log(`Removed schema '%s'`, name);
			return true;
		}
		return false;
	}

	/**
	 * @internal Finds a table or virtual table by name across schemas
	 */
	_findTable(tableName: string, dbName?: string): TableSchema | undefined {
		const lowerTableName = tableName.toLowerCase();

		// Handle _schema dynamically
		if (lowerTableName === '_schema') {
			const moduleInfo = this.getModule('_schema');
			if (!moduleInfo || !moduleInfo.module) {
				errorLog("_schema module not registered or module structure invalid!");
				return undefined;
			}

			const columns: ColumnSchema[] = SchemaTableModule.COLUMNS.map((col: { name: string; type: SqlDataType; collation?: string }) => ({
				name: col.name,
				affinity: col.type,
				notNull: false,
				primaryKey: false,
				pkOrder: 0,
				defaultValue: null,
				collation: col.collation ?? 'BINARY',
				hidden: false,
				generated: false,
			}));

			const columnIndexMap = new Map<string, number>(Object.entries(SchemaTableModule.COLUMN_INDEX_MAP));

			return {
				name: '_schema',
				schemaName: 'main',
				columns: Object.freeze(columns),
				columnIndexMap: Object.freeze(columnIndexMap),
				primaryKeyDefinition: [],
				checkConstraints: Object.freeze([] as ReadonlyArray<{ name?: string, expr: AST.Expression }>),
				vtabModule: moduleInfo.module,
				vtabAuxData: moduleInfo.auxData,
				vtabArgs: [],
				vtabModuleName: '_schema',
				isWithoutRowid: false,
				isStrict: false,
				isView: false,
			} satisfies TableSchema;
		}

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
			return table;
		}
	}

	/**
	 * Finds a table by name, searching schemas according to SQLite rules
	 *
	 * @param tableName Name of the table
	 * @param dbName Optional specific schema name to search
	 * @returns The TableSchema or undefined if not found
	 */
	findTable(tableName: string, dbName?: string): TableSchema | undefined {
		return this._findTable(tableName, dbName);
	}

	/**
	 * Finds a function by name and arg count, searching schemas
	 *
	 * @param funcName Name of the function
	 * @param nArg Number of arguments
	 * @returns The FunctionSchema or undefined if not found
	 */
	findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		return this.getMainSchema().getFunction(funcName, nArg);
	}

	/**
	 * Declares a virtual table's schema based on a CREATE VIRTUAL TABLE string
	 * This is intended to be called from VTab `xCreate`/`xConnect` methods
	 *
	 * @param schemaName The schema the table belongs to ('main', 'temp', etc.)
	 * @param createTableSql The full `CREATE VIRTUAL TABLE ...` string
	 * @param associatedVtab The VirtualTable instance to link
	 * @param auxData The auxData associated with the module registration
	 * @returns The created TableSchema
	 * @throws QuereusError on parsing or definition errors
	 */
	declareVtab(
		schemaName: string,
		createTableSql: string,
		associatedVtab: VirtualTable,
		auxData?: unknown,
	): TableSchema {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) {
			throw new QuereusError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}

		log(`Declaring VTab in '%s' using SQL: %s`, schemaName, createTableSql);

		// Parse the CREATE TABLE statement
		let createVtabAst: AST.CreateTableStmt;
		try {
			const parser = new Parser();
			const ast = parser.parse(createTableSql);
			if (ast.type !== 'createTable') {
				throw new QuereusError(`Expected CREATE TABLE statement, got ${ast.type}`, StatusCode.ERROR);
			}
			createVtabAst = ast as AST.CreateTableStmt;
		} catch (e: any) {
			throw new QuereusError(`Failed to parse CREATE TABLE statement: ${e.message}`, StatusCode.ERROR);
		}

		const tableName = createVtabAst.table.name;
		const vtabArgs = createVtabAst.moduleArgs;

		if (schema.getTable(tableName)) {
			// Handle IF NOT EXISTS
			if (createVtabAst.ifNotExists) {
				log(`VTab %s already exists in schema %s, skipping creation (IF NOT EXISTS).`, tableName, schemaName);
				return schema.getTable(tableName)!;
			}
			throw new QuereusError(`Table ${tableName} already exists in schema ${schemaName}`, StatusCode.ERROR);
		}

		// Create placeholder schema - modules should override with actual columns
		warnLog(`declareVtab: Using placeholder column definition for %s. VTab module should define actual columns.`, tableName);
		const placeholderColumns: ColumnSchema[] = [
			createDefaultColumnSchema('column1'),
			createDefaultColumnSchema('column2')
		];

		const vtabModuleNameAssigned = createVtabAst.moduleName ?? this.defaultVTabModuleName;

		const moduleRegistration = this.getModule(vtabModuleNameAssigned);
		const resolvedAuxData = moduleRegistration ? moduleRegistration.auxData : undefined;

		if (!moduleRegistration) {
			warnLog(`VTab module '${vtabModuleNameAssigned}' not found in SchemaManager during declareVtab for table '${tableName}'. This might lead to issues if auxData is expected.`);
		}

		const tableSchema: TableSchema = {
			name: tableName,
			schemaName: schema.name,
			checkConstraints: [],
			columns: Object.freeze(placeholderColumns),
			columnIndexMap: Object.freeze(buildColumnIndexMap(placeholderColumns)),
			primaryKeyDefinition: Object.freeze(findPrimaryKeyDefinition(placeholderColumns)),
			vtabModule: associatedVtab.module,
			vtabAuxData: resolvedAuxData,
			vtabArgs: Object.freeze(vtabArgs || []),
			vtabModuleName: vtabModuleNameAssigned,
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		};

		schema.addTable(tableSchema);
		return tableSchema;
	}

	/**
	 * Retrieves a view schema definition
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param viewName The name of the view
	 * @returns The ViewSchema or undefined if not found
	 */
	getView(schemaName: string | null, viewName: string): ViewSchema | undefined {
		const targetSchemaName = schemaName ?? this.currentSchemaName;
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getView(viewName);
	}

	/**
	 * Retrieves any schema item (table or view) by name. Checks views first
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param itemName The name of the table or view
	 * @returns The TableSchema or ViewSchema, or undefined if not found
	 */
	getSchemaItem(schemaName: string | null, itemName: string): TableSchema | ViewSchema | undefined {
		const targetSchemaName = schemaName ?? this.currentSchemaName;
		const schema = this.schemas.get(targetSchemaName);
		if (!schema) return undefined;

		// Prioritize views over tables if names conflict
		const view = schema.getView(itemName);
		if (view) return view;
		return schema.getTable(itemName);
	}

	/**
	 * Drops a table from the specified schema
	 *
	 * @param schemaName The name of the schema
	 * @param tableName The name of the table to drop
	 * @param ifExists If true, do not throw an error if the table does not exist.
	 * @returns True if the table was found and dropped, false otherwise.
	 */
	dropTable(schemaName: string, tableName: string, ifExists: boolean = false): boolean {
		const schema = this.schemas.get(schemaName.toLowerCase()); // Ensure schemaName is lowercased for lookup
		if (!schema) {
			if (ifExists) return false; // Schema not found, but IF EXISTS specified
			throw new QuereusError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}

		const tableSchema = schema.getTable(tableName); // getTable should handle case-insensitivity

		if (!tableSchema) {
			if (ifExists) {
				log(`Table %s.%s not found, but IF EXISTS was specified.`, schemaName, tableName);
				return false; // Not found, but IF EXISTS means no error, not dropped.
			}
			throw new QuereusError(`Table ${tableName} not found in schema ${schemaName}`, StatusCode.NOTFOUND);
		}

		let destroyPromise: Promise<void> | null = null;

		// Call xDestroy on the module, providing table details
		if (tableSchema.vtabModuleName) { // tableSchema is guaranteed to be defined here
			const moduleRegistration = this.getModule(tableSchema.vtabModuleName);
			if (moduleRegistration && moduleRegistration.module && moduleRegistration.module.xDestroy) {
				log(`Calling xDestroy for VTab %s.%s via module %s`, schemaName, tableName, tableSchema.vtabModuleName);
				destroyPromise = moduleRegistration.module.xDestroy(
					this.db,
					moduleRegistration.auxData,
					tableSchema.vtabModuleName,
					schemaName,
					tableName
				).catch(err => {
					errorLog(`Error during VTab module xDestroy for %s.%s: %O`, schemaName, tableName, err);
					// Potentially re-throw or handle as a critical error if xDestroy failure is problematic
				});
			} else {
				warnLog(`VTab module %s (for table %s.%s) or its xDestroy method not found during dropTable.`, tableSchema.vtabModuleName, schemaName, tableName);
			}
		}

		// Remove from schema map immediately
		const removed = schema.removeTable(tableName);
		if (!removed && !ifExists) {
			// This should ideally not be reached if tableSchema was found above.
			// But as a safeguard if removeTable could fail for other reasons.
			throw new QuereusError(`Failed to remove table ${tableName} from schema ${schemaName}, though it was initially found.`, StatusCode.INTERNAL);
		}

		// Process destruction asynchronously
		if (destroyPromise) {
			destroyPromise.then(() => log(`xDestroy completed for VTab %s.%s`, schemaName, tableName));
		}

		return removed; // True if removed from schema, false if not found and ifExists was true.
	}

	/**
	 * Drops a view from the specified schema
	 *
	 * @param schemaName The name of the schema
	 * @param viewName The name of the view to drop
	 * @returns True if the view was found and dropped, false otherwise
	 */
	dropView(schemaName: string, viewName: string): boolean {
		const schema = this.schemas.get(schemaName);
		if (!schema) return false;
		return schema.removeView(viewName);
	}

	/**
	 * Clears all schema items (tables, functions, views)
	 */
	clearAll(): void {
		this.schemas.forEach(schema => {
			schema.clearTables();
			schema.clearFunctions();
			schema.clearViews();
		});
		log("Cleared all schemas.");
	}

	/**
	 * Retrieves a schema object, throwing if it doesn't exist
	 *
	 * @param name Schema name ('main', 'temp', or custom). Case-insensitive
	 * @returns The Schema object
	 * @throws QuereusError if the schema does not exist
	 */
	getSchemaOrFail(name: string): Schema {
		const schema = this.schemas.get(name.toLowerCase());
		if (!schema) {
			throw new QuereusError(`Schema not found: ${name}`);
		}
		return schema;
	}

	/**
	 * Retrieves a table from the specified schema
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param tableName The name of the table
	 * @returns The TableSchema or undefined if not found
	 */
	getTable(schemaName: string | undefined, tableName: string): TableSchema | undefined {
		const targetSchemaName = schemaName ?? this.currentSchemaName;
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getTable(tableName);
	}

	/**
	 * Defines a new table in the schema based on an AST.CreateTableStmt.
	 * This method encapsulates the logic for interacting with VTab modules (xCreate)
	 * and registering the new table schema.
	 *
	 * @param stmt The AST node for the CREATE TABLE statement.
	 * @returns A Promise that resolves to the created TableSchema.
	 * @throws QuereusError on errors (e.g., module not found, xCreate fails, table exists).
	 */
	async createTable(stmt: AST.CreateTableStmt): Promise<TableSchema> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;
		let moduleName: string;
		let effectiveModuleArgs: readonly string[];

		if (stmt.moduleName) {
			moduleName = stmt.moduleName;
			effectiveModuleArgs = Object.freeze(stmt.moduleArgs || []);
		} else {
			const defaultVtab = this.getDefaultVTabModule();
			moduleName = defaultVtab.name;
			effectiveModuleArgs = Object.freeze(defaultVtab.args || []);
		}

		const moduleInfo = this.getModule(moduleName);
		if (!moduleInfo || !moduleInfo.module) { // Ensure moduleInfo.module exists
			throw new QuereusError(`No virtual table module named '${moduleName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		const moduleCallOpts: GenericModuleCallOptions = {
			moduleArgs: effectiveModuleArgs,
			statementColumns: stmt.columns ? Object.freeze([...stmt.columns]) : undefined,
			statementConstraints: stmt.constraints ? Object.freeze([...stmt.constraints]) : undefined,
			withoutRowid: stmt.withoutRowid,
			isTemporary: stmt.isTemporary,
		};

		let tableInstance: VirtualTable;
		try {
			tableInstance = moduleInfo.module.xCreate(
				this.db, // Pass the Database instance stored in SchemaManager
				moduleInfo.auxData,
				moduleName,
				targetSchemaName,
				tableName,
				moduleCallOpts
			);
		} catch (e: any) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`Module '${moduleName}' xCreate failed for table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		const schema = this.getSchema(targetSchemaName);
		if (!schema) {
			// This case should ideally not happen if getCurrentSchemaName() is robust
			// and addSchema is used for any non-main/temp schemas.
			throw new QuereusError(`Internal error: Schema '${targetSchemaName}' not found during CREATE TABLE.`, StatusCode.INTERNAL);
		}

		if (schema.getTable(tableName)) {
			if (stmt.ifNotExists) {
				log(`Skipping CREATE TABLE: Table %s.%s already exists (IF NOT EXISTS).`, targetSchemaName, tableName);
				// Return the existing table schema if IF NOT EXISTS is used and table exists
				return schema.getTable(tableName)!;
			} else {
				throw new QuereusError(`Table ${targetSchemaName}.${tableName} already exists`, StatusCode.CONSTRAINT, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
			}
		}

		if (!tableInstance.tableSchema) {
			throw new QuereusError(`Module '${moduleName}' xCreate did not provide a tableSchema for '${tableName}'.`, StatusCode.INTERNAL);
		}

		// Ensure essential fields in the returned TableSchema are consistent
		const finalTableSchema = tableInstance.tableSchema as any; // Modifiable reference
		finalTableSchema.schemaName = targetSchemaName;
		finalTableSchema.vtabModuleName = moduleName;
		finalTableSchema.vtabArgs = effectiveModuleArgs;
		if (finalTableSchema.estimatedRows === undefined) {
			finalTableSchema.estimatedRows = BigInt(10_000);
		}
		// Ensure `name` from AST is respected, even if module provides a different one in its schema
		finalTableSchema.name = tableName;

		schema.addTable(finalTableSchema as TableSchema);
		log(`Successfully created table %s.%s using module %s`, targetSchemaName, tableName, moduleName);
		return finalTableSchema as TableSchema;
	}
}
