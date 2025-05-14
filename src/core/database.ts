import { createLogger } from '../common/logger.js';
import { MisuseError, SqliterError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { VirtualTableModule } from '../vtab/module.js';
import { Statement } from './statement.js';
import type { SqlParameters, SqlValue } from '../common/types.js';
import { SchemaManager } from '../schema/manager.js';
import type { TableSchema } from '../schema/table.js';
import type { FunctionSchema } from '../schema/function.js';
import { BUILTIN_FUNCTIONS } from '../func/builtins/index.js';
import { createScalarFunction, createAggregateFunction } from '../func/registration.js';
import { FunctionFlags } from '../common/constants.js';
import { MemoryTableModule } from '../vtab/memory/module.js';
import { JsonEachModule } from '../vtab/json/each.js';
import { JsonTreeModule } from '../vtab/json/tree.js';
import { SchemaTableModule } from '../vtab/schema/table.js';
import { QueryPlanModule } from '../vtab/explain/module.js';
import { VdbeProgramModule } from '../vtab/explain_vdbe/module.js';
import { BINARY_COLLATION, getCollation, NOCASE_COLLATION, registerCollation, RTRIM_COLLATION, type CollationFunction } from '../util/comparison.js';
import { exportSchemaJson as exportSchemaJsonUtil, importSchemaJson as importSchemaJsonUtil } from '../schema/serialization.js';
import { Parser } from '../parser/parser.js';
import { Compiler } from '../compiler/compiler.js';
import * as AST from '../parser/ast.js';
import type { VdbeProgram } from '../vdbe/program.js';
import { transformPlannedStepsToQueryPlanSteps, type QueryPlanStep } from './explain.js';

const log = createLogger('core:database');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log.extend('debug');

/**
 * Represents a connection to an SQLite database (in-memory in this port).
 * Manages schema, prepared statements, virtual tables, and functions.
 */
export class Database {
	public readonly schemaManager: SchemaManager;
	private isOpen = true;
	private statements = new Set<Statement>();
	private isAutocommit = true; // Manages transaction state
	private inTransaction = false;

	constructor() {
		this.schemaManager = new SchemaManager(this);
		log("Database instance created.");

		// Register built-in functions
		this.registerBuiltinFunctions();

		// Register default virtual table modules via SchemaManager
		// The SchemaManager.defaultVTabModuleName is already initialized (e.g. to 'memory')
		// No need to set defaultVtabModuleName explicitly here unless it's different from SchemaManager's init value.
		// this.schemaManager.setDefaultVTabModuleName('memory'); // Already 'memory' by default in SchemaManager
		// this.schemaManager.setDefaultVTabArgs([]); // Already [] by default in SchemaManager

		this.schemaManager.registerModule('memory', new MemoryTableModule());
		this.schemaManager.registerModule('json_each', new JsonEachModule());
		this.schemaManager.registerModule('json_tree', new JsonTreeModule());
		this.schemaManager.registerModule('sqlite_schema', new SchemaTableModule()); // sqlite_schema uses auxData, but it's null/undefined by default
		this.schemaManager.registerModule('query_plan', new QueryPlanModule());
		this.schemaManager.registerModule('vdbe_program', new VdbeProgramModule());

		// Register built-in collations
		this.registerDefaultCollations();
	}

	/** @internal Registers default built-in SQL functions */
	private registerBuiltinFunctions(): void {
		const mainSchema = this.schemaManager.getMainSchema();
		BUILTIN_FUNCTIONS.forEach(funcDef => {
			try {
				mainSchema.addFunction(funcDef);
			} catch (e) {
				errorLog(`Failed to register built-in function ${funcDef.name}/${funcDef.numArgs}: %O`, e);
			}
		});
		log(`Registered ${BUILTIN_FUNCTIONS.length} built-in functions.`);
	}

	/** @internal Registers default collation sequences */
	private registerDefaultCollations(): void {
		// Register the built-in collations
		registerCollation('BINARY', BINARY_COLLATION);
		registerCollation('NOCASE', NOCASE_COLLATION);
		registerCollation('RTRIM', RTRIM_COLLATION);
		log("Default collations registered (BINARY, NOCASE, RTRIM)");
	}

	/**
	 * Prepares an SQL statement for execution.
	 * @param sql The SQL string to prepare.
	 * @returns A Promise resolving to the prepared Statement object.
	 * @throws SqliteError on failure (e.g., syntax error).
	 */
	prepare(sql: string): Statement {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}
		log('Preparing SQL: %s', sql);

		// Create the statement using the standard constructor (compilation deferred)
		const stmt = new Statement(this, sql);

		// Attempt initial compilation within prepare to catch immediate parse errors
		stmt.compile();

		// Add to active statements list *after* successful initial compile check
		this.statements.add(stmt);
		return stmt;
	}

	/**
	 * Executes one or more SQL statements directly.
	 * The callback, if provided, is invoked for each result row of the *last* statement executed.
	 * @param sql The SQL string(s) to execute.
	 * @param params Optional parameters to bind (only applicable if the SQL string contains exactly one statement).
	 * @param callback Optional callback to process result rows of the last statement.
	 * @returns A Promise resolving when execution completes.
	 * @throws SqliteError on failure.
	 */
	async exec(
		sql: string,
		params?: SqlParameters | ((row: Record<string, SqlValue>, columns: string[]) => void),
		callback?: (row: Record<string, SqlValue>) => void
	): Promise<void> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		// Handle overloaded signature where params is the callback
		if (typeof params === 'function' && callback === undefined) {
			callback = params as (row: Record<string, SqlValue>) => void;
			params = undefined;
		}

		log('Executing SQL block: %s', sql);

		// 1. Parse all statements
		const parser = new Parser();
		const statementsAst = parser.parseAll(sql);

		if (statementsAst.length === 0) {
			return; // No statements to execute
		}

		// 2. Check for params with multiple statements (disallowed)
		if (params && typeof params !== 'function' && statementsAst.length > 1) {
			throw new MisuseError("Binding parameters is only supported for single-statement execution in exec().");
		}

		// 3. Determine if implicit transaction is needed
		let needsImplicitTransaction = false;
		const hasExplicitTransaction = statementsAst.some(
			ast => ast.type === 'begin' || ast.type === 'commit' || ast.type === 'rollback' || ast.type === 'savepoint' || ast.type === 'release'
		);
		if (statementsAst.length > 1 && !hasExplicitTransaction && this.isAutocommit) {
			needsImplicitTransaction = true;
		}

		// 4. Execute statements sequentially
		const compiler = new Compiler(this);
		let executionError: Error | null = null;

		try {
			// 4a. Begin implicit transaction if needed
			if (needsImplicitTransaction) {
				debugLog("Exec: Starting implicit transaction for multi-statement block.");
				// Use internal helper or simplified exec for BEGIN
				await this._executeSimpleCommand("BEGIN DEFERRED TRANSACTION");
				this.inTransaction = true; // Manually update state for internal logic
				this.isAutocommit = false;
			}

			// 4b. Execute each statement
			for (let i = 0; i < statementsAst.length; i++) {
				const ast = statementsAst[i];
				const isLastStatement = (i === statementsAst.length - 1);
				let stmt: Statement | null = null;

				try {
					// Compile the individual statement
					const program = compiler.compile(ast, sql);
					stmt = new Statement(this, sql, program); // Pass program directly

					// Bind parameters ONLY if it's the *single* statement being executed
					if (statementsAst.length === 1 && params && typeof params !== 'function') {
						stmt.bindAll(params);
					}

					// Execute the statement steps until done/error
					let resultStatus: StatusCode;

					do {
						resultStatus = await stmt.step();
						if (resultStatus === StatusCode.ROW) {
							// If it's the last statement and a callback exists, process row
							if (isLastStatement && callback) {
								try {
									callback(stmt.getAsObject());
								} catch (cbError: any) {
									errorLog("Error in exec() callback: %O", cbError);
									// Stop further execution if callback fails?
									throw new SqliterError(`Callback error: ${cbError.message}`, StatusCode.ABORT, cbError);
								}
							}
						} else if (resultStatus !== StatusCode.DONE && resultStatus !== StatusCode.OK) {
							// Error occurred during step() - step() should throw the error
							// If it somehow returns an error code without throwing, create a generic one
							throw new SqliterError(`VDBE execution failed with status: ${StatusCode[resultStatus] || resultStatus}`, resultStatus);
						}
					} while (resultStatus === StatusCode.ROW); // Continue stepping ONLY if a row was returned

				} catch (err: any) {
					executionError = err; // Store the first error encountered (already an Error/SqliteError)
					break; // Stop processing further statements on error
				} finally {
					if (stmt) {
						await stmt.finalize(); // Finalize the transient statement
					}
				}
			}

		} finally {
			// 5. Commit or Rollback implicit transaction
			if (needsImplicitTransaction) {
				try {
					if (executionError) {
						debugLog("Exec: Rolling back implicit transaction due to error.", executionError);
						await this._executeSimpleCommand("ROLLBACK");
					} else {
						debugLog("Exec: Committing implicit transaction.");
						await this._executeSimpleCommand("COMMIT");
					}
				} catch (txError) {
					// Log error during commit/rollback but don't overwrite original execution error
					errorLog(`Error during implicit transaction ${executionError ? 'rollback' : 'commit'}: %O`, txError);
				} finally {
					// Reset DB state regardless of commit/rollback success/failure
					this.inTransaction = false;
					this.isAutocommit = true;
				}
			}
		}

		// 6. Re-throw the execution error if one occurred
		if (executionError) {
			throw executionError;
		}
	}

	/** @internal Helper to execute simple commands without parameter binding or row results */
	private async _executeSimpleCommand(sqlCommand: string): Promise<void> {
		let stmt: Statement | null = null;
		try {
			stmt = this.prepare(sqlCommand);
			const status = await stmt.step();
			if (status !== StatusCode.DONE && status !== StatusCode.OK) {
				// step() should have thrown, but if not, throw a generic error
				throw new SqliterError(`Implicit command '${sqlCommand}' failed with status ${status}`, status);
			}
		} finally {
			if (stmt) {
				await stmt.finalize();
			}
		}
	}

	/**
	 * Registers a virtual table module.
	 * @param name The name of the module.
	 * @param module The module implementation.
	 * @param auxData Optional client data passed to xCreate/xConnect.
	 */
	registerVtabModule(name: string, module: VirtualTableModule<any, any>, auxData?: unknown): void {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}
		// Delegate to SchemaManager
		this.schemaManager.registerModule(name, module, auxData);
		// Original logic below is removed:
		// const lowerName = name.toLowerCase();
		// if (this.registeredVTabs.has(lowerName)) {
		// 	throw new SqliterError(`Virtual table module '${name}' already registered`, StatusCode.ERROR);
		// }
		// log('Registering VTab module: %s', name);
		// this.registeredVTabs.set(lowerName, { module, auxData });
	}

	/**
	 * Begins a transaction.
	 * @param mode Transaction mode ('deferred', 'immediate', or 'exclusive').
	 */
	async beginTransaction(mode: 'deferred' | 'immediate' | 'exclusive' = 'deferred'): Promise<void> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		if (this.inTransaction) {
			throw new SqliterError("Transaction already active", StatusCode.ERROR);
		}

		await this.exec(`BEGIN ${mode.toUpperCase()} TRANSACTION`);
		this.inTransaction = true;
		this.isAutocommit = false;
	}

	/**
	 * Commits the current transaction.
	 */
	async commit(): Promise<void> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		if (!this.inTransaction) {
			throw new SqliterError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("COMMIT");
		this.inTransaction = false;
		this.isAutocommit = true;
	}

	/**
	 * Rolls back the current transaction.
	 */
	async rollback(): Promise<void> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		if (!this.inTransaction) {
			throw new SqliterError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("ROLLBACK");
		this.inTransaction = false;
		this.isAutocommit = true;
	}

	/**
	 * Closes the database connection and releases resources.
	 * @returns A promise resolving on completion.
	 */
	async close(): Promise<void> {
		if (!this.isOpen) {
			return;
		}

		log("Closing database...");
		this.isOpen = false;

		// Finalize all prepared statements
		const finalizePromises = Array.from(this.statements).map(stmt => stmt.finalize());
		await Promise.allSettled(finalizePromises); // Wait even if some fail
		this.statements.clear();

		// Clear schemas, ensuring VTabs are potentially disconnected
		// This will also call xDestroy on VTabs via SchemaManager.clearAll -> schema.clearTables -> schemaManager.dropTable
		this.schemaManager.clearAll();

		// this.registeredVTabs.clear(); // Removed, SchemaManager handles module lifecycle
		log("Database closed.");
	}

	/** @internal Called by Statement when it's finalized */
	_statementFinalized(stmt: Statement): void {
		this.statements.delete(stmt);
	}

	/**
	 * Checks if the database connection is in autocommit mode.
	 */
	getAutocommit(): boolean {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}
		return this.isAutocommit;
	}

	/**
	 * Programmatically defines or replaces a virtual table in the 'main' schema.
	 * This is an alternative/supplement to using `CREATE VIRTUAL TABLE`.
	 * @param definition The schema definition for the table.
	 */
	defineVirtualTable(definition: TableSchema): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
		if (definition.schemaName !== 'main') {
			throw new MisuseError("Programmatic definition only supported for 'main' schema currently");
		}

		this.schemaManager.getMainSchema().addTable(definition);
	}

	/** @internal */
	_getVtabModule(name: string): { module: VirtualTableModule<any, any>, auxData?: unknown } | undefined {
		// Delegate to SchemaManager
		return this.schemaManager.getModule(name);
		// return this.registeredVTabs.get(name.toLowerCase()); // Old implementation
	}

	/** @internal */
	_findTable(tableName: string, dbName?: string): TableSchema | undefined {
		return this.schemaManager.findTable(tableName, dbName);
	}

	/** @internal */
	_findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		return this.schemaManager.findFunction(funcName, nArg);
	}

	/**
	 * Registers a user-defined scalar function.
	 *
	 * @param name The name of the SQL function.
	 * @param options Configuration: { numArgs: number, deterministic?: boolean, flags?: number }.
	 * @param func The JavaScript function implementation.
	 */
	createScalarFunction(
		name: string,
		options: {
			numArgs: number;
			deterministic?: boolean;
			flags?: number;
		},
		func: (...args: any[]) => SqlValue
	): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");

		const baseFlags = options.deterministic ? FunctionFlags.DETERMINISTIC | FunctionFlags.UTF8 : FunctionFlags.UTF8;
		const flags = options.flags ?? baseFlags;

		const schema = createScalarFunction(
			{ name, numArgs: options.numArgs, flags },
			func
		);

		try {
			this.schemaManager.getMainSchema().addFunction(schema);
		} catch (e) {
			errorLog(`Failed to register scalar function ${name}/${options.numArgs}: %O`, e);
			if (e instanceof Error) throw e; else throw new Error(String(e));
		}
	}

	/**
	 * Registers a user-defined aggregate function.
	 *
	 * @param name The name of the SQL function.
	 * @param options Configuration: { numArgs: number, flags?: number, initialState?: any }.
	 * @param stepFunc The function called for each row (accumulator, ...args) => newAccumulator.
	 * @param finalFunc The function called at the end (accumulator) => finalResult.
	 */
	createAggregateFunction(
		name: string,
		options: {
			numArgs: number;
			flags?: number;
			initialState?: any;
		},
		stepFunc: (acc: any, ...args: any[]) => any,
		finalFunc: (acc: any) => SqlValue
	): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");

		const flags = options.flags ?? FunctionFlags.UTF8;

		const schema = createAggregateFunction(
			{ name, numArgs: options.numArgs, flags, initialState: options.initialState },
			stepFunc,
			finalFunc
		);

		try {
			this.schemaManager.getMainSchema().addFunction(schema);
		} catch (e) {
			errorLog(`Failed to register aggregate function ${name}/${options.numArgs}: %O`, e);
			if (e instanceof Error) throw e; else throw new Error(String(e));
		}
	}

	/**
	 * Registers a function using a pre-defined FunctionSchema.
	 * This is the lower-level registration method.
	 *
	 * @param schema The FunctionSchema object describing the function.
	 */
	registerFunction(schema: FunctionSchema): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
		try {
			this.schemaManager.getMainSchema().addFunction(schema);
		} catch (e) {
			errorLog(`Failed to register function ${schema.name}/${schema.numArgs}: %O`, e);
			if (e instanceof Error) throw e; else throw new Error(String(e));
		}
	}

	/**
	 * Exports the current database schema (tables and function signatures)
	 * to a JSON string.
	 * @returns A JSON string representing the schema.
	 */
	exportSchemaJson(): string {
		return exportSchemaJsonUtil(this);
	}

	/**
	 * Imports a database schema from a JSON string.
	 * Clears existing non-core schemas (like attached) before importing.
	 * Function implementations must be re-registered manually after import.
	 * Virtual tables will need to be reconnected (potentially requires a separate step or lazy connect).
	 * @param jsonString The JSON string representing the schema.
	 * @throws Error on parsing errors or invalid schema format.
	 */
	importSchemaJson(jsonString: string): void {
		importSchemaJsonUtil(this, jsonString);
	}

	/**
	 * @deprecated Use setDefaultVtabName and setDefaultVtabArgsFromJson via PRAGMA instead.
	 * Sets the default virtual table module used when CREATE TABLE is called
	 * without a USING clause.
	 */
	setDefaultVtabModule(name: string, args: string[] = []): void {
		warnLog("Deprecated: Database.setDefaultVtabModule. Use `PRAGMA default_vtab_module` and `PRAGMA default_vtab_args` which interact with SchemaManager.");
		// Delegate to SchemaManager
		this.schemaManager.setDefaultVTabModuleName(name);
		this.schemaManager.setDefaultVTabArgs(args);
	}

	/** @internal Sets only the name of the default module. Should be managed by SchemaManager now. */
	setDefaultVtabName(name: string): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
		warnLog("Database.setDefaultVtabName is forwarding to SchemaManager. Use PRAGMA or direct SchemaManager methods.");
		this.schemaManager.setDefaultVTabModuleName(name);
		// Original logic:
		// if (!this.registeredVTabs.has(name.toLowerCase())) {
		// 	warnLog(`Setting default VTab module to '${name}', which is not currently registered.`);
		// }
		// this.defaultVtabModuleName = name;
	}

	/** @internal Sets the default args directly. Should be managed by SchemaManager now. */
	private setDefaultVtabArgs(args: string[]): void { // This method was only used by the deprecated setDefaultVtabModule
		if (!this.isOpen) throw new MisuseError("Database is closed");
		warnLog("Database.setDefaultVtabArgs is forwarding to SchemaManager. Use PRAGMA or direct SchemaManager methods.");
		this.schemaManager.setDefaultVTabArgs(args);
		// this.defaultVtabModuleArgs = [...args]; // Store a copy // Old implementation
	}

	/** @internal Sets the default args by parsing a JSON string. Should be managed by SchemaManager now. */
	setDefaultVtabArgsFromJson(argsJsonString: string): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
		warnLog("Database.setDefaultVtabArgsFromJson is forwarding to SchemaManager. Use PRAGMA or direct SchemaManager methods.");
		this.schemaManager.setDefaultVTabArgsFromJson(argsJsonString);
		// Original logic:
		// try {
		// 	const parsedArgs = JSON.parse(argsJsonString);
		// 	if (!Array.isArray(parsedArgs) || !parsedArgs.every(arg => typeof arg === 'string')) {
		// 		throw new Error("JSON value must be an array of strings.");
		// 	}
		// 	this.setDefaultVtabArgs(parsedArgs);
		// } catch (e) {
		// 	const msg = e instanceof Error ? e.message : String(e);
		// 	throw new SqliterError(`Invalid JSON for default_vtab_args: ${msg}`, StatusCode.ERROR);
		// }
	}

	/**
	 * Gets the default virtual table module name and arguments.
	 * @returns An object containing the module name and arguments.
	 */
	getDefaultVtabModule(): { name: string; args: string[] } {
		if (!this.isOpen) throw new MisuseError("Database is closed");
		// Delegate to SchemaManager
		return this.schemaManager.getDefaultVTabModule();
		// Original logic:
		// return {
		// 	name: this.defaultVtabModuleName,
		// 	args: [...this.defaultVtabModuleArgs],
		// };
	}

	/**
	 * Registers a user-defined collation sequence.
	 * @param name The name of the collation sequence (case-insensitive).
	 * @param func The comparison function (a, b) => number (-1, 0, 1).
	 * @example
	 * // Example: Create a custom collation for phone numbers
	 * db.registerCollation('PHONENUMBER', (a, b) => {
	 *   // Normalize phone numbers by removing non-digit characters
	 *   const normalize = (phone) => phone.replace(/\D/g, '');
	 *   const numA = normalize(a);
	 *   const numB = normalize(b);
	 *   return numA < numB ? -1 : numA > numB ? 1 : 0;
	 * });
	 *
	 * // Then use it in SQL:
	 * // SELECT * FROM contacts ORDER BY phone COLLATE PHONENUMBER;
	 */
	registerCollation(name: string, func: CollationFunction): void {
		if (!this.isOpen) {
			throw new SqliterError("Database is closed", StatusCode.ERROR);
		}
		registerCollation(name, func);
		log('Registered collation: %s', name);
	}

	/** @internal Gets a registered collation function */
	_getCollation(name: string): CollationFunction | undefined {
		return getCollation(name);
	}

	/**
	 * Prepares, binds parameters, executes, and yields result rows for a query.
	 * This is a high-level convenience method for iterating over query results.
	 * The underlying statement is automatically finalized when iteration completes
	 * or if an error occurs.
	 *
	 * @param sql The SQL query string to execute.
	 * @param params Optional parameters to bind (array for positional, object for named).
	 * @yields Each result row as an object (`Record<string, SqlValue>`).
	 * @returns An `AsyncIterableIterator` yielding result rows.
	 * @throws MisuseError if the database is closed.
	 * @throws SqliteError on prepare/bind/execution errors.
	 *
	 * @example
	 * ```typescript
	 * try {
	 *   for await (const user of db.eval("SELECT * FROM users WHERE status = ?", ["active"])) {
	 *     console.log(`Active user: ${user.name}`);
	 *   }
	 * } catch (e) {
	 *   console.error("Query failed:", e);
	 * }
	 * ```
	 */
	async *eval(sql: string, params?: SqlParameters): AsyncIterableIterator<Record<string, SqlValue>> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		let stmt: Statement | null = null;
		try {
			stmt = this.prepare(sql);
			if (params) { stmt.bindAll(params); }
			log(`eval loop: Starting loop for SQL: ${sql.substring(0, 50)}...`);
			while ((await stmt.step()) === StatusCode.ROW) {
				yield stmt.getAsObject();
			}
		} finally {
			if (stmt) { await stmt.finalize(); }
		}
	}

	getPlanInfo(sqlOrAst: string | AST.AstNode): QueryPlanStep[] {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		let ast: AST.AstNode;
		let originalSqlString: string | undefined = undefined;

		if (typeof sqlOrAst === 'string') {
			originalSqlString = sqlOrAst;
			const parser = new Parser();
			try {
				ast = parser.parse(originalSqlString);
			} catch (e: any) {
				errorLog("Failed to parse SQL for query plan: %O", e);
				return [{ id: 0, parentId: null, subqueryLevel: 0, op: "ERROR", detail: `Parse Error: ${e.message}` }];
			}
		} else {
			ast = sqlOrAst;
		}

		const compiler = new Compiler(this);
		if (originalSqlString) {
			compiler.sql = originalSqlString;
		} else if (ast.type !== 'select') {
			compiler.sql = ast.type.toUpperCase();
		}

		let program: VdbeProgram;
		try {
			program = compiler.compile(ast, originalSqlString ?? compiler.sql);
		} catch (e: any) {
			errorLog("Failed to compile for query plan: %O", e);
			return [{ id: 0, parentId: null, subqueryLevel: 0, op: "ERROR", detail: `Compilation Error: ${e.message}` }];
		}

		const plannedSteps = program.plannedSteps;

		if (!plannedSteps || plannedSteps.length === 0) {
			let detail = "No plan steps generated by compiler.";
			if (ast.type !== 'select' && ast.type !== 'insert' && ast.type !== 'update' && ast.type !== 'delete' && ast.type !== 'with') {
				detail = `Query Plan generation via plannedSteps focuses on SELECT, INSERT, UPDATE, DELETE, WITH (Actual type: ${ast.type.toUpperCase()})`;
			}
			return [{ id: 0, parentId: null, subqueryLevel: 0, op: "INFO", detail }];
		}

		return transformPlannedStepsToQueryPlanSteps(plannedSteps, null, 0, 0, compiler).steps;
	}
}
