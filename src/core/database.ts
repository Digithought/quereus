import { createLogger } from '../common/logger.js';
import { MisuseError, QuereusError } from '../common/errors.js';
import { StatusCode, type SqlParameters, type SqlValue } from '../common/types.js';
import type { VirtualTableModule } from '../vtab/module.js';
import { Statement } from './statement.js';
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
import { ExplainPlanModule } from '../vtab/explain_plan/module.js';
import { ExplainProgramModule } from '../vtab/explain_code/module.js';
import { BINARY_COLLATION, getCollation, NOCASE_COLLATION, registerCollation, RTRIM_COLLATION, type CollationFunction } from '../util/comparison.js';
import { Parser, ParseError } from '../parser/parser.js';
import * as AST from '../parser/ast.js';
import { buildBlock } from '../planner/building/block.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { RuntimeContext } from '../runtime/types.js';
import type { BlockNode } from '../planner/nodes/block.js';
import type { PlanningContext } from '../planner/planning-context.js';
import { ParameterScope } from '../planner/scopes/param.js';
import { GlobalScope } from '../planner/scopes/global.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import { registerEmitters } from '../runtime/register.js';

const log = createLogger('core:database');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log.extend('debug');

/**
 * Represents a connection to an Quereus database (in-memory in this port).
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
		this.schemaManager.registerModule('_schema', new SchemaTableModule());
		this.schemaManager.registerModule('explain_plan', new ExplainPlanModule());
		this.schemaManager.registerModule('explain_program', new ExplainProgramModule());

		// Register built-in collations
		this.registerDefaultCollations();

		registerEmitters();
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
	 * @returns A Statement object.
	 * @throws QuereusError on failure (e.g., syntax error).
	 */
	prepare(sql: string): Statement {
		this.checkOpen();
		log('Preparing SQL (new runtime): %s', sql);

		// Statement constructor defers planning/compilation until first step or explicit compile()
		const stmt = new Statement(this, sql);

		this.statements.add(stmt);
		return stmt;
	}

	/**
	 * Executes one or more SQL statements directly.
	 * @param sql The SQL string(s) to execute.
	 * @param params Optional parameters to bind.
	 * @returns A Promise resolving when execution completes.
	 * @throws QuereusError on failure.
	 */
	async exec(
		sql: string,
		params?: SqlParameters,
	): Promise<void> {
		this.checkOpen();

		log('Executing SQL block (new runtime): %s', sql);

		const parser = new Parser();
		let batch: AST.Statement[];
		try {
			batch = parser.parseAll(sql);
		} catch (e) {
			if (e instanceof ParseError) throw new QuereusError(`Parse error: ${e.message}`, StatusCode.ERROR, e);
			throw e;
		}

		if (batch.length === 0) return;

		const needsImplicitTransaction = batch.length > 1
			&& this.isAutocommit
			// has explicit transaction
			&& !batch.some(
				ast => ast.type === 'begin' || ast.type === 'commit' || ast.type === 'rollback' || ast.type === 'savepoint' || ast.type === 'release'
			);

		let executionError: Error | null = null;
		try {
			if (needsImplicitTransaction) {
				debugLog("Exec: Starting implicit transaction for multi-statement block.");
				await this.execSimple("BEGIN DEFERRED TRANSACTION"); // This will use new Statement logic
				this.inTransaction = true;
				this.isAutocommit = false;
			}

			for (let i = 0; i < batch.length; i++) {
				const statementAst = batch[i];
				let plan: BlockNode;

				try {
					plan = this._buildPlan([statementAst], params);

					if (plan.statements.length === 0) continue; // No-op for this AST

					// TODO: Optimizer/planner
					const optimizedPlan = plan;

					const rootInstruction = emitPlanNode(optimizedPlan);

					const scheduler = new Scheduler(rootInstruction);

					const runtimeCtx: RuntimeContext = {
						db: this,
						stmt: null as any, // No persistent Statement object for transient exec statements
						params: params ?? {},
						context: new Map(),
					};

					void await scheduler.run(runtimeCtx);
					// Nothing to do with the result, this is executed for side effects only

				} catch (err: any) {
					executionError = err instanceof QuereusError ? err : new QuereusError(err.message, StatusCode.ERROR, err);
					break; // Stop processing further statements on error
				}
				// No explicit finalize for transient plan/scheduler used in exec loop
			}

		} finally {
			if (needsImplicitTransaction) {
				try {
					if (executionError) {
						debugLog("Exec: Rolling back implicit transaction due to error.", executionError);
						await this.execSimple("ROLLBACK");
					} else {
						debugLog("Exec: Committing implicit transaction.");
						await this.execSimple("COMMIT");
					}
				} catch (txError) {
					errorLog(`Error during implicit transaction ${executionError ? 'rollback' : 'commit'}: %O`, txError);
				} finally {
					this.inTransaction = false;
					this.isAutocommit = true;
				}
			}
		}

		if (executionError) {
			throw executionError;
		}
	}

	/**
	 * Registers a virtual table module.
	 * @param name The name of the module.
	 * @param module The module implementation.
	 * @param auxData Optional client data passed to xCreate/xConnect.
	 */
	registerVtabModule(name: string, module: VirtualTableModule<any, any>, auxData?: unknown): void {
		this.checkOpen();
		this.schemaManager.registerModule(name, module, auxData);
	}

	/**
	 * Begins a transaction.
	 * @param mode Transaction mode ('deferred', 'immediate', or 'exclusive').
	 */
	async beginTransaction(mode: 'deferred' | 'immediate' | 'exclusive' = 'deferred'): Promise<void> {
		this.checkOpen();

		if (this.inTransaction) {
			throw new QuereusError("Transaction already active", StatusCode.ERROR);
		}

		await this.exec(`BEGIN ${mode.toUpperCase()} TRANSACTION`);
		this.inTransaction = true;
		this.isAutocommit = false;
	}

	/**
	 * Commits the current transaction.
	 */
	async commit(): Promise<void> {
		this.checkOpen();

		if (!this.inTransaction) {
			throw new QuereusError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("COMMIT");
		this.inTransaction = false;
		this.isAutocommit = true;
	}

	/**
	 * Rolls back the current transaction.
	 */
	async rollback(): Promise<void> {
		this.checkOpen();

		if (!this.inTransaction) {
			throw new QuereusError("No transaction active", StatusCode.ERROR);
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
		this.checkOpen();
		return this.isAutocommit;
	}

	/**
	 * Programmatically defines or replaces a table in the 'main' schema.
	 * This is an alternative/supplement to using `CREATE TABLE`.
	 * @param definition The schema definition for the table.
	 */
	defineTable(definition: TableSchema): void {
		this.checkOpen();
		if (definition.schemaName !== 'main') {
			throw new MisuseError("Programmatic definition only supported for 'main' schema currently");
		}

		this.schemaManager.getMainSchema().addTable(definition);
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
		this.checkOpen();

		const baseFlags = (options.deterministic ? FunctionFlags.DETERMINISTIC : 0) | FunctionFlags.UTF8;
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
		this.checkOpen();

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
		this.checkOpen();
		try {
			this.schemaManager.getMainSchema().addFunction(schema);
		} catch (e) {
			errorLog(`Failed to register function ${schema.name}/${schema.numArgs}: %O`, e);
			if (e instanceof Error) throw e; else throw new Error(String(e));
		}
	}

	/** Sets only the name of the default module. */
	setDefaultVtabName(name: string): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabModuleName(name);
	}

	/** Sets the default args directly. */
	setDefaultVtabArgs(args: Record<string, SqlValue>): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabArgs(args);
	}

	/** @internal Sets the default args by parsing a JSON string. Should be managed by SchemaManager now. */
	setDefaultVtabArgsFromJson(argsJsonString: string): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabArgsFromJson(argsJsonString);
	}

	/**
	 * Gets the default virtual table module name and arguments.
	 * @returns An object containing the module name and arguments.
	 */
	getDefaultVtabModule(): { name: string; args: Record<string, SqlValue> } {
		this.checkOpen();
		return this.schemaManager.getDefaultVTabModule();
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
		this.checkOpen();
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
	 * @throws QuereusError on prepare/bind/execution errors.
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
	async *eval(sql: string, params?: SqlParameters | SqlValue[]): AsyncIterable<Record<string, SqlValue>> {
		this.checkOpen();

		let stmt: Statement | null = null;
		try {
			stmt = this.prepare(sql);
			if (stmt.astBatch.length > 1) {
				warnLog(`Database.eval called with multi-statement SQL. Only results from the first statement will be yielded.`);
			}

			if (stmt.astBatch.length > 0) { // Check if there are any statements to execute
				// If currentAstIndex defaults to 0 and astBatch is not empty, this will run the first statement.
				yield* stmt.all(params);
			} else {
				// No statements, yield nothing.
				return;
			}
		} finally {
			if (stmt) { await stmt.finalize(); }
		}
	}

	getPlan(sqlOrAst: string | AST.AstNode): PlanNode {
		this.checkOpen();

		let ast: AST.AstNode;
		let originalSqlString: string | undefined = undefined;

		if (typeof sqlOrAst === 'string') {
			originalSqlString = sqlOrAst;
			const parser = new Parser();
			try {
				ast = parser.parse(originalSqlString);
			} catch (e: any) {
				errorLog("Failed to parse SQL for query plan: %O", e);
				throw new QuereusError(`Parse error: ${e.message}`, StatusCode.ERROR, e);
			}
		} else {
			ast = sqlOrAst;
		}

		return this._buildPlan([ast as AST.Statement]);
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

	/** @internal */
	_buildPlan(statements: AST.Statement[], params?: SqlParameters | SqlValue[]) {
		const globalScope = new GlobalScope(this.schemaManager);

		// TODO: way to generate type hints from parameters?  Maybe we should extract that from the expression context?
		// This ParameterScope is for the entire batch. It has globalScope as its parent.
		const parameterScope = new ParameterScope(globalScope);

		const ctx = { db: this, schemaManager: this.schemaManager, parameters: params ?? {}, scope: parameterScope } as PlanningContext;

		return buildBlock(ctx, statements);
	}

	private checkOpen(): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
	}

	/** Helper to execute simple commands (BEGIN, COMMIT, ROLLBACK) internally
	 * This method is for commands that don't produce rows and don't need complex parameter handling.
	*/
	private async execSimple(sqlCommand: string): Promise<void> {
		let stmt: Statement | null = null;
		try {
			stmt = this.prepare(sqlCommand);
			await stmt.run();
		} finally {
			if (stmt) {
				await stmt.finalize();
			}
		}
	}
}
