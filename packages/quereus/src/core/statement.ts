import { createLogger } from '../common/logger.js';
import { type SqlValue, StatusCode, type Row, type SqlParameters, type DeepReadonly } from '../common/types.js';
import { MisuseError, QuereusError } from '../common/errors.js';
import type { Database } from './database.js';
import { isRelationType, type ColumnDef, type ScalarType } from '../common/datatype.js';
import { Parser, ParseError } from '../parser/parser.js';
import type { Statement as ASTStatement } from '../parser/ast.js';
import type { BlockNode } from '../planner/nodes/block.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { RuntimeContext } from '../runtime/types.js';
import { Cached } from '../util/cached.js';
import { isAsyncIterable } from '../runtime/utils.js';
import { generateInstructionProgram, serializePlanTree } from '../planner/debug.js';
import { EmissionContext } from '../runtime/emission-context.js';
import type { SchemaDependency } from '../planner/planning-context.js';
import { getParameterTypes } from './param.js';
import { getPhysicalType, physicalTypeName, PhysicalType } from '../types/logical-type.js';

const log = createLogger('core:statement');
const errorLog = log.extend('error');
const warnLog = log.extend('warn');

/**
 * Represents a prepared SQL statement.
 */
export class Statement {
	public readonly db: Database;
	public readonly originalSql: string;
	public readonly astBatch: ASTStatement[];
	private astBatchIndex: number = -1;
	private finalized = false;
	private busy = false;
	private boundArgs: Record<number | string, SqlValue> = {};
	private plan: BlockNode | null = null;
	private emissionContext: EmissionContext | null = null;
	private needsCompile = true;
	private columnDefCache = new Cached<DeepReadonly<ColumnDef>[]>(() => this.getColumnDefs());
	private schemaChangeUnsubscriber: (() => void) | null = null;
	/** Parameter types established at prepare time (either explicit or inferred from initial values) */
	private parameterTypes: Map<string | number, ScalarType> | undefined = undefined;

	/**
	 * @internal - Use db.prepare().
	 * The `sqlOrAstBatch` can be a single SQL string (parsed internally) or a pre-parsed batch.
	 * `initialAstIndex` is for internal use when db.prepare might create one Statement per AST in a batch.
	 * `paramsOrTypes` can be initial parameter values (to infer types) or explicit types.
	 */
	constructor(
		db: Database,
		sqlOrAstBatch: string | ASTStatement[],
		initialAstIndex: number = 0,
		paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>
	) {
		this.db = db;
		if (typeof sqlOrAstBatch === 'string') {
			this.originalSql = sqlOrAstBatch;
			const parser = new Parser();
			try {
				this.astBatch = parser.parseAll(this.originalSql);
			} catch (e) {
				if (e instanceof ParseError) throw new QuereusError(`Parse error: ${e.message}`, StatusCode.ERROR, e);
				throw e;
			}
		} else {
			this.astBatch = sqlOrAstBatch;
			// Try to reconstruct originalSql if possible, or set a generic name
			this.originalSql = this.astBatch.map(s => s.toString()).join('; '); // TODO: replace with better AST stringification
		}

		// Handle explicit parameter types or initial values
		if (paramsOrTypes instanceof Map) {
			// Explicit parameter types provided
			this.parameterTypes = paramsOrTypes;
		} else if (paramsOrTypes !== undefined) {
			// Initial parameter values - infer types and bind them
			this.parameterTypes = getParameterTypes(paramsOrTypes);
			// Also bind the initial values
			if (Array.isArray(paramsOrTypes)) {
				paramsOrTypes.forEach((value, index) => {
					this.boundArgs[index + 1] = value;
				});
			} else {
				Object.assign(this.boundArgs, paramsOrTypes);
			}
		}

		if (this.astBatch.length === 0 && initialAstIndex === 0) {
			// No statements to run, effectively. nextStatement will return false.
			this.astBatchIndex = -1;
			this.needsCompile = false;
		} else if (initialAstIndex >= 0 && initialAstIndex < this.astBatch.length) {
			this.astBatchIndex = initialAstIndex;
			this.needsCompile = true; // Start by needing to compile the first indicated statement
		} else {
			throw new MisuseError("Initial AST index out of bounds for provided batch.");
		}
	}

	/** Advances to the next statement in the batch. Returns false if no more statements. */
	public nextStatement(): boolean {
		this.validateStatement("advance from");
		if (this.busy) throw new MisuseError("Statement busy, reset or complete current iteration first.");
		if (this.astBatchIndex < this.astBatch.length - 1) {
			this.astBatchIndex++;
			this.plan = null;
			this.emissionContext = null;
			this.needsCompile = true;
			this.columnDefCache.clear();
			this.parameterTypes = undefined;
			return true;
		} else {
			return false;
		}
	}

	/** Returns the SQL fragment for the current statement, if available. */
	public getBlockSql(): string {
		if (this.astBatchIndex < 0 || this.astBatchIndex >= this.astBatch.length) {
			return "";
		}
		return this.getAstStatement().toString();	// TODO: replace with better AST stringification
	}

	/** @internal Plans the current AST statement */
	public compile(): BlockNode {
		if (this.plan && !this.needsCompile) return this.plan;

		this.validateStatement("compile/plan");
		this.columnDefCache.clear();

		log("Planning current statement (new runtime): %s", this.getBlockSql().substring(0, 100));
		let plan: BlockNode | undefined;
		try {
			const currentAst = this.getAstStatement();

			// On first compilation, establish the parameter types
			// Use explicit types if provided, otherwise infer from bound args
			if (this.parameterTypes === undefined) {
				// Infer types from current bound args
				this.parameterTypes = getParameterTypes(this.boundArgs);
			}

			// Pass parameter types directly to planning
			const planResult = this.db._buildPlan([currentAst], this.parameterTypes);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const dependencies = (planResult as any).schemaDependencies; // Extract dependencies from planning context
			plan = this.db.optimizer.optimize(planResult, this.db) as BlockNode;

			// Set up schema change invalidation if we have dependencies
			if (dependencies && dependencies.hasAnyDependencies()) {
				// Remove any existing listener
				if (this.schemaChangeUnsubscriber) {
					this.schemaChangeUnsubscriber();
				}

				// Add new listener for schema changes that affect our dependencies
				this.schemaChangeUnsubscriber = this.db.schemaManager.getChangeNotifier().addListener(event => {
					// Map event type to dependency type
					let dependencyType: string;
					if (event.type.startsWith('table_')) {
						dependencyType = 'table';
					} else if (event.type.startsWith('function_')) {
						dependencyType = 'function';
					} else if (event.type.startsWith('module_')) {
						dependencyType = 'vtab_module';
					} else if (event.type.startsWith('collation_')) {
						dependencyType = 'collation';
					} else {
						return; // Unknown event type
					}

					// Check if this change affects any of our dependencies
					const planDependencies = dependencies.getDependencies();
					const affectedDependency = planDependencies.find((dep: SchemaDependency) =>
						dep.type === dependencyType &&
						dep.objectName === event.objectName &&
						(!dep.schemaName || dep.schemaName === event.schemaName)
					);

					if (affectedDependency) {
						log('Schema change invalidated plan for statement: %s %s', event.type, event.objectName);
						this.needsCompile = true;
						this.plan = null;
						this.emissionContext = null;
						this.columnDefCache.clear();
					}
				});
			}

			this.needsCompile = false;
			log("Planning complete for current statement.");
		} catch (e) {
			errorLog("Planning failed for current statement: %O", e);
			if (e instanceof QuereusError) throw e;
			if (e instanceof Error) throw new QuereusError(`Planning error: ${e.message}`, StatusCode.INTERNAL, e);
			throw new QuereusError("Unknown planning error", StatusCode.INTERNAL);
		}
		if (!plan) throw new QuereusError("Planning resulted in no plan for current statement", StatusCode.INTERNAL);
		this.plan = plan;
		return plan;
	}

	/** @internal Gets or creates the emission context for this statement */
	private getEmissionContext(): EmissionContext {
		if (!this.emissionContext) {
			this.emissionContext = new EmissionContext(this.db);
		}
		return this.emissionContext;
	}

	/**
	 * Binds a user-provided argument value to a declared parameter name/index for the current statement.
	 */
	bind(key: number | string, value: SqlValue): this {
		this.validateStatement("bind argument for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		if (typeof key === 'number') {
			if (key < 1) throw new RangeError(`Argument index ${key} out of range (must be >= 1)`);
			this.boundArgs[key] = value;
		} else if (typeof key === 'string') {
			this.boundArgs[key] = value;
		} else {
			throw new MisuseError("Invalid argument key type");
		}
		return this;
	}

	/**
	 * Binds all user-provided argument values for the current statement.
	 */
	bindAll(args: SqlParameters | SqlValue[]): this {
		this.validateStatement("bind all parameters for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		this.boundArgs = {};
		if (Array.isArray(args)) {
			// Convert array to object with 1-based keys to match parameter indexing
			const convertedArgs: Record<string, SqlValue> = {};
			args.forEach((value, index) => {
				convertedArgs[String(index + 1)] = value; // 1-based indexing
			});
			Object.assign(this.boundArgs, convertedArgs);
		} else if (typeof args === 'object' && args !== null) {
			Object.assign(this.boundArgs, args);
		} else {
			throw new MisuseError("Invalid parameters type for bindAll. Use array or object.");
		}
		return this;
	}

	/** Checks if the current statement, when executed, is expected to produce rows. */
	public isQuery(): boolean {
		this.validateStatement("check if query");
		const blockPlan = this.compile();
		if (!blockPlan || blockPlan.statements.length === 0) return false;
		const lastStatementInBlock = blockPlan.statements[blockPlan.statements.length - 1];
		const relationType = lastStatementInBlock.getType();
		return isRelationType(relationType);
	}

	async *iterateRows(params?: SqlParameters | SqlValue[]): AsyncIterable<Row> {
		this.validateStatement("iterate rows for");
		if (this.busy) throw new MisuseError("Statement busy, another iteration may be in progress or reset needed.");

		if (params) this.bindAll(params);

		// Validate parameter types before execution
		this.validateParameterTypes();

		this.busy = true;
		try {
			const blockPlanNode = this.compile();
			if (!blockPlanNode.statements.length) return;

			const emissionContext = this.getEmissionContext();
			const rootInstruction = emitPlanNode(blockPlanNode, emissionContext);
			const scheduler = new Scheduler(rootInstruction);
			const runtimeCtx: RuntimeContext = {
				db: this.db,
				stmt: this,
				params: this.boundArgs,
				context: new Map(),
				tableContexts: new Map(),
				tracer: this.db.getInstructionTracer(),
				enableMetrics: Boolean(this.db.getOption('runtime_metrics')),
			};

			const results = await scheduler.run(runtimeCtx);
			if (results) {
				if (Array.isArray(results) && results.length) {
					const lastStatementOutput = results[results.length - 1];
					if (isAsyncIterable(lastStatementOutput)) {
						yield* lastStatementOutput as AsyncIterable<Row>;
					}
				} else if (isAsyncIterable(results)) {
					yield* results as AsyncIterable<Row>;
				}
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			errorLog('Runtime execution failed in iterateRows for current statement: %O', e);
			if (e instanceof QuereusError) throw e;
			throw new QuereusError(`Execution error: ${e.message}`, StatusCode.ERROR, e);
		} finally {
			this.busy = false;
		}
	}

	getColumnNames(): string[] {
		this.validateStatement("get column names for");
		return this.columnDefCache.value.map(col => col.name);
	}

	/**
	 * Resets the prepared statement to its initial state, ready to be re-executed.
	 */
	async reset(): Promise<void> {
		this.validateStatement("reset");
		if (this.busy) {
			warnLog("Statement reset while busy. Iteration may not have completed.");
		}
		this.busy = false;
	}

	/**
	 * Clears all bound parameter values.
	 * Note: This does NOT trigger recompilation - parameter types are preserved.
	 */
	clearBindings(): this {
		this.validateStatement("clear bindings for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		this.boundArgs = {};
		// Don't set needsCompile - parameter types are preserved
		return this;
	}

	/**
	 * Finalizes the statement, releasing associated resources.
	 */
	async finalize(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		this.busy = false;
		this.boundArgs = {};
		this.plan = null;
		this.emissionContext = null;
		this.columnDefCache.clear();
		this.astBatchIndex = -1;

		// Clean up schema change listener
		if (this.schemaChangeUnsubscriber) {
			this.schemaChangeUnsubscriber();
			this.schemaChangeUnsubscriber = null;
		}

		this.db._statementFinalized(this);
	}

	/**
	 * Executes the prepared statement with the given parameters until completion.
	 * Automatically wraps execution in an implicit transaction if in autocommit mode
	 * and not already in an explicit transaction.
	 */
	async run(params?: SqlParameters | SqlValue[]): Promise<void> {
		this.validateStatement("run");

		const needsImplicitTransaction = this.db.getAutocommit();

		let executionError: Error | null = null;
		try {
			if (needsImplicitTransaction) {
				await this.db._beginImplicitTransaction();
			}

			try {
				for await (const _ of this.iterateRows(params)) {
					/* Consume all rows */
				}
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				executionError = error instanceof QuereusError ? error : new QuereusError(error.message, StatusCode.ERROR, error);
			}

		} finally {
			if (needsImplicitTransaction) {
				if (executionError) {
					await this.db._rollbackImplicitTransaction();
				} else {
					await this.db._commitImplicitTransaction();
				}
			}
		}

		if (executionError) {
			throw executionError;
		}
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves the first result row.
	 */
	async get(params?: SqlParameters | SqlValue[]): Promise<Record<string, SqlValue> | undefined> {
		this.validateStatement("get first row for");
		const names = this.getColumnNames();
		for await (const rowArray of this.iterateRows(params)) {
			const rowObject = rowArray.reduce((obj, val, idx) => {
				obj[names[idx] || `col_${idx}`] = val;
				return obj;
			}, {} as Record<string, SqlValue>);
			return rowObject;
		}
		return undefined;
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves all result rows.
	 */
	async *all(params?: SqlParameters | SqlValue[]): AsyncIterable<Record<string, SqlValue>> {
		this.validateStatement("get all rows for");
		const names = this.getColumnNames();
		for await (const rowArray of this.iterateRows(params)) {
			const rowObject = rowArray.reduce((obj, val, idx) => {
				obj[names[idx] || `col_${idx}`] = val;
				return obj;
			}, {} as Record<string, SqlValue>);
			yield rowObject;
		}
	}

	/**
	 * Gets the parameters required by the current statement.
	 */
	getParameters(): SqlParameters {
		this.validateStatement("get parameters for");
		const blockPlan = this.compile();
		return { ...blockPlan.parameters };
	}

	/**
	 * Gets the data type of a column in the current row.
	 */
	getColumnType(index: number): Readonly<ScalarType> {
		this.validateStatement("get column type for");
		const columnDefs = this.columnDefCache.value;
		if (index < 0 || index >= columnDefs.length) {
			throw new RangeError(`Column index ${index} out of range.`);
		}
		return columnDefs[index].type;
	}

	/**
	 * Gets the name of a column by its index.
	 */
	getColumnName(index: number): string {
		this.validateStatement("get column name for");
		const names = this.getColumnNames();
		if (index < 0 || index >= names.length) {
			throw new RangeError(`Column index ${index} out of range (0-${names.length - 1})`);
		}
		return names[index];
	}

	getColumnDefs(): DeepReadonly<ColumnDef>[] {
		if (!this.plan) {
			if (this.astBatchIndex >= 0 && this.astBatchIndex < this.astBatch.length && this.needsCompile) {
				try { this.compile(); } catch { /*ignore compile error for _getColumnDefs, return empty */ }
			}
			if (!this.plan) return [];
		}
		const lastStatementPlanInBlock = this.plan.statements[this.plan.statements.length - 1];
		if (lastStatementPlanInBlock) {
			const relationType = lastStatementPlanInBlock.getType();
			if (isRelationType(relationType) && relationType.columns) {
				return [...relationType.columns];
			}
		}
		return [];
	}

	private validateStatement(operation: string): void {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.astBatchIndex < 0 || this.astBatchIndex >= this.astBatch.length) {
			throw new MisuseError(`No current statement selected to ${operation}. Call nextStatement() first or ensure SQL was not empty.`);
		}
	}

	private getAstStatement(): ASTStatement {
		this.validateStatement("get AST for");
		return this.astBatch[this.astBatchIndex];
	}

	/**
	 * Validates that bound parameters match the expected types from compilation.
	 * Validates that the JavaScript value is compatible with the physical type of the declared logical type.
	 * @throws QuereusError if parameter types don't match
	 */
	private validateParameterTypes(): void {
		if (!this.parameterTypes) return; // No parameter types established yet

		for (const [key, expectedType] of this.parameterTypes.entries()) {
			const value = this.boundArgs[key];

			// Allow undefined/missing parameters (they'll be caught at runtime if required)
			if (value === undefined) continue;

			// NULL is compatible with any nullable type
			if (value === null) {
				if (!expectedType.nullable) {
					throw new QuereusError(
						`Parameter type mismatch for ${typeof key === 'number' ? `?${key}` : `:${key}`}: ` +
						`expected non-nullable ${expectedType.logicalType.name}, got NULL`,
						StatusCode.MISMATCH
					);
				}
				continue;
			}

		// Get the physical type of the declared logical type
		const expectedPhysicalType = expectedType.logicalType.physicalType;

		// Get the physical type directly from the JavaScript value
		const actualPhysicalType = getPhysicalType(value);

		// Check if physical types are compatible
		// INTEGER is compatible with REAL (any integer is a valid real number)
		const isCompatible =
			actualPhysicalType === expectedPhysicalType ||
			(expectedPhysicalType === PhysicalType.REAL && actualPhysicalType === PhysicalType.INTEGER);

		if (!isCompatible) {
			throw new QuereusError(
				`Parameter type mismatch for ${typeof key === 'number' ? `?${key}` : `:${key}`}: ` +
				`expected ${expectedType.logicalType.name} (physical: ${physicalTypeName(expectedPhysicalType)}), ` +
				`got value with physical type ${physicalTypeName(actualPhysicalType)}`,
				StatusCode.MISMATCH
			);
		}
		}
	}

	/**
	 * Gets a detailed JSON representation of the query plan for debugging.
	 * @returns JSON string containing the detailed plan tree.
	 */
	getDebugPlan(): string {
		this.validateStatement("get debug plan for");
		const plan = this.compile();
		return serializePlanTree(plan);
	}

	/**
	 * Gets a human-readable instruction program for debugging.
	 * @returns String representation of the instruction program.
	 */
	getDebugProgram(): string {
		this.validateStatement("get debug program for");
		const plan = this.compile();
		const emissionContext = this.getEmissionContext();
		const rootInstruction = emitPlanNode(plan, emissionContext);
		const scheduler = new Scheduler(rootInstruction);

		return generateInstructionProgram(scheduler.instructions, scheduler.destinations);
	}
}

