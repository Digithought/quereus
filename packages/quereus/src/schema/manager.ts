import { Schema } from './schema.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import type { Database } from '../core/database.js';
import type { TableSchema, RowConstraintSchema, IndexSchema, IndexColumnSchema, MutationContextDefinition } from './table.js';
import type { FunctionSchema } from './function.js';
import { quereusError, QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import type { AnyVirtualTableModule, BaseModuleConfig } from '../vtab/module.js';
import type { VirtualTable } from '../vtab/table.js';
import type { ColumnSchema } from './column.js';
import { buildColumnIndexMap, columnDefToSchema, findPKDefinition, opsToMask, mutationContextVarToSchema } from './table.js';
import type { ViewSchema } from './view.js';
import { createLogger } from '../common/logger.js';
import type * as AST from '../parser/ast.js';
import { Parser } from '../parser/parser.js';
import { SchemaChangeNotifier } from './change-events.js';
import { checkDeterministic } from '../planner/validation/determinism-validator.js';
import { buildExpression } from '../planner/building/expression.js';
import type { PlanningContext } from '../planner/planning-context.js';
import { BuildTimeDependencyTracker } from '../planner/planning-context.js';
import { GlobalScope } from '../planner/scopes/global.js';
import { ParameterScope } from '../planner/scopes/param.js';
import type { ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { hasNativeEventSupport } from '../util/event-support.js';
import type { VTableSchemaChangeEvent } from '../vtab/events.js';

const log = createLogger('schema:manager');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * Generic options passed to VTab modules during CREATE TABLE.
 * Modules are responsible for interpreting these.
 */
export interface GenericModuleCallOptions extends BaseModuleConfig {
	moduleArgs?: readonly string[];
	statementColumns?: readonly AST.ColumnDef[];
	statementConstraints?: readonly AST.TableConstraint[];
	isTemporary?: boolean;
}

/**
 * Manages all schemas associated with a database connection (main, temp, attached).
 * Handles lookup resolution according to SQLite's rules.
 */
export class SchemaManager {
	private schemas: Map<string, Schema> = new Map();
	private currentSchemaName: string = 'main';
	private modules: Map<string, { module: AnyVirtualTableModule, auxData?: unknown }> = new Map();
	private defaultVTabModuleName: string = 'memory';
	private defaultVTabModuleArgs: Record<string, SqlValue> = {};
	private db: Database;
	private changeNotifier = new SchemaChangeNotifier();

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
	registerModule(name: string, module: AnyVirtualTableModule, auxData?: unknown): void {
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
	getModule(name: string): { module: AnyVirtualTableModule, auxData?: unknown } | undefined {
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
			warnLog(`Setting default VTab module to '${lowerName}', which is not currently registered in SchemaManager. Ensure it gets registered.`);
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
	setDefaultVTabArgs(args: Record<string, SqlValue>): void {
		this.defaultVTabModuleArgs = args;
		log('Default VTab module args set to: %o', args);
	}

	/** @internal Sets the default VTab args by parsing a JSON string */
	setDefaultVTabArgsFromJson(argsJsonString: string): void {
		try {
			const parsedArgs = JSON.parse(argsJsonString);
			if (typeof parsedArgs !== 'object') {
				quereusError("JSON value must be an object.", StatusCode.MISUSE);
			}
			this.setDefaultVTabArgs(parsedArgs);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			quereusError(`Invalid JSON for default_vtab_args: ${msg}`, StatusCode.ERROR);
		}
	}

	/**
	 * Gets the default virtual table module arguments.
	 * @returns A copy of the default arguments array.
	 */
	getDefaultVTabArgs(): Record<string, SqlValue> {
		return { ...this.defaultVTabModuleArgs };
	}

	/**
	 * Gets the default virtual table module name and arguments.
	 * @returns An object containing the module name and arguments.
	 */
	getDefaultVTabModule(): { name: string; args: Record<string, SqlValue> } {
		return {
			name: this.defaultVTabModuleName,
			args: this.defaultVTabModuleArgs,
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
	 * Returns all assertions across all schemas
	 */
	getAllAssertions(): IntegrityAssertionSchema[] {
		const result: IntegrityAssertionSchema[] = [];
		for (const schema of this._getAllSchemas()) {
			for (const a of schema.getAllAssertions()) {
				result.push(a);
			}
		}
		return result;
	}

	/**
	 * Gets the schema change notifier for listening to schema changes
	 */
	getChangeNotifier(): SchemaChangeNotifier {
		return this.changeNotifier;
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
		const schema = new Schema(lowerName);
		this.schemas.set(lowerName, schema);
		log(`Added schema '%s'`, lowerName);
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
	 *
	 * @param tableName Name of the table to find
	 * @param dbName Optional specific schema name to search (overrides search path)
	 * @param schemaPath Optional ordered list of schemas to search (overrides default search order)
	 * @returns The TableSchema if found, undefined otherwise
	 */
	_findTable(tableName: string, dbName?: string, schemaPath?: string[]): TableSchema | undefined {
		const lowerTableName = tableName.toLowerCase();

		if (dbName) {
			// Search specific schema (qualified name)
			const schema = this.schemas.get(dbName.toLowerCase());
			return schema?.getTable(lowerTableName);
		} else if (schemaPath && schemaPath.length > 0) {
			// Search through provided schema path in order
			for (const schemaName of schemaPath) {
				const schema = this.schemas.get(schemaName.toLowerCase());
				const table = schema?.getTable(lowerTableName);
				if (table) return table;
			}
			return undefined;
		} else {
			// Default search order: main, then temp (and attached later)
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
	 * @param schemaPath Optional ordered list of schemas to search
	 * @returns The TableSchema or undefined if not found
	 */
	findTable(tableName: string, dbName?: string, schemaPath?: string[]): TableSchema | undefined {
		return this._findTable(tableName, dbName, schemaPath);
	}

	/**
	 * Finds all schemas that contain a table with the given name.
	 * Useful for generating helpful error messages.
	 *
	 * @param tableName Name of the table to search for
	 * @returns Array of schema names that contain the table
	 */
	findSchemasContainingTable(tableName: string): string[] {
		const lowerTableName = tableName.toLowerCase();
		const schemaNames: string[] = [];

		for (const [schemaName, schema] of this.schemas) {
			if (schema.getTable(lowerTableName)) {
				schemaNames.push(schemaName);
			}
		}

		return schemaNames;
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
	 * Retrieves a view schema definition
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param viewName The name of the view
	 * @returns The ViewSchema or undefined if not found
	 */
	getView(schemaName: string | null, viewName: string): ViewSchema | undefined {
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
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
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
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

		// Call destroy on the module, providing table details
		if (tableSchema.vtabModuleName) { // tableSchema is guaranteed to be defined here
			const moduleRegistration = this.getModule(tableSchema.vtabModuleName);
			if (moduleRegistration && moduleRegistration.module && moduleRegistration.module.destroy) {
				log(`Calling destroy for VTab %s.%s via module %s`, schemaName, tableName, tableSchema.vtabModuleName);
				destroyPromise = moduleRegistration.module.destroy(
					this.db,
					moduleRegistration.auxData,
					tableSchema.vtabModuleName,
					schemaName,
					tableName
				).catch(err => {
					errorLog(`Error during VTab module destroy for %s.%s: %O`, schemaName, tableName, err);
					// Potentially re-throw or handle as a critical error if destroy failure is problematic
				});
			} else {
				warnLog(`VTab module %s (for table %s.%s) or its destroy method not found during dropTable.`, tableSchema.vtabModuleName, schemaName, tableName);
			}
		}

		// Remove from schema map immediately
		const removed = schema.removeTable(tableName);
		if (!removed && !ifExists) {
			// This should ideally not be reached if tableSchema was found above.
			// But as a safeguard if removeTable could fail for other reasons.
			throw new QuereusError(`Failed to remove table ${tableName} from schema ${schemaName}, though it was initially found.`, StatusCode.INTERNAL);
		}

		// Notify schema change listeners if table was removed
		if (removed) {
			this.changeNotifier.notifyChange({
				type: 'table_removed',
				schemaName: schemaName,
				objectName: tableName,
				oldObject: tableSchema
			});

			// Emit auto schema event for modules without native event support
			const moduleReg = tableSchema.vtabModuleName ? this.getModule(tableSchema.vtabModuleName) : undefined;
			if (this.db.hasSchemaListeners() && !hasNativeEventSupport(moduleReg?.module)) {
				this.db._getEventEmitter().emitAutoSchemaEvent(tableSchema.vtabModuleName ?? 'memory', {
					type: 'drop',
					objectType: 'table',
					schemaName: schemaName,
					objectName: tableName,
				});
			}
		}

		// Process destruction asynchronously
		if (destroyPromise) {
			void destroyPromise.then(() => log(`destroy completed for VTab %s.%s`, schemaName, tableName));
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
		const schema = this.schemas.get(schemaName.toLowerCase());
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
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getTable(tableName);
	}

	/**
	 * Resolves the VTab module name and args from a CREATE TABLE statement,
	 * falling back to configured defaults when USING is omitted.
	 */
	private resolveModuleInfo(stmt: AST.CreateTableStmt): {
		moduleName: string;
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>;
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown };
	} {
		let moduleName: string;
		let effectiveModuleArgs: Readonly<Record<string, SqlValue>>;

		if (stmt.moduleName) {
			moduleName = stmt.moduleName;
			effectiveModuleArgs = Object.freeze(stmt.moduleArgs || {});
		} else {
			const defaultVtab = this.getDefaultVTabModule();
			moduleName = defaultVtab.name;
			effectiveModuleArgs = Object.freeze(defaultVtab.args || {});
		}

		const moduleInfo = this.getModule(moduleName);
		if (!moduleInfo || !moduleInfo.module) {
			throw new QuereusError(`No virtual table module named '${moduleName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		return { moduleName, effectiveModuleArgs, moduleInfo };
	}

	/**
	 * Builds column schemas from AST column/constraint definitions,
	 * resolving PK membership and nullability.
	 */
	private buildColumnSchemas(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined,
		defaultNotNull: boolean
	): {
		columns: ColumnSchema[];
		pkDefinition: ReadonlyArray<import('./table.js').PrimaryKeyColumnDefinition>;
	} {
		const preliminaryColumnSchemas: ColumnSchema[] = astColumns.map(colDef => columnDefToSchema(colDef, defaultNotNull));
		const pkDefinition = findPKDefinition(preliminaryColumnSchemas, astConstraints);

		const columns = preliminaryColumnSchemas.map((col, idx) => {
			const isPkColumn = pkDefinition.some(pkCol => pkCol.index === idx);
			const pkOrder = isPkColumn
				? pkDefinition.findIndex(pkC => pkC.index === idx) + 1
				: 0;
			return {
				...col,
				primaryKey: isPkColumn,
				pkOrder,
				notNull: isPkColumn ? true : col.notNull,
			};
		});

		return { columns, pkDefinition };
	}

	/**
	 * Extracts CHECK constraints from AST column and table constraint definitions.
	 */
	private extractCheckConstraints(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined
	): RowConstraintSchema[] {
		const result: RowConstraintSchema[] = [];

		for (const colDef of astColumns) {
			for (const con of colDef.constraints ?? []) {
				if (con.type === 'check' && con.expr) {
					result.push({
						name: con.name ?? `_check_${colDef.name}`,
						expr: con.expr,
						operations: opsToMask(con.operations),
						deferrable: con.deferrable,
						initiallyDeferred: con.initiallyDeferred
					});
				}
			}
		}

		for (const con of astConstraints ?? []) {
			if (con.type === 'check' && con.expr) {
				result.push({
					name: con.name,
					expr: con.expr,
					operations: opsToMask(con.operations),
					deferrable: con.deferrable,
					initiallyDeferred: con.initiallyDeferred
				});
			}
		}

		return result;
	}

	/**
	 * Builds a base TableSchema from an AST CREATE TABLE statement.
	 * Shared by both createTable (new storage) and importTable (existing storage).
	 */
	private buildTableSchemaFromAST(
		stmt: AST.CreateTableStmt,
		moduleName: string,
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>,
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown }
	): TableSchema {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const defaultNullability = this.db.options.getStringOption('default_column_nullability');
		const defaultNotNull = defaultNullability === 'not_null';

		const astColumns = stmt.columns || [];
		const { columns, pkDefinition } = this.buildColumnSchemas(astColumns, stmt.constraints, defaultNotNull);
		const checkConstraints = this.extractCheckConstraints(astColumns, stmt.constraints);

		const mutationContextSchemas: MutationContextDefinition[] | undefined = stmt.contextDefinitions
			? stmt.contextDefinitions.map(varDef => mutationContextVarToSchema(varDef, defaultNotNull))
			: undefined;

		return {
			name: tableName,
			schemaName: targetSchemaName,
			columns: Object.freeze(columns),
			columnIndexMap: buildColumnIndexMap(columns),
			primaryKeyDefinition: pkDefinition,
			checkConstraints: Object.freeze(checkConstraints),
			isTemporary: !!stmt.isTemporary,
			isView: false,
			vtabModuleName: moduleName,
			vtabArgs: effectiveModuleArgs,
			vtabModule: moduleInfo.module,
			vtabAuxData: moduleInfo.auxData,
			estimatedRows: 0,
			mutationContext: mutationContextSchemas ? Object.freeze(mutationContextSchemas) : undefined,
		};
	}

	/**
	 * Validates that all DEFAULT expressions in the column schemas are deterministic.
	 * Skips expressions that reference columns (validated at INSERT time instead).
	 */
	private validateDefaultDeterminism(columns: ReadonlyArray<ColumnSchema>, tableName: string): void {
		const globalScope = new GlobalScope(this.db.schemaManager);
		const parameterScope = new ParameterScope(globalScope);
		const planningCtx: PlanningContext = {
			db: this.db,
			schemaManager: this.db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map()
		};

		for (const col of columns) {
			if (!col.defaultValue || typeof col.defaultValue !== 'object' || col.defaultValue === null || !('type' in col.defaultValue)) {
				continue;
			}

			let defaultExpr: ScalarPlanNode | undefined;
			try {
				defaultExpr = buildExpression(planningCtx, col.defaultValue as AST.Expression) as ScalarPlanNode;
			} catch (_e) {
				log('Skipping determinism validation for default on column %s.%s at CREATE TABLE time (will validate at INSERT time): %s',
					tableName, col.name, (_e as Error).message);
			}

			if (defaultExpr) {
				const result = checkDeterministic(defaultExpr);
				if (!result.valid) {
					throw new QuereusError(
						`Non-deterministic expression not allowed in DEFAULT for column '${col.name}' in table '${tableName}'. ` +
						`Expression: ${result.expression}. ` +
						`Use mutation context to pass non-deterministic values (e.g., WITH CONTEXT (timestamp = datetime('now'))).`,
						StatusCode.ERROR
					);
				}
			}
		}
	}

	/**
	 * Registers a table schema after module.create() returns, correcting
	 * name/schema if the module returned different values.
	 */
	private finalizeCreatedTableSchema(
		tableInstance: VirtualTable,
		tableName: string,
		targetSchemaName: string,
		moduleName: string,
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>,
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown }
	): TableSchema {
		const finalRegisteredSchema = tableInstance.tableSchema;
		if (!finalRegisteredSchema) {
			throw new QuereusError(`Module '${moduleName}' create did not provide a tableSchema for '${tableName}'.`, StatusCode.INTERNAL);
		}

		let correctedSchema = finalRegisteredSchema;
		if (finalRegisteredSchema.name.toLowerCase() !== tableName.toLowerCase() ||
			finalRegisteredSchema.schemaName.toLowerCase() !== targetSchemaName.toLowerCase()) {
			warnLog(`Module ${moduleName} returned schema for ${finalRegisteredSchema.schemaName}.${finalRegisteredSchema.name} but expected ${targetSchemaName}.${tableName}. Correcting name/schemaName.`);
			correctedSchema = {
				...finalRegisteredSchema,
				name: tableName,
				schemaName: targetSchemaName,
			};
		}

		return {
			...correctedSchema,
			vtabModuleName: moduleName,
			vtabArgs: effectiveModuleArgs,
			vtabModule: moduleInfo.module,
			vtabAuxData: moduleInfo.auxData,
			estimatedRows: correctedSchema.estimatedRows ?? 0,
		};
	}

	/**
	 * Creates a new index on an existing table based on an AST.CreateIndexStmt.
	 *
	 * @param stmt The AST node for the CREATE INDEX statement.
	 * @throws QuereusError on errors (e.g., table not found, column not found, createIndex fails).
	 */
	async createIndex(stmt: AST.CreateIndexStmt): Promise<void> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;
		const indexName = stmt.index.name;

		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new QuereusError(`no such table: ${tableName}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		if (!tableSchema.vtabModule.createIndex) {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' for table '${tableName}' does not support CREATE INDEX.`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		const existingIndex = tableSchema.indexes?.find(idx => idx.name.toLowerCase() === indexName.toLowerCase());
		if (existingIndex) {
			if (stmt.ifNotExists) {
				log(`Skipping CREATE INDEX: Index %s.%s already exists (IF NOT EXISTS).`, targetSchemaName, indexName);
				return;
			}
			throw new QuereusError(`Index ${indexName} already exists on table ${tableName}`, StatusCode.CONSTRAINT, undefined, stmt.index.loc?.start.line, stmt.index.loc?.start.column);
		}

		const indexSchema = this.buildIndexSchema(stmt, tableSchema, tableName, indexName);

		try {
			await tableSchema.vtabModule.createIndex(this.db, targetSchemaName, tableName, indexSchema);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`createIndex failed for index '${indexName}' on table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		const updatedTableSchema = this.addIndexToTableSchema(tableSchema, indexSchema);
		const schema = this.getSchemaOrFail(targetSchemaName);
		schema.addTable(updatedTableSchema);

		this.changeNotifier.notifyChange({
			type: 'table_modified',
			schemaName: targetSchemaName,
			objectName: tableName,
			oldObject: tableSchema,
			newObject: updatedTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(tableSchema.vtabModuleName, {
			type: 'create',
			objectType: 'index',
			schemaName: targetSchemaName,
			objectName: indexName,
		});

		log(`Successfully created index %s on table %s.%s`, indexName, targetSchemaName, tableName);
	}

	/**
	 * Builds an IndexSchema from AST column definitions, validating against the table schema.
	 */
	private buildIndexSchema(
		stmt: AST.CreateIndexStmt,
		tableSchema: TableSchema,
		tableName: string,
		indexName: string
	): IndexSchema {
		const indexColumns = stmt.columns.map((indexedCol: AST.IndexedColumn) => {
			if (indexedCol.expr) {
				throw new QuereusError(`Indices on expressions are not supported yet.`, StatusCode.ERROR, undefined, indexedCol.expr.loc?.start.line, indexedCol.expr.loc?.start.column);
			}
			const colName = indexedCol.name;
			if (!colName) {
				throw new QuereusError(`Indexed column must be a simple column name.`, StatusCode.ERROR);
			}
			const tableColIndex = tableSchema.columnIndexMap.get(colName.toLowerCase());
			if (tableColIndex === undefined) {
				throw new QuereusError(`Column '${colName}' not found in table '${tableName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
			const tableColSchema = tableSchema.columns[tableColIndex];
			return {
				index: tableColIndex,
				desc: indexedCol.direction === 'desc',
				collation: indexedCol.collation || tableColSchema.collation
			};
		});

		return {
			name: indexName,
			columns: Object.freeze(indexColumns),
		};
	}

	/**
	 * Returns a new TableSchema with the given index appended.
	 */
	private addIndexToTableSchema(tableSchema: TableSchema, indexSchema: IndexSchema): TableSchema {
		const updatedIndexes = [...(tableSchema.indexes || []), indexSchema];
		return {
			...tableSchema,
			indexes: Object.freeze(updatedIndexes),
		};
	}

	/**
	 * Emits an auto schema event for modules that don't have native event support,
	 * if any schema listeners are registered.
	 */
	private emitAutoSchemaEventIfNeeded(
		moduleName: string | undefined,
		event: VTableSchemaChangeEvent
	): void {
		const moduleReg = moduleName ? this.getModule(moduleName) : undefined;
		if (this.db.hasSchemaListeners() && !hasNativeEventSupport(moduleReg?.module)) {
			this.db._getEventEmitter().emitAutoSchemaEvent(moduleName ?? 'memory', event);
		}
	}

	/**
	 * Defines a new table in the schema based on an AST.CreateTableStmt.
	 * Interacts with VTab modules (create) and registers the new table schema.
	 *
	 * @param stmt The AST node for the CREATE TABLE statement.
	 * @returns A Promise that resolves to the created TableSchema.
	 * @throws QuereusError on errors (e.g., module not found, create fails, table exists).
	 */
	async createTable(stmt: AST.CreateTableStmt): Promise<TableSchema> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const schema = this.getSchema(targetSchemaName);
		if (!schema) {
			throw new QuereusError(`Internal error: Schema '${targetSchemaName}' not found.`, StatusCode.INTERNAL);
		}

		const existingTable = schema.getTable(tableName);
		const existingView = schema.getView(tableName);

		if (existingTable || existingView) {
			if (stmt.ifNotExists) {
				log(`Skipping CREATE TABLE: Item %s.%s already exists (IF NOT EXISTS).`, targetSchemaName, tableName);
				if (existingTable) return existingTable;
				throw new QuereusError(`Cannot CREATE TABLE ${targetSchemaName}.${tableName}: a VIEW with the same name already exists.`, StatusCode.CONSTRAINT, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
			}
			const itemType = existingTable ? 'Table' : 'View';
			throw new QuereusError(`${itemType} ${targetSchemaName}.${tableName} already exists`, StatusCode.CONSTRAINT, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		const { moduleName, effectiveModuleArgs, moduleInfo } = this.resolveModuleInfo(stmt);
		const baseTableSchema = this.buildTableSchemaFromAST(stmt, moduleName, effectiveModuleArgs, moduleInfo);

		this.validateDefaultDeterminism(baseTableSchema.columns, tableName);

		let tableInstance: VirtualTable;
		try {
			tableInstance = await moduleInfo.module.create(this.db, baseTableSchema);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`Module '${moduleName}' create failed for table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		const completeTableSchema = this.finalizeCreatedTableSchema(
			tableInstance, tableName, targetSchemaName, moduleName, effectiveModuleArgs, moduleInfo
		);

		schema.addTable(completeTableSchema);
		log(`Successfully created table %s.%s using module %s`, targetSchemaName, tableName, moduleName);

		this.changeNotifier.notifyChange({
			type: 'table_added',
			schemaName: targetSchemaName,
			objectName: tableName,
			newObject: completeTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(moduleName, {
			type: 'create',
			objectType: 'table',
			schemaName: targetSchemaName,
			objectName: tableName,
		});

		return completeTableSchema;
	}

	/**
	 * Import catalog objects from DDL statements without triggering storage creation.
	 * Used when connecting to existing storage that already contains data.
	 *
	 * This method:
	 * 1. Parses each DDL statement
	 * 2. Registers the schema objects (tables, indexes)
	 * 3. Calls module.connect() instead of module.create()
	 * 4. Skips schema change hooks (since these are existing objects)
	 *
	 * @param ddlStatements Array of DDL strings (CREATE TABLE, CREATE INDEX, etc.)
	 * @returns Array of imported object names
	 */
	async importCatalog(ddlStatements: string[]): Promise<{ tables: string[]; indexes: string[] }> {
		const imported = { tables: [] as string[], indexes: [] as string[] };

		for (const ddl of ddlStatements) {
			try {
				const result = await this.importSingleDDL(ddl);
				if (result.type === 'table') {
					imported.tables.push(result.name);
				} else if (result.type === 'index') {
					imported.indexes.push(result.name);
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				errorLog('Failed to import DDL: %s - Error: %s', ddl.substring(0, 100), message);
				throw e;
			}
		}

		log('Imported catalog: %d tables, %d indexes', imported.tables.length, imported.indexes.length);
		return imported;
	}

	/**
	 * Import a single DDL statement without creating storage.
	 */
	private async importSingleDDL(ddl: string): Promise<{ type: 'table' | 'index'; name: string }> {
		const parser = new Parser();
		const statements = parser.parseAll(ddl);
		if (statements.length !== 1) {
			throw new QuereusError(`importCatalog expects exactly one statement per DDL, got ${statements.length}`, StatusCode.ERROR);
		}

		const stmt = statements[0];

		if (stmt.type === 'createTable') {
			return this.importTable(stmt as AST.CreateTableStmt);
		} else if (stmt.type === 'createIndex') {
			return this.importIndex(stmt as AST.CreateIndexStmt);
		}
		throw new QuereusError(`importCatalog does not support statement type: ${stmt.type}`, StatusCode.ERROR);
	}

	/**
	 * Import a table schema without calling module.create().
	 * Uses module.connect() to bind to existing storage.
	 */
	private async importTable(stmt: AST.CreateTableStmt): Promise<{ type: 'table'; name: string }> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const { moduleName, effectiveModuleArgs, moduleInfo } = this.resolveModuleInfo(stmt);
		const tableSchema = this.buildTableSchemaFromAST(stmt, moduleName, effectiveModuleArgs, moduleInfo);

		try {
			await moduleInfo.module.connect(
				this.db,
				moduleInfo.auxData,
				moduleName,
				targetSchemaName,
				tableName,
				effectiveModuleArgs,
				tableSchema
			);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Module '${moduleName}' connect failed during import for table '${tableName}': ${message}`, StatusCode.ERROR);
		}

		let schema = this.getSchema(targetSchemaName);
		if (!schema) {
			const lowerSchemaName = targetSchemaName.toLowerCase();
			schema = new Schema(lowerSchemaName);
			this.schemas.set(lowerSchemaName, schema);
		}

		schema.addTable(tableSchema);
		log(`Imported table %s.%s using module %s`, targetSchemaName, tableName, moduleName);

		return { type: 'table', name: `${targetSchemaName}.${tableName}` };
	}

	/**
	 * Import an index schema without calling module.createIndex().
	 */
	private async importIndex(stmt: AST.CreateIndexStmt): Promise<{ type: 'index'; name: string }> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;
		const indexName = stmt.index.name;

		// Find the table
		const tableSchema = this.findTable(tableName, targetSchemaName);
		if (!tableSchema) {
			throw new QuereusError(`Cannot import index '${indexName}': table '${tableName}' not found`, StatusCode.ERROR);
		}

		// Build index columns schema
		const indexColumns: IndexColumnSchema[] = stmt.columns.map(col => {
			const colName = col.name;
			if (!colName) {
				throw new QuereusError(`Expression-based index columns are not supported during import`, StatusCode.ERROR);
			}
			const colIdx = tableSchema.columnIndexMap.get(colName.toLowerCase());
			if (colIdx === undefined) {
				throw new QuereusError(`Column '${colName}' not found in table '${tableName}'`, StatusCode.ERROR);
			}
			return {
				index: colIdx,
				desc: col.direction === 'desc',
			};
		});

		const indexSchema: IndexSchema = {
			name: indexName,
			columns: Object.freeze(indexColumns),
		};

		// Add index to table without calling module.createIndex()
		const updatedIndexes = [...(tableSchema.indexes || []), indexSchema];
		const updatedTableSchema: TableSchema = {
			...tableSchema,
			indexes: Object.freeze(updatedIndexes),
		};

		const schema = this.getSchemaOrFail(targetSchemaName);
		schema.addTable(updatedTableSchema);
		log(`Imported index %s on table %s.%s`, indexName, targetSchemaName, tableName);

		return { type: 'index', name: `${targetSchemaName}.${tableName}.${indexName}` };
	}
}
