import { createLogger } from '../common/logger.js';
import { MisuseError, quereusError, QuereusError } from '../common/errors.js';
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
import type { VirtualTableConnection } from '../vtab/connection.js';

import { BINARY_COLLATION, getCollation, NOCASE_COLLATION, registerCollation, RTRIM_COLLATION, type CollationFunction } from '../util/comparison.js';
import { Parser, ParseError } from '../parser/parser.js';
import * as AST from '../parser/ast.js';
import { buildBlock } from '../planner/building/block.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { RuntimeContext } from '../runtime/types.js';
import type { BlockNode } from '../planner/nodes/block.js';
import type { PlanningContext } from '../planner/planning-context.js';
import { BuildTimeDependencyTracker } from '../planner/planning-context.js';
import { ParameterScope } from '../planner/scopes/param.js';
import { GlobalScope } from '../planner/scopes/global.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import { registerEmitters } from '../runtime/register.js';
import { serializePlanTree, formatPlanTree } from '../planner/debug.js';
import type { DebugOptions } from '../planner/planning-context.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { Optimizer, DEFAULT_TUNING } from '../planner/optimizer.js';
import { registerBuiltinWindowFunctions } from '../func/builtins/builtin-window-functions.js';
import { DatabaseOptionsManager } from './database-options.js';
import type { InstructionTracer } from '../runtime/types.js';

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
	private activeConnections = new Map<string, VirtualTableConnection>();
	private inImplicitTransaction = false; // Track if we're in an implicit transaction
	public readonly optimizer: Optimizer;
	public readonly options: DatabaseOptionsManager;
	private instructionTracer: InstructionTracer | undefined;

	constructor() {
		this.schemaManager = new SchemaManager(this);
		this.options = new DatabaseOptionsManager();
		log("Database instance created.");

		// Register built-in functions
		this.registerBuiltinFunctions();

		// Register default virtual table modules via SchemaManager
		// The SchemaManager.defaultVTabModuleName is already initialized (e.g. to 'memory')
		// No need to set defaultVtabModuleName explicitly here unless it's different from SchemaManager's init value.
		// this.schemaManager.setDefaultVTabModuleName('memory'); // Already 'memory' by default in SchemaManager
		// this.schemaManager.setDefaultVTabArgs([]); // Already [] by default in SchemaManager

		this.schemaManager.registerModule('memory', new MemoryTableModule());

		// Register built-in collations
		this.registerDefaultCollations();

		// Register built-in window functions
		registerBuiltinWindowFunctions();

		registerEmitters();

		// Initialize optimizer with default tuning
		this.optimizer = new Optimizer(DEFAULT_TUNING);

		// Set up option change listeners
		this.setupOptionListeners();
	}

	/** @internal Set up listeners for option changes */
	private setupOptionListeners(): void {
		// Register core database options with their change handlers
		this.options.registerOption('runtime_stats', {
			type: 'boolean',
			defaultValue: false,
			aliases: ['runtime_metrics'],
			description: 'Enable runtime execution statistics collection'
			// No onChange needed - consumed directly when creating RuntimeContext
		});

		this.options.registerOption('validate_plan', {
			type: 'boolean',
			defaultValue: false,
			aliases: ['plan_validation'],
			description: 'Enable plan validation before execution',
			onChange: (event) => {
				const newTuning = {
					...this.optimizer.tuning,
					debug: {
						...this.optimizer.tuning.debug,
						validatePlan: event.newValue as boolean
					}
				};
				// Recreate optimizer with new tuning
				(this as any).optimizer = new Optimizer(newTuning);
				log('Optimizer recreated with validate_plan = %s', event.newValue);
			}
		});

		this.options.registerOption('default_vtab_module', {
			type: 'string',
			defaultValue: 'memory',
			description: 'Default virtual table module name',
			onChange: (event) => {
				this.schemaManager.setDefaultVTabModuleName(event.newValue as string);
			}
		});

		this.options.registerOption('default_vtab_args', {
			type: 'object',
			defaultValue: {},
			description: 'Default virtual table module arguments',
			onChange: (event) => {
				this.schemaManager.setDefaultVTabArgs(event.newValue as Record<string, any>);
			}
		});

		this.options.registerOption('default_column_nullability', {
			type: 'string',
			defaultValue: 'not_null',
			aliases: ['column_nullability_default', 'nullable_default'],
			description: 'Default nullability for columns: "nullable" (SQL standard) or "not_null" (Third Manifesto)',
			onChange: (event) => {
				const value = event.newValue as string;
				if (value !== 'nullable' && value !== 'not_null') {
					throw new QuereusError(`Invalid default_column_nullability value: ${value}. Must be "nullable" or "not_null"`, StatusCode.ERROR);
				}
				log('Default column nullability changed to: %s', value);
			}
		});

		this.options.registerOption('trace_plan_stack', {
			type: 'boolean',
			defaultValue: false,
			description: 'Enable plan stack tracing',
		});
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
				await this.beginImplicitTransaction();
			}

			for (let i = 0; i < batch.length; i++) {
				const statementAst = batch[i];
				let plan: BlockNode;

				try {
					plan = this._buildPlan([statementAst], params);

					if (plan.statements.length === 0) continue; // No-op for this AST

					const optimizedPlan = this.optimizer.optimize(plan, this) as BlockNode;

					const emissionContext = new EmissionContext(this);
					const rootInstruction = emitPlanNode(optimizedPlan, emissionContext);

					const scheduler = new Scheduler(rootInstruction);

					const runtimeCtx: RuntimeContext = {
						db: this,
						stmt: null as any, // No persistent Statement object for transient exec statements
						params: params ?? {},
						context: new Map(),
						tableContexts: new Map(),
						tracer: this.instructionTracer,
						enableMetrics: this.options.getBooleanOption('runtime_stats'),
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
						await this.rollbackImplicitTransaction();
					} else {
						await this.commitImplicitTransaction();
					}
				} catch (txError) {
					errorLog(`Error during implicit transaction ${executionError ? 'rollback' : 'commit'}: %O`, txError);
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

		// Disconnect all active connections first
		await this.disconnectAllConnections();

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
			if (e instanceof Error) throw e; else quereusError(String(e));
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
			{ name, numArgs: options.numArgs, flags, initialValue: options.initialState },
			stepFunc,
			finalFunc
		);

		try {
			this.schemaManager.getMainSchema().addFunction(schema);
		} catch (e) {
			errorLog(`Failed to register aggregate function ${name}/${options.numArgs}: %O`, e);
			if (e instanceof Error) throw e; else quereusError(String(e));
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
			if (e instanceof Error) throw e; else quereusError(String(e));
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
	 * Set database configuration options
	 * @param option The option name
	 * @param value The option value
	 */
	setOption(option: string, value: any): void {
		this.checkOpen();
		this.options.setOption(option, value);
	}

	/**
	 * Get database configuration option value
	 * @param option The option name
	 * @returns The option value
	 */
	getOption(option: string): any {
		this.checkOpen();
		return this.options.getOption(option);
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

	/**
	 * Sets the instruction tracer for this database.
	 * The tracer will be used for all statement executions.
	 * @param tracer The instruction tracer to use, or null to disable tracing.
	 */
	setInstructionTracer(tracer: InstructionTracer | undefined): void {
		this.instructionTracer = tracer;
		log('Instruction tracer %s', tracer ? 'enabled' : 'disabled');
	}

	/**
	 * Gets the current instruction tracer for this database.
	 * @returns The instruction tracer, or undefined if none is set.
	 */
	getInstructionTracer(): InstructionTracer | undefined {
		return this.instructionTracer;
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

		const plan = this._buildPlan([ast as AST.Statement]);

		if (plan.statements.length === 0) return plan; // No-op for this AST

		return this.optimizer.optimize(plan, this) as BlockNode;
	}

	/**
	 * Gets a detailed representation of the query plan for debugging.
	 * @param sql The SQL statement to plan.
	 * @param options Optional formatting options. If not provided, uses concise tree format.
	 * @returns String containing the formatted plan tree.
	 */
	getDebugPlan(sql: string, options?: { verbose?: boolean; expandNodes?: string[]; maxDepth?: number }): string {
		this.checkOpen();
		const plan = this.getPlan(sql);
		
		if (options?.verbose) {
			// Use the original detailed JSON format
			return serializePlanTree(plan);
		} else {
			// Use the new concise tree format
			return formatPlanTree(plan, {
				concise: true,
				expandNodes: options?.expandNodes || [],
				maxDepth: options?.maxDepth,
				showPhysical: true
			});
		}
	}

	/**
	 * Prepares a statement with debug options enabled.
	 * @param sql The SQL statement to prepare.
	 * @param debug Debug options to enable.
	 * @returns A Statement with debug capabilities.
	 */
	prepareDebug(sql: string, debug: DebugOptions): Statement {
		this.checkOpen();
		log('Preparing SQL with debug options: %s', sql);

		const stmt = new Statement(this, sql);
		// Set debug options on the statement
		(stmt as any)._debugOptions = debug;

		this.statements.add(stmt);
		return stmt;
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

		const ctx: PlanningContext = {
			db: this,
			schemaManager: this.schemaManager,
			parameters: params ?? {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map()
		};

		return buildBlock(ctx, statements);
	}

	/**
	 * @internal Registers an active VirtualTable connection for transaction management.
	 * @param connection The connection to register
	 */
	async registerConnection(connection: VirtualTableConnection): Promise<void> {
		this.activeConnections.set(connection.connectionId, connection);
		debugLog(`Registered connection ${connection.connectionId} for table ${connection.tableName}`);

		// If we're already in a transaction (implicit or explicit),
		// start a transaction on this new connection
		if (this.inTransaction) {
			try {
				await connection.begin();
				debugLog(`Started transaction on newly registered connection ${connection.connectionId}`);
			} catch (error) {
				errorLog(`Error starting transaction on newly registered connection ${connection.connectionId}: %O`, error);
				// Don't throw here - just log the error to avoid breaking connection registration
			}
		}
	}

	/**
	 * @internal Unregisters an active VirtualTable connection.
	 * @param connectionId The ID of the connection to unregister
	 */
	unregisterConnection(connectionId: string): void {
		const connection = this.activeConnections.get(connectionId);
		if (connection) {
			// Don't disconnect during implicit transactions - let the transaction coordinate
			if (this.inImplicitTransaction) {
				debugLog(`Deferring disconnect of connection ${connectionId} until implicit transaction completes`);
				return;
			}

			this.activeConnections.delete(connectionId);
			debugLog(`Unregistered connection ${connectionId} for table ${connection.tableName}`);
		}
	}

	/**
	 * @internal Gets an active connection by ID.
	 * @param connectionId The connection ID to look up
	 * @returns The connection if found, undefined otherwise
	 */
	getConnection(connectionId: string): VirtualTableConnection | undefined {
		return this.activeConnections.get(connectionId);
	}

	/**
	 * @internal Gets all active connections for a specific table.
	 * @param tableName The name of the table
	 * @returns Array of connections for the table
	 */
	getConnectionsForTable(tableName: string): VirtualTableConnection[] {
		return Array.from(this.activeConnections.values())
			.filter(conn => conn.tableName === tableName);
	}

	/**
	 * @internal Gets all active connections.
	 * @returns Array of all active connections
	 */
	getAllConnections(): VirtualTableConnection[] {
		return Array.from(this.activeConnections.values());
	}

	/**
	 * Disconnects and removes all active connections.
	 * Called during database close.
	 */
	private async disconnectAllConnections(): Promise<void> {
		const connections = Array.from(this.activeConnections.values());
		debugLog(`Disconnecting ${connections.length} active connections`);

		const disconnectPromises = connections.map(async (conn) => {
			try {
				await conn.disconnect();
			} catch (error) {
				errorLog(`Error disconnecting connection ${conn.connectionId}: %O`, error);
			}
		});

		await Promise.allSettled(disconnectPromises);
		this.activeConnections.clear();
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

	/**
	 * Begin an implicit transaction and coordinate with virtual table connections
	 */
	private async beginImplicitTransaction(): Promise<void> {
		debugLog("Database: Starting implicit transaction for multi-statement block.");

		this.inImplicitTransaction = true;

		// Begin transaction on all active connections first
		const connections = this.getAllConnections();
		for (const connection of connections) {
			try {
				await connection.begin();
			} catch (error) {
				errorLog(`Error beginning transaction on connection ${connection.connectionId}: %O`, error);
				throw error;
			}
		}

		// Then set database state
		this.inTransaction = true;
		this.isAutocommit = false;
	}

	/**
	 * Commit an implicit transaction and coordinate with virtual table connections
	 */
	private async commitImplicitTransaction(): Promise<void> {
		debugLog("Database: Committing implicit transaction.");

		// Commit all active connections first
		const connections = this.getAllConnections();
		const commitPromises = connections.map(async (connection) => {
			try {
				await connection.commit();
			} catch (error) {
				errorLog(`Error committing transaction on connection ${connection.connectionId}: %O`, error);
				throw error;
			}
		});

		await Promise.all(commitPromises);

		// Reset database state
		this.inTransaction = false;
		this.isAutocommit = true;
		this.inImplicitTransaction = false;

		// DON'T disconnect connections after successful commit - leave them for subsequent queries
		// The data in committed connections should be visible to future operations
	}

	/**
	 * Rollback an implicit transaction and coordinate with virtual table connections
	 */
	private async rollbackImplicitTransaction(): Promise<void> {
		debugLog("Database: Rolling back implicit transaction.");

		// Rollback all active connections
		const connections = this.getAllConnections();
		const rollbackPromises = connections.map(async (connection) => {
			try {
				await connection.rollback();
			} catch (error) {
				errorLog(`Error rolling back transaction on connection ${connection.connectionId}: %O`, error);
				// Don't throw here - we want to rollback as many as possible
			}
		});

		await Promise.allSettled(rollbackPromises);

		// Reset database state
		this.inTransaction = false;
		this.isAutocommit = true;
		this.inImplicitTransaction = false;
	}
}

