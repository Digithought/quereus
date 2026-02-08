/**
 * Global assertion evaluation for deferred constraint checking.
 *
 * This module handles the evaluation of CREATE ASSERTION constraints at transaction
 * commit time. It optimizes assertion checking by:
 * - Only evaluating assertions impacted by changed tables
 * - Using row-specific filtering when possible to avoid full table scans
 * - Injecting PK filters for parameterized per-row evaluation
 */

import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import type { ScalarType } from '../common/datatype.js';
import { Parser } from '../parser/parser.js';
import * as AST from '../parser/ast.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { RuntimeContext } from '../runtime/types.js';
import type { BlockNode } from '../planner/nodes/block.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { FilterNode } from '../planner/nodes/filter.js';
import { BinaryOpNode } from '../planner/nodes/scalar.js';
import { ParameterReferenceNode, ColumnReferenceNode, TableReferenceNode } from '../planner/nodes/reference.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { isAsyncIterable } from '../runtime/utils.js';
import { analyzeRowSpecific } from '../planner/analysis/constraint-extractor.js';
import type { Database } from './database.js';

/**
 * Interface for accessing Database internals needed by the assertion evaluator.
 * This decouples the evaluator from the full Database class.
 */
export interface AssertionEvaluatorContext {
	readonly schemaManager: Database['schemaManager'];
	readonly optimizer: Database['optimizer'];
	readonly options: Database['options'];

	_buildPlan(statements: AST.Statement[]): import('./database.js').BuildPlanResult;
	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
	prepare(sql: string): ReturnType<Database['prepare']>;
	getInstructionTracer(): ReturnType<Database['getInstructionTracer']>;

	/** Get the set of changed base tables (lowercase qualified names) */
	getChangedBaseTables(): Set<string>;
	/** Get changed PK tuples for a specific base table */
	getChangedKeyTuples(base: string): SqlValue[][];
}

/**
 * Evaluates global assertions (CREATE ASSERTION) at transaction commit time.
 *
 * Assertions are evaluated only when the tables they reference have been modified.
 * The evaluator uses constraint analysis to determine whether assertions can be
 * checked per-row (more efficient) or require a full violation query.
 */
export class AssertionEvaluator {
	constructor(private readonly ctx: AssertionEvaluatorContext) {}

	/**
	 * Run all global assertions that are impacted by changes in the current transaction.
	 * @throws QuereusError with CONSTRAINT status if any assertion is violated
	 */
	async runGlobalAssertions(): Promise<void> {
		const assertions = this.ctx.schemaManager.getAllAssertions();
		if (assertions.length === 0) return;

		const changedBases = this.ctx.getChangedBaseTables();
		if (changedBases.size === 0) return;

		for (const assertion of assertions) {
			await this.evaluateAssertion(assertion, changedBases);
		}
	}

	private async evaluateAssertion(
		assertion: { name: string; violationSql: string },
		changedBases: Set<string>
	): Promise<void> {
		const parser = new Parser();
		let ast: AST.Statement;
		try {
			ast = parser.parse(assertion.violationSql) as AST.Statement;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			throw new QuereusError(
				`Failed to parse deferred assertion '${assertion.name}': ${error.message}`,
				StatusCode.INTERNAL,
				error
			);
		}

		const { plan } = this.ctx._buildPlan([ast]);
		const analyzed = this.ctx.optimizer.optimizeForAnalysis(plan, this.ctx as unknown as Database) as BlockNode;

		// Collect base tables and relationKeys in this plan
		const relationKeyToBase = new Map<string, string>();
		const baseTablesInPlan = new Set<string>();
		this.collectTables(analyzed, relationKeyToBase, baseTablesInPlan);

		// Determine impact: if assertion has no dependencies, treat as global and always impacted
		const hasDeps = baseTablesInPlan.size > 0;
		let impacted = !hasDeps;
		if (hasDeps) {
			for (const b of baseTablesInPlan) {
				if (changedBases.has(b)) {
					impacted = true;
					break;
				}
			}
		}
		if (!impacted) return;

		// Classify instances as row/global
		const classifications: Map<string, 'row' | 'global'> = analyzeRowSpecific(analyzed as unknown as RelationalPlanNode);

		// If any changed base appears as a global instance, run full violation query once
		let requiresGlobal = false;
		for (const [relKey, klass] of classifications) {
			if (klass === 'global') {
				const base = relationKeyToBase.get(relKey);
				if (base && changedBases.has(base)) {
					requiresGlobal = true;
					break;
				}
			}
		}

		if (requiresGlobal) {
			await this.executeViolationOnce(assertion.name, assertion.violationSql);
			return;
		}

		// Collect row-specific references that correspond to changed bases
		const rowSpecificChanged: Array<{ relKey: string; base: string }> = [];
		for (const [relKey, klass] of classifications) {
			if (klass !== 'row') continue;
			const base = relationKeyToBase.get(relKey);
			if (base && changedBases.has(base)) {
				rowSpecificChanged.push({ relKey, base });
			}
		}

		if (rowSpecificChanged.length === 0) {
			// No row-specific changed refs (or no refs at all) → run once globally
			await this.executeViolationOnce(assertion.name, assertion.violationSql);
			return;
		}

		// Execute parameterized variants per changed key for each row-specific reference
		for (const { relKey, base } of rowSpecificChanged) {
			await this.executeViolationPerChangedKeys(assertion.name, analyzed, relKey, base);
		}
	}

	private async executeViolationOnce(assertionName: string, sql: string): Promise<void> {
		const stmt = this.ctx.prepare(sql);
		try {
			// Use _iterateRowsRaw() to avoid transaction management - we're already inside
			// the commit path and don't want to trigger nested commit/rollback behavior
			for await (const _ of stmt._iterateRowsRaw()) {
				throw new QuereusError(`Integrity assertion failed: ${assertionName}`, StatusCode.CONSTRAINT);
			}
		} finally {
			await stmt.finalize();
		}
	}

	private async executeViolationPerChangedKeys(
		assertionName: string,
		analyzed: BlockNode,
		targetRelationKey: string,
		base: string
	): Promise<void> {
		const changedKeyTuples = this.ctx.getChangedKeyTuples(base);
		if (changedKeyTuples.length === 0) return;

		// Find PK indices for the base table
		const [schemaName, tableName] = base.split('.');
		const table = this.ctx._findTable(tableName, schemaName);
		if (!table) {
			throw new QuereusError(`Assertion references unknown table ${base}`, StatusCode.INTERNAL);
		}
		const pkIndices = table.primaryKeyDefinition.map(def => def.index);

		// Prepare a rewritten plan with an injected Filter on the target relationKey
		const rewritten = this.injectPkFilter(analyzed, targetRelationKey, pkIndices);
		const optimizedPlan = this.ctx.optimizer.optimize(rewritten, this.ctx as unknown as Database) as BlockNode;

		// Emit and execute for each changed PK tuple; stop on first violation row
		const emissionContext = new EmissionContext(this.ctx as unknown as Database);
		const rootInstruction = emitPlanNode(optimizedPlan, emissionContext);
		const scheduler = new Scheduler(rootInstruction);

		for (const tuple of changedKeyTuples) {
			const params: Record<string, SqlValue> = {};
			for (let i = 0; i < pkIndices.length; i++) {
				params[`pk${i}`] = tuple[i];
			}

			const runtimeCtx: RuntimeContext = {
				db: this.ctx as unknown as Database,
				stmt: undefined,
				params,
				context: new Map(),
				tableContexts: new Map(),
				tracer: this.ctx.getInstructionTracer(),
				enableMetrics: this.ctx.options.getBooleanOption('runtime_stats'),
			};

			const result = await scheduler.run(runtimeCtx);
			if (isAsyncIterable(result)) {
				for await (const _ of result as AsyncIterable<unknown>) {
					throw new QuereusError(`Integrity assertion failed: ${assertionName}`, StatusCode.CONSTRAINT);
				}
			}
		}
	}

	private injectPkFilter(block: BlockNode, targetRelationKey: string, pkIndices: number[]): BlockNode {
		const newStatements = block.getChildren().map(stmt =>
			this.rewriteForPkFilter(stmt, targetRelationKey, pkIndices)
		);
		if (newStatements.every((s, i) => s === block.getChildren()[i])) return block;
		return new BlockNode(block.scope, newStatements, block.parameters);
	}

	private rewriteForPkFilter(node: PlanNode, targetRelationKey: string, pkIndices: number[]): PlanNode {
		// If this node is the target TableReference instance, wrap with a Filter
		const maybe = this.tryWrapTableReference(node, targetRelationKey, pkIndices);
		if (maybe) return maybe;

		const originalChildren = node.getChildren();
		if (!originalChildren || originalChildren.length === 0) return node;

		const rewrittenChildren = originalChildren.map(child =>
			this.rewriteForPkFilter(child, targetRelationKey, pkIndices)
		);
		const changed = rewrittenChildren.some((c, i) => c !== originalChildren[i]);
		return changed ? node.withChildren(rewrittenChildren) : node;
	}

	private tryWrapTableReference(node: PlanNode, targetRelationKey: string, pkIndices: number[]): PlanNode | null {
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
				? new BinaryOpNode(
					scope,
					{ type: 'binary', operator: 'AND', left: predicate.expression, right: eqNode.expression },
					predicate,
					eqNode
				)
				: eqNode;
		}

		if (!predicate) return null;

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
}
