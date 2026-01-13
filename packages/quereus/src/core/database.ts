import { createLogger } from '../common/logger.js';
import { MisuseError, quereusError, QuereusError } from '../common/errors.js';
import { StatusCode, type SqlParameters, type SqlValue, type Row, type OutputValue } from '../common/types.js';
import type { ScalarType } from '../common/datatype.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';
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
import type { RowDescriptor } from '../planner/nodes/plan-node.js';
import { BlockNode } from '../planner/nodes/block.js';
import type { PlanningContext } from '../planner/planning-context.js';
import { BuildTimeDependencyTracker } from '../planner/planning-context.js';
import { ParameterScope } from '../planner/scopes/param.js';
import { GlobalScope } from '../planner/scopes/global.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { FilterNode } from '../planner/nodes/filter.js';
import { BinaryOpNode } from '../planner/nodes/scalar.js';
import { ParameterReferenceNode, ColumnReferenceNode, TableReferenceNode } from '../planner/nodes/reference.js';
import { registerEmitters } from '../runtime/register.js';
import { serializePlanTree, formatPlanTree } from '../planner/debug.js';
import type { DebugOptions } from '../planner/planning-context.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { Optimizer, DEFAULT_TUNING } from '../planner/optimizer.js';
import type { OptimizerTuning } from '../planner/optimizer-tuning.js';
import { registerBuiltinWindowFunctions } from '../func/builtins/builtin-window-functions.js';
import { DatabaseOptionsManager } from './database-options.js';
import type { InstructionTracer } from '../runtime/types.js';
import { isAsyncIterable } from '../runtime/utils.js';
import { DeclaredSchemaManager } from '../schema/declared-schema-manager.js';
import { analyzeRowSpecific } from '../planner/analysis/constraint-extractor.js';
import { DeferredConstraintQueue } from '../runtime/deferred-constraint-queue.js';
import { type LogicalType } from '../types/logical-type.js';
import { getParameterTypes } from './param.js';

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
	public readonly declaredSchemaManager: DeclaredSchemaManager;
	private isOpen = true;
	private statements = new Set<Statement>();
	private isAutocommit = true; // Manages transaction state
	private inTransaction = false;
	private activeConnections = new Map<string, VirtualTableConnection>();
	private inImplicitTransaction = false; // Track if we're in an implicit transaction
	public readonly optimizer: Optimizer;
	public readonly options: DatabaseOptionsManager;
	private instructionTracer: InstructionTracer | undefined;
	/** Per-transaction change tracking: base table name → serialized PK tuples */
	private changeLog: Map<string, Set<string>> = new Map();
	/** Savepoint layers for change tracking */
	private changeLogLayers: Array<Map<string, Set<string>>> = [];
	/** Deferred constraint evaluation queue */
	private readonly deferredConstraints = new DeferredConstraintQueue(this);

	constructor() {
		this.schemaManager = new SchemaManager(this);
		this.declaredSchemaManager = new DeclaredSchemaManager();
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
				this.updateOptimizerTuning(newTuning as OptimizerTuning);
				log('Optimizer tuning updated with validate_plan = %s', event.newValue);
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
				this.schemaManager.setDefaultVTabArgs(event.newValue as Record<string, SqlValue>);
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

		this.options.registerOption('schema_path', {
			type: 'string',
			defaultValue: 'main',
			aliases: ['search_path'],
			description: 'Comma-separated list of schemas to search for unqualified table names',
			onChange: (event) => {
				const value = event.newValue as string;
				log('Schema search path changed to: %s', value);
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
	 *
	 * @param sql The SQL string to prepare.
	 * @param paramsOrTypes Optional parameter values (to infer types) or explicit type map.
	 *   - If SqlParameters: Parameter types are inferred from the values
	 *   - If Map<string|number, ScalarType>: Explicit type hints for parameters
	 *   - If undefined: Parameters default to TEXT type
	 * @returns A Statement object.
	 * @throws QuereusError on failure (e.g., syntax error).
	 *
	 * @example
	 * // Infer types from initial values
	 * const stmt = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice']);
	 *
	 * @example
	 * // Explicit param types
	 * const types = new Map([
	 *   [1, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false }],
	 *   [2, { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false }]
	 * ]);
	 * const stmt = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)', types);
	 */
	prepare(sql: string, paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>): Statement {
		this.checkOpen();
		log('Preparing SQL (new runtime): %s', sql);

		// Statement constructor defers planning/compilation until first step or explicit compile()
		const stmt = new Statement(this, sql, 0, paramsOrTypes);

		this.statements.add(stmt);
		return stmt;
	}

	/**
	 * Executes a query and returns the first result row as an object.
	 * @param sql The SQL query string to execute.
	 * @param params Optional parameters to bind.
	 * @returns A Promise resolving to the first result row as an object, or undefined if no rows.
	 * @throws QuereusError on failure.
	 */
	get(sql: string, params?: SqlParameters | SqlValue[]): Promise<Record<string, SqlValue> | undefined> {
		const stmt = this.prepare(sql, params);
		return stmt.get(params);
	}

	/**
	 * Executes one or more SQL statements directly.
	 * @param sql The SQL string(s) to execute.
	 * @param params Optional parameters to bind.
	 * @returns A Promise resolving when execution completes.
	 * @throws QuereusError on failure.
	 */
	/**
	 * @internal
	 * Executes a single AST statement without transaction management.
	 * Used by both exec() and eval() to avoid code duplication.
	 */
	private async _executeStatement(statementAst: AST.Statement, params?: SqlParameters | SqlValue[]): Promise<void> {
		const plan = this._buildPlan([statementAst], params);

		if (plan.statements.length === 0) return; // No-op for this AST

		const optimizedPlan = this.optimizer.optimize(plan, this) as BlockNode;
		const emissionContext = new EmissionContext(this);
		const rootInstruction = emitPlanNode(optimizedPlan, emissionContext);
		const scheduler = new Scheduler(rootInstruction);

		const runtimeCtx: RuntimeContext = {
			db: this,
			stmt: undefined,
			params: params ?? {},
			context: new Map(),
			tableContexts: new Map(),
			tracer: this.instructionTracer,
			enableMetrics: this.options.getBooleanOption('runtime_stats'),
		};

		await scheduler.run(runtimeCtx);
	}

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

		const needsImplicitTransaction = batch.length >= 1
			&& this.isAutocommit
			// has explicit transaction
			&& !batch.some(
				ast => ast.type === 'begin' || ast.type === 'commit' || ast.type === 'rollback' || ast.type === 'savepoint' || ast.type === 'release'
			);

		let executionError: Error | null = null;
		try {
			if (needsImplicitTransaction) {
				await this._beginImplicitTransaction();
			}

			for (let i = 0; i < batch.length; i++) {
				try {
					await this._executeStatement(batch[i], params);
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					executionError = error instanceof QuereusError ? error : new QuereusError(error.message, StatusCode.ERROR, error);
					break; // Stop processing further statements on error
				}
			}

		} finally {
			if (needsImplicitTransaction) {
				if (executionError) {
					await this._rollbackImplicitTransaction();
				} else {
					await this._commitImplicitTransaction();
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
	 * @param auxData Optional client data passed to create/connect.
	 */
	registerModule(name: string, module: AnyVirtualTableModule, auxData?: unknown): void {
		this.checkOpen();
		this.schemaManager.registerModule(name, module, auxData);
	}

	/**
	 * Begins a transaction.
	 */
	async beginTransaction(): Promise<void> {
		this.checkOpen();

		if (this.inTransaction) {
			throw new QuereusError("Transaction already active", StatusCode.ERROR);
		}

		await this.exec("BEGIN TRANSACTION");
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
		// This will also call destroy on VTabs via SchemaManager.clearAll -> schema.clearTables -> schemaManager.dropTable
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
		func: (...args: SqlValue[]) => SqlValue
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
	 * @param options Configuration: { numArgs: number, flags?: number, initialState?: unknown }.
	 * @param stepFunc The function called for each row (accumulator, ...args) => newAccumulator.
	 * @param finalFunc The function called at the end (accumulator) => finalResult.
	 */
	createAggregateFunction(
		name: string,
		options: {
			numArgs: number;
			flags?: number;
			initialState?: unknown;
		},
		stepFunc: (acc: unknown, ...args: SqlValue[]) => unknown,
		finalFunc: (acc: unknown) => SqlValue
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
	 * Sets the default schema search path for resolving unqualified table names.
	 * This is a convenience method equivalent to setting the 'schema_path' option.
	 *
	 * @param paths Array of schema names to search in order
	 *
	 * @example
	 * ```typescript
	 * db.setSchemaPath(['main', 'extensions', 'plugins']);
	 * // Now unqualified tables search: main → extensions → plugins
	 * ```
	 */
	setSchemaPath(paths: string[]): void {
		this.checkOpen();
		const pathString = paths.join(',');
		this.options.setOption('schema_path', pathString);
	}

	/**
	 * Gets the current schema search path.
	 *
	 * @returns Array of schema names in search order
	 *
	 * @example
	 * ```typescript
	 * const path = db.getSchemaPath();
	 * console.log(path); // ['main', 'extensions', 'plugins']
	 * ```
	 */
	getSchemaPath(): string[] {
		this.checkOpen();
		const pathString = this.options.getStringOption('schema_path');
		return pathString.split(',').map(s => s.trim()).filter(s => s.length > 0);
	}

	/**
	 * Set database configuration options
	 * @param option The option name
	 * @param value The option value
	 */
	setOption(option: string, value: unknown): void {
		this.checkOpen();
		this.options.setOption(option, value);
	}

	/**
	 * Get database configuration option value
	 * @param option The option name
	 * @returns The option value
	 */
	getOption(option: string): unknown {
		this.checkOpen();
		return this.options.getOption(option);
	}

	/** Update optimizer tuning in place */
	private updateOptimizerTuning(tuning: OptimizerTuning): void {
		this.optimizer.updateTuning(tuning);
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
	 * Registers a custom logical type.
	 * @param name The name of the type (case-insensitive).
	 * @param definition The LogicalType implementation.
	 * @example
	 * // Example: Create a custom UUID type
	 * db.registerType('UUID', {
	 *   name: 'UUID',
	 *   physicalType: PhysicalType.TEXT,
	 *   validate: (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
	 *   parse: (v) => typeof v === 'string' ? v.toLowerCase() : v,
	 * });
	 *
	 * // Then use it in SQL:
	 * // CREATE TABLE users (id UUID PRIMARY KEY, name TEXT);
	 */
	registerType(name: string, definition: LogicalType): void {
		this.checkOpen();
		const { registerType } = require('../types/registry.js');
		registerType(name, definition);
		log('Registered type: %s', name);
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

	/** Serialize a composite primary key tuple for set storage */
	private serializeKeyTuple(values: SqlValue[]): string {
		// JSON serialization is sufficient because SqlValue is JSON-safe in this engine
		return JSON.stringify(values);
	}

	/** Add a key tuple to the current change log for a base table */
	private addChange(baseTable: string, keyTuple: SqlValue[]): void {
		const target = this.changeLogLayers.length > 0
			? this.changeLogLayers[this.changeLogLayers.length - 1]
			: this.changeLog;
		const key = baseTable.toLowerCase();
		if (!target.has(key)) target.set(key, new Set());
		target.get(key)!.add(this.serializeKeyTuple(keyTuple));
	}

	public _queueDeferredConstraintRow(baseTable: string, constraintName: string, row: Row, descriptor: RowDescriptor, evaluator: (ctx: RuntimeContext) => OutputValue, connectionId?: string, contextRow?: Row, contextDescriptor?: RowDescriptor): void {
		this.deferredConstraints.enqueue(baseTable, constraintName, row, descriptor, evaluator, connectionId, contextRow, contextDescriptor);
	}


	/** @internal Flag to prevent new connections from starting transactions during constraint evaluation */
	private evaluatingDeferredConstraints = false;
	/** @internal Flag indicating we're in a coordinated multi-connection commit */
	private inCoordinatedCommit = false;

	public async runDeferredRowConstraints(): Promise<void> {
		this.evaluatingDeferredConstraints = true;
		try {
			await this.deferredConstraints.runDeferredRows();
		} finally {
			this.evaluatingDeferredConstraints = false;
		}
	}

	/** @internal Check if we should skip auto-beginning transactions on newly registered connections */
	public _isEvaluatingDeferredConstraints(): boolean {
		return this.evaluatingDeferredConstraints;
	}

	/** @internal Mark start of coordinated multi-connection commit */
	public _beginCoordinatedCommit(): void {
		this.inCoordinatedCommit = true;
	}

	/** @internal Mark end of coordinated multi-connection commit */
	public _endCoordinatedCommit(): void {
		this.inCoordinatedCommit = false;
	}

	/** @internal Check if we're in a coordinated commit (allows sibling layer validation) */
	public _inCoordinatedCommit(): boolean {
		return this.inCoordinatedCommit;
	}

	/** Public API used by DML emitters to record changes */
	public _recordInsert(baseTable: string, newKey: SqlValue[]): void {
		this.addChange(baseTable, newKey);
	}

	public _recordDelete(baseTable: string, oldKey: SqlValue[]): void {
		this.addChange(baseTable, oldKey);
	}

	public _recordUpdate(baseTable: string, oldKey: SqlValue[], newKey: SqlValue[]): void {
		this.addChange(baseTable, oldKey);
		// If the PK changed, also record the new key
		if (this.serializeKeyTuple(oldKey) !== this.serializeKeyTuple(newKey)) {
			this.addChange(baseTable, newKey);
		}
	}

	/** Savepoint change tracking */
	public _beginSavepointLayer(): void {
		this.changeLogLayers.push(new Map());
		this.deferredConstraints.beginLayer();
	}

	public _rollbackSavepointLayer(): void {
		// Discard the top layer
		this.changeLogLayers.pop();
		this.deferredConstraints.rollbackLayer();
	}

	public _releaseSavepointLayer(): void {
		// Merge the top layer into previous or main log
		const top = this.changeLogLayers.pop();
		if (!top) return;
		const target = this.changeLogLayers.length > 0 ? this.changeLogLayers[this.changeLogLayers.length - 1] : this.changeLog;
		for (const [table, set] of top) {
			if (!target.has(table)) target.set(table, new Set());
			const tgt = target.get(table)!;
			for (const k of set) tgt.add(k);
		}
		this.deferredConstraints.releaseLayer();
	}

	private getChangedBaseTables(): Set<string> {
		const result = new Set<string>();
		const collect = (m: Map<string, Set<string>>) => {
			for (const [t, s] of m) { if (s.size > 0) result.add(t); }
		};
		collect(this.changeLog);
		for (const layer of this.changeLogLayers) collect(layer);
		return result;
	}

	public _clearChangeLog(): void {
		this.changeLog.clear();
		this.changeLogLayers = [];
		this.deferredConstraints.clear();
	}

	/**
	 * Marks that an explicit SQL BEGIN has started a transaction.
	 * Ensures subsequently registered connections also begin a transaction.
	 */
	public markExplicitTransactionStart(): void {
		this.inTransaction = true;
		this.isAutocommit = false;
	}

	/**
	 * Marks that an explicit SQL COMMIT/ROLLBACK has ended the transaction.
	 */
	public markExplicitTransactionEnd(): void {
		this.inTransaction = false;
		this.isAutocommit = true;
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

			if (stmt.astBatch.length === 0) {
				// No statements, yield nothing.
				return;
			}

			if (stmt.astBatch.length > 1) {
				// Multi-statement batch: execute all but the last statement,
				// then yield results from the last statement
				const parser = new Parser();
				const batch = parser.parseAll(sql);

				// Execute all statements except the last one
				for (let i = 0; i < batch.length - 1; i++) {
					await this._executeStatement(batch[i], params);
				}

				// Now prepare and execute the last statement to yield its results
				const lastStmt = new Statement(this, [batch[batch.length - 1]]);
				this.statements.add(lastStmt);
				try {
					yield* lastStmt.all(params);
				} finally {
					await lastStmt.finalize();
				}
			} else {
				// Single statement: execute and yield results
				yield* stmt.all(params);
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
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				errorLog("Failed to parse SQL for query plan: %O", error);
				throw error;
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
		(stmt as Statement & { _debugOptions?: DebugOptions })._debugOptions = debug;

		this.statements.add(stmt);
		return stmt;
	}

	/** @internal */
	_getVtabModule(name: string): { module: AnyVirtualTableModule, auxData?: unknown } | undefined {
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
	_buildPlan(statements: AST.Statement[], paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>) {
		const globalScope = new GlobalScope(this.schemaManager);

		// If we received parameter values, infer their types
		// If we received explicit parameter types, use them as-is
		const parameterTypes = paramsOrTypes instanceof Map
			? paramsOrTypes
			: getParameterTypes(paramsOrTypes);

		// This ParameterScope is for the entire batch. It has globalScope as its parent.
		const parameterScope = new ParameterScope(globalScope, parameterTypes);

		// Get default schema path from options
		const schemaPathString = this.options.getStringOption('schema_path');
		const schemaPath = schemaPathString ? schemaPathString.split(',').map(s => s.trim()).filter(s => s.length > 0) : undefined;

		const ctx: PlanningContext = {
			db: this,
			schemaManager: this.schemaManager,
			parameters: paramsOrTypes instanceof Map ? {} : (paramsOrTypes ?? {}),
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
			schemaPath
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
		// start a transaction on this new connection UNLESS we're evaluating deferred constraints
		// (during which subqueries should read committed state without creating new transaction layers)
		if (this.inTransaction && !this.evaluatingDeferredConstraints) {
			try {
				await connection.begin();
				debugLog(`Started transaction on newly registered connection ${connection.connectionId}`);
			} catch (error) {
				errorLog(`Error starting transaction on newly registered connection ${connection.connectionId}: %O`, error);
				// Don't throw here - just log the error to avoid breaking connection registration
			}
		} else if (this.evaluatingDeferredConstraints) {
			debugLog(`Skipped transaction begin on connection ${connection.connectionId} (evaluating deferred constraints)`);
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
		const normalized = tableName.toLowerCase();
		const simpleName = normalized.includes('.') ? normalized.substring(normalized.lastIndexOf('.') + 1) : normalized;
		return Array.from(this.activeConnections.values())
			.filter(conn => {
				const connName = conn.tableName.toLowerCase();
				return connName === normalized || connName === simpleName;
			});
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

	/**
	 * Begin an implicit transaction and coordinate with virtual table connections
	 */
	/** @internal Begin an implicit transaction */
	async _beginImplicitTransaction(): Promise<void> {
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
	 * @internal
	 */
	async _commitImplicitTransaction(): Promise<void> {
		debugLog("Database: Committing implicit transaction.");

		try {
			const connectionsToCommit = this.getAllConnections();

			// Evaluate global assertions and deferred row constraints BEFORE committing connections. If violated, rollback and abort.
			await this.runGlobalAssertions();
			await this.runDeferredRowConstraints();

			// Mark coordinated commit to relax layer validation for sibling layers
			this._beginCoordinatedCommit();
			try {
				// Commit only the original connections (not any opened during constraint evaluation)
				// Commit sequentially to avoid race conditions with layer promotion
				for (const connection of connectionsToCommit) {
					try {
						await connection.commit();
					} catch (error) {
						errorLog(`Error committing transaction on connection ${connection.connectionId}: %O`, error);
						throw error;
					}
				}
			} finally {
				this._endCoordinatedCommit();
			}
		} catch (e) {
			// On pre-commit assertion failure (or commit error), rollback all connections
			const conns = this.getAllConnections();
			await Promise.allSettled(conns.map(c => c.rollback()));
			throw e;
		} finally {
			this.inTransaction = false;
			this.isAutocommit = true;
			this.inImplicitTransaction = false;
			this._clearChangeLog();
		}
	}

	public async runGlobalAssertions(): Promise<void> {
		const assertions = this.schemaManager.getAllAssertions();
		if (assertions.length === 0) return;

		// Only evaluate assertions impacted by changed base tables
		const changedBases = this.getChangedBaseTables();
		if (changedBases.size === 0) return;

		for (const assertion of assertions) {
			const planSql = assertion.violationSql;
			const parser = new Parser();
			let ast: AST.Statement;
			try {
				ast = parser.parse(planSql) as AST.Statement;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				throw new QuereusError(
					`Failed to parse deferred assertion '${assertion.name}': ${error.message}`,
					StatusCode.INTERNAL,
					error
				);
			}
			const plan = this._buildPlan([ast]) as BlockNode;
			const analyzed = this.optimizer.optimizeForAnalysis(plan, this) as BlockNode;

			// Collect base tables and relationKeys in this plan
			const relationKeyToBase = new Map<string, string>();
			const baseTablesInPlan = new Set<string>();
			this.collectTables(analyzed, relationKeyToBase, baseTablesInPlan);

			// Determine impact: if assertion has no dependencies, treat as global and always impacted.
			const hasDeps = baseTablesInPlan.size > 0;
			let impacted = !hasDeps;
			if (hasDeps) {
				for (const b of baseTablesInPlan) { if (changedBases.has(b)) { impacted = true; break; } }
			}
			if (!impacted) continue;

			// Classify instances as row/global
			const classifications: Map<string, 'row' | 'global'> = analyzeRowSpecific(analyzed as unknown as RelationalPlanNode);

			// If any changed base appears as a global instance, run full violation query once
			let requiresGlobal = false;
			for (const [relKey, klass] of classifications) {
				if (klass === 'global') {
					const base = relationKeyToBase.get(relKey);
					if (base && changedBases.has(base)) { requiresGlobal = true; break; }
				}
			}

			if (requiresGlobal) {
				await this.executeViolationOnce(assertion.name, assertion.violationSql);
				continue;
			}

			// Collect row-specific references that correspond to changed bases
			const rowSpecificChanged: Array<{ relKey: string; base: string }> = [];
			for (const [relKey, klass] of classifications) {
				if (klass !== 'row') continue;
				const base = relationKeyToBase.get(relKey);
				if (base && changedBases.has(base)) rowSpecificChanged.push({ relKey, base });
			}

			if (rowSpecificChanged.length === 0) {
				// No row-specific changed refs (or no refs at all) → run once globally.
				await this.executeViolationOnce(assertion.name, assertion.violationSql);
				continue;
			}

			// Execute parameterized variants per changed key for each row-specific reference; early-exit on violation
			for (const { relKey, base } of rowSpecificChanged) {
				await this.executeViolationPerChangedKeys(assertion.name, assertion.violationSql, analyzed, relKey, base);
			}
		}
	}

	private async executeViolationOnce(assertionName: string, sql: string): Promise<void> {
		const stmt = await this.prepare(sql);
		try {
			for await (const _ of stmt.all()) {
				throw new QuereusError(`Integrity assertion failed: ${assertionName}`, StatusCode.CONSTRAINT);
			}
		} finally {
			await stmt.finalize();
		}
	}

	/** Execute a parameterized variant of the assertion once per changed key for a specific row-specific relationKey. */
	private async executeViolationPerChangedKeys(
		assertionName: string,
		violationSql: string,
		analyzed: BlockNode,
		targetRelationKey: string,
		base: string
	): Promise<void> {
		const changedKeyTuples = this.getChangedKeyTuples(base);
		if (changedKeyTuples.length === 0) return;

		// Find PK indices for the base table
		const [schemaName, tableName] = base.split('.');
		const table = this._findTable(tableName, schemaName);
		if (!table) {
			throw new QuereusError(`Assertion references unknown table ${base}`, StatusCode.INTERNAL);
		}
		const pkIndices = table.primaryKeyDefinition.map(def => def.index);

		// Prepare a rewritten plan with an injected Filter on the target relationKey
		const rewritten = this.injectPkFilter(analyzed, targetRelationKey, base, pkIndices);
		const optimizedPlan = this.optimizer.optimize(rewritten, this) as BlockNode;

		// Emit and execute for each changed PK tuple; stop on first violation row.
		const emissionContext = new EmissionContext(this);
		const rootInstruction = emitPlanNode(optimizedPlan, emissionContext);
		const scheduler = new Scheduler(rootInstruction);

		for (const tuple of changedKeyTuples) {
			const params: Record<string, SqlValue> = {};
			for (let i = 0; i < pkIndices.length; i++) {
				params[`pk${i}`] = tuple[i];
			}

			const runtimeCtx: RuntimeContext = {
				db: this,
				stmt: undefined,
				params,
				context: new Map(),
				tableContexts: new Map(),
				tracer: this.instructionTracer,
				enableMetrics: this.options.getBooleanOption('runtime_stats'),
			};

			// Run and detect first output row (violation)
			const result = await scheduler.run(runtimeCtx);
			if (isAsyncIterable(result)) {
				for await (const _ of result as AsyncIterable<unknown>) {
					throw new QuereusError(`Integrity assertion failed: ${assertionName}`, StatusCode.CONSTRAINT);
				}
			}
		}
	}

	/** Gather all changed PK tuples for a base table across layers */
	private getChangedKeyTuples(base: string): SqlValue[][] {
		const lower = base.toLowerCase();
		const tuples: SqlValue[][] = [];
		const collect = (m: Map<string, Set<string>>): void => {
			const set = m.get(lower);
			if (!set) return;
			for (const s of set) tuples.push(JSON.parse(s) as SqlValue[]);
		};
		collect(this.changeLog);
		for (const layer of this.changeLogLayers) collect(layer);
		return tuples;
	}

	/** Inject an equality Filter with named parameters :pk0, :pk1, ... at the earliest reference of targetRelationKey. */
	private injectPkFilter(block: BlockNode, targetRelationKey: string, base: string, pkIndices: number[]): BlockNode {
		const newStatements = block.getChildren().map(stmt => this.rewriteForPkFilter(stmt, targetRelationKey, base, pkIndices));
		if (newStatements.every((s, i) => s === block.getChildren()[i])) return block;
		return this.createBlockWithNewStatements(block, newStatements);
	}

	private rewriteForPkFilter(node: PlanNode, targetRelationKey: string, base: string, pkIndices: number[]): PlanNode {
		// If this node is the target TableReference instance, wrap with a Filter
		const maybe = this.tryWrapTableReference(node, targetRelationKey, base, pkIndices);
		if (maybe) return maybe;

		const originalChildren = node.getChildren();
		if (!originalChildren || originalChildren.length === 0) return node;
		const rewrittenChildren = originalChildren.map(child => this.rewriteForPkFilter(child, targetRelationKey, base, pkIndices));
		const changed = rewrittenChildren.some((c, i) => c !== originalChildren[i]);
		return changed ? node.withChildren(rewrittenChildren) : node;
	}

	private tryWrapTableReference(node: PlanNode, targetRelationKey: string, base: string, pkIndices: number[]): PlanNode | null {
		if (!(node instanceof TableReferenceNode)) return null;
		const tableSchema = node.tableSchema;
		const schemaName = tableSchema.schemaName;
		const tableName = tableSchema.name;
		const relName = `${schemaName}.${tableName}`.toLowerCase();
		const relKey = `${relName}#${node.id ?? 'unknown'}`;
		if (relKey !== targetRelationKey) return null;

		// Build predicate: AND(col_pk_i = :pk{i}) for all PK columns
		const relational = node as RelationalPlanNode;
		const scope = relational.scope;
		const attributes = relational.getAttributes();

		const makeColumnRef = (colIndex: number): ScalarPlanNode => {
			const attr = attributes[colIndex];
			const expr: AST.ColumnExpr = { type: 'column', name: attr.name, table: tableName, schema: schemaName };
			return new ColumnReferenceNode(scope, expr, attr.type, attr.id, colIndex);
		};

		const makeParamRef = (i: number, type: ScalarType): ScalarPlanNode => {
			const pexpr: AST.ParameterExpr = { type: 'parameter', name: `pk${i}` };
			return new ParameterReferenceNode(scope, pexpr, `pk${i}`, type);
		};

		let predicate: ScalarPlanNode | null = null;
		for (let i = 0; i < pkIndices.length; i++) {
			const colIdx = pkIndices[i];
			const left = makeColumnRef(colIdx);
			const right = makeParamRef(i, attributes[colIdx].type);
			const bexpr: AST.BinaryExpr = { type: 'binary', operator: '=', left: left.expression, right: right.expression };
			const eqNode = new BinaryOpNode(scope, bexpr, left, right);
			predicate = predicate
				? new BinaryOpNode(scope, { type: 'binary', operator: 'AND', left: predicate.expression, right: eqNode.expression }, predicate, eqNode)
				: eqNode;
		}

		if (!predicate) return null;

		// Wrap the table reference with a FilterNode
		return new FilterNode(scope, relational, predicate);
	}

	private collectTables(node: PlanNode, relToBase: Map<string, string>, bases: Set<string>): void {
		for (const child of node.getChildren()) {
			this.collectTables(child, relToBase, bases);
		}
		if (node instanceof TableReferenceNode) {
			const schema = node.tableSchema;
			const baseName = `${schema.schemaName}.${schema.name}`.toLowerCase();
			bases.add(baseName);
			const relKey = `${baseName}#${node.id ?? 'unknown'}`;
			relToBase.set(relKey, baseName);
		}
	}

	/**
	 * Rollback an implicit transaction and coordinate with virtual table connections
	 */
	/** @internal Rollback an implicit transaction */
	async _rollbackImplicitTransaction(): Promise<void> {
		debugLog("Database: Rolling back implicit transaction.");

		// Rollback all active connections
		const connections = this.getAllConnections();
		const rollbackPromises = connections.map(async (connection) => {
			try {
				await connection.rollback();
			} catch (error) {
				errorLog(`Error rolling back transaction on connection ${connection.connectionId}: %O`, error);
				// Continue attempting rollback for other connections.
			}
		});

		await Promise.allSettled(rollbackPromises);

		// Reset database state
		this.inTransaction = false;
		this.isAutocommit = true;
		this.inImplicitTransaction = false;
	}

	private createBlockWithNewStatements(block: BlockNode, statements: PlanNode[]): BlockNode {
		return new BlockNode(block.scope, statements, block.parameters);
	}
}

