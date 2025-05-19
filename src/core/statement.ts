import { createLogger } from '../common/logger.js';
import { type SqlValue, StatusCode, type Row, type SqlParameters, type SqlDataType, type DeepReadonly } from '../common/types.js';
import { MisuseError, SqliterError } from '../common/errors.js';
import type { Database } from './database.js';
import { isRelationType, type ColumnDef, type ScalarType } from '../common/datatype.js';
import { Parser, ParseError } from '../parser/parser.js';
import type { Statement as ASTStatement } from '../parser/ast.js';
import { buildBlock } from '../planner/building/block.js';
import type { BlockNode } from '../planner/nodes/block.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { RuntimeContext } from '../runtime/types.js';
import { Cached } from '../util/cached.js';

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
	private needsCompile = true;
	private columnDefCache = new Cached<DeepReadonly<ColumnDef>[]>(() => this._getColumnDefs());

	/**
	 * @internal - Use db.prepare().
	 * The `sqlOrAstBatch` can be a single SQL string (parsed internally) or a pre-parsed batch.
	 * `initialAstIndex` is for internal use when db.prepare might create one Statement per AST in a batch.
	 */
	constructor(db: Database, sqlOrAstBatch: string | ASTStatement[], initialAstIndex: number = 0) {
		this.db = db;
		if (typeof sqlOrAstBatch === 'string') {
			this.originalSql = sqlOrAstBatch;
			const parser = new Parser();
			try {
				this.astBatch = parser.parseAll(this.originalSql);
			} catch (e) {
				if (e instanceof ParseError) throw new SqliterError(`Parse error: ${e.message}`, StatusCode.ERROR, e);
				throw e;
			}
		} else {
			this.astBatch = sqlOrAstBatch;
			// Try to reconstruct originalSql if possible, or set a generic name
			this.originalSql = this.astBatch.map(s => s.toString()).join('; '); // TODO: replace with better AST stringification
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

	private _validateStatement(operation: string): void {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.astBatchIndex < 0 || this.astBatchIndex >= this.astBatch.length) {
			throw new MisuseError(`No current statement selected to ${operation}. Call nextStatement() first or ensure SQL was not empty.`);
		}
	}

	private _getAstStatement(): ASTStatement {
		this._validateStatement("get AST for");
		return this.astBatch[this.astBatchIndex];
	}

	/** Advances to the next statement in the batch. Returns false if no more statements. */
	public nextStatement(): boolean {
		this._validateStatement("advance from");
		if (this.busy) throw new MisuseError("Statement busy, reset or complete current iteration first.");
		if (this.astBatchIndex < this.astBatch.length - 1) {
			this.astBatchIndex++;
			this.plan = null;
			this.needsCompile = true;
			this.columnDefCache.clear();
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
		return this._getAstStatement().toString();	// TODO: replace with better AST stringification
	}

	/** @internal Plans the current AST statement */
	public compile(): BlockNode {
		if (this.plan && !this.needsCompile) return this.plan;
		this._validateStatement("compile/plan");

		log("Planning current statement (new runtime): %s", this.getBlockSql().substring(0,100));
		let plan: BlockNode | undefined;
		this.columnDefCache.clear();
		try {
			const currentAst = this._getAstStatement();
			plan = buildBlock([currentAst], this.db, this.boundArgs);
			this.needsCompile = false;
			log("Planning complete for current statement.");
		} catch (e) {
			errorLog("Planning failed for current statement: %O", e);
			if (e instanceof SqliterError) throw e;
			if (e instanceof Error) throw new SqliterError(`Planning error: ${e.message}`, StatusCode.INTERNAL, e);
			throw new SqliterError("Unknown planning error", StatusCode.INTERNAL);
		}
		if (!plan) throw new SqliterError("Planning resulted in no plan for current statement", StatusCode.INTERNAL);
		this.plan = plan;
		return plan;
	}

	/**
	 * Binds a user-provided argument value to a declared parameter name/index for the current statement.
	 */
	bind(key: number | string, value: SqlValue): this {
		this._validateStatement("bind argument for");
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
	bindAll(params: SqlParameters): this {
		this._validateStatement("bind all parameters for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		this.boundArgs = {};
		if (Array.isArray(params)) {
			for (let i = 0; i < params.length; i++) {
				this.boundArgs[i + 1] = params[i];
			}
		} else if (typeof params === 'object' && params !== null) {
			for (const key in params) {
				if (Object.prototype.hasOwnProperty.call(params, key)) {
					this.boundArgs[key] = params[key];
				}
			}
		} else {
			throw new MisuseError("Invalid parameters type for bindAll. Use array or object.");
		}
		return this;
	}

	/** Checks if the current statement, when executed, is expected to produce rows. */
	public isQuery(): boolean {
		this._validateStatement("check if query");
		const blockPlan = this.compile();
		if (!blockPlan || blockPlan.statements.length === 0) return false;
		const lastStatementInBlock = blockPlan.statements[blockPlan.statements.length - 1];
		const relationType = lastStatementInBlock.getType();
		return isRelationType(relationType);
	}

	private currentBlockNode(): BlockNode | null {
		this._validateStatement("get current block node for");
		return this.compile();
	}

	async *iterateRows(params?: SqlParameters): AsyncIterable<Row> {
		this._validateStatement("iterate rows for");
		if (this.busy) throw new MisuseError("Statement busy, another iteration may be in progress or reset needed.");

		if (params) this.bindAll(params);

		this.busy = true;
		try {
			const blockPlanNode = this.currentBlockNode();
			if (!blockPlanNode || blockPlanNode.statements.length === 0) {
				return;
			}

			const rootInstruction = emitPlanNode(blockPlanNode);
			const scheduler = new Scheduler(rootInstruction);
			const runtimeCtx: RuntimeContext = {
				db: this.db,
				stmt: this,
				params: this.boundArgs,
				context: new Map(),
			};

			const blockResults = await scheduler.run(runtimeCtx);

			if (!this.columnDefCache.hasValue) {
				const lastStatementPlanInBlock = blockPlanNode.statements[blockPlanNode.statements.length - 1];
				const relationType = lastStatementPlanInBlock.getType();
				if (isRelationType(relationType) && relationType.columns) {
					this.columnDefCache.value = [...relationType.columns];
				} else {
					this.columnDefCache.value = [];
				}
			}

			if (blockResults && blockResults.length > 0) {
				const lastStatementOutput = blockResults[blockResults.length - 1];
				if (lastStatementOutput && typeof (lastStatementOutput as any)[Symbol.asyncIterator] === 'function') {
					const asyncRowIterable = lastStatementOutput as AsyncIterable<Row>;
					yield* asyncRowIterable;
				} else {
					if (this.isQuery()) {
						warnLog('Current statement expected rows but did not return an async iterable.');
					}
				}
			}
		} catch (e: any) {
			errorLog('Runtime execution failed in iterateRows for current statement: %O', e);
			if (e instanceof SqliterError) throw e;
			throw new SqliterError(`Execution error: ${e.message}`, StatusCode.ERROR, e);
		} finally {
			this.busy = false;
		}
	}

	getColumnNames(): string[] {
		this._validateStatement("get column names for");
		if (this.needsCompile) this.compile();
		return this.columnDefCache.value.map(col => col.name);
	}

	private _getColumnDefs(): DeepReadonly<ColumnDef>[] {
		if (!this.plan) {
			if (this.astBatchIndex >=0 && this.astBatchIndex < this.astBatch.length && this.needsCompile) {
				try { this.compile(); } catch(e) { /*ignore compile error for _getColumnDefs, return empty */}
			}
			if(!this.plan) return [];
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

	/**
	 * Resets the prepared statement to its initial state, ready to be re-executed.
	 */
	async reset(): Promise<void> {
		this._validateStatement("reset");
		if (this.busy) {
			warnLog("Statement reset while busy. Iteration may not have completed.");
		}
		this.busy = false;
	}

	/**
	 * Clears all bound parameter values, setting them to NULL.
	 */
	clearBindings(): this {
		this._validateStatement("clear bindings for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		this.boundArgs = {};
		this.needsCompile = true;
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
		this.columnDefCache.clear();
		this.astBatchIndex = -1;
		this.db._statementFinalized(this);
	}

	/**
	 * Executes the prepared statement with the given parameters until completion.
	 */
	async run(params?: SqlParameters): Promise<void> {
		this._validateStatement("run");
		for await (const _ of this.iterateRows(params)) { /* Consume */ }
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves the first result row.
	 */
	async get(params?: SqlParameters): Promise<Record<string, SqlValue> | undefined> {
		this._validateStatement("get first row for");
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
	async *all(params?: SqlParameters): AsyncIterable<Record<string, SqlValue>> {
		this._validateStatement("get all rows for");
		const names = this.getColumnNames();
		for await (const rowArray of this.iterateRows(params)) {
			const rowObject = rowArray.reduce((obj, val, idx) => {
				obj[names[idx] || `col_${idx}`] = val;
				return obj;
			}, {} as Record<string, SqlValue>);
			yield rowObject;
		}
	}

	/** Gets the number of named or positional parameters declared by the current planned statement. */
	getParameterCount(): number {
		this._validateStatement("get parameter count for");
		const blockPlan = this.compile();
		if (blockPlan && blockPlan.scope) {
			return blockPlan.scope.getParameters().size;
		}
		return 0;
	}

	/** Gets the name of a declared parameter by its 1-based index. Returns null for unnamed (positional) params. */
	getParameterName(num: number): string | number | undefined {
		this._validateStatement("get parameter name for");
		const blockPlan = this.compile();
		if (blockPlan && blockPlan.scope) {
			return Array.from(blockPlan.scope.getParameters().keys())[num - 1];
		}
		return undefined;
	}

	/** Gets the 1-based index of a declared named parameter. Returns null if name not found. */
	getParameterIndex(name: string): number | null {
		this._validateStatement("get parameter index for");
		const blockPlan = this.compile();
		if (blockPlan && blockPlan.scope) {
			return Array.from(blockPlan.scope.getParameters().keys()).indexOf(name) + 1;
		}
		return null;
	}

	/**
	 * Gets the data type of a column in the current row.
	 */
	getColumnType(index: number): Readonly<ScalarType> {
		this._validateStatement("get column type for");
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
		this._validateStatement("get column name for");
		const names = this.getColumnNames();
		if (index < 0 || index >= names.length) {
			throw new RangeError(`Column index ${index} out of range (0-${names.length - 1})`);
		}
		return names[index];
	}
}
