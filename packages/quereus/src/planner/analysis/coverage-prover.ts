/**
 * Coverage prover — recognizes when an explicit materialized view *covers* a
 * UNIQUE constraint, i.e. its materialized row set is observation-equivalent to
 * the set of rows the constraint governs, keyed so a point lookup answers the
 * uniqueness question. Pure analysis: it records a constraint↔structure link
 * (see `runtime/emit/materialized-view.ts`); **nothing enforces through the MV's
 * backing table in this ticket** (that needs row-time write-through maintenance
 * — see `docs/materialized-views.md` § Covering structures, the soundness note).
 *
 * Narrow v1 — the body, after optimization, must be a linear chain over a single
 * base table `T`:
 *
 *     TableReference(T) → optional Filter(P) → Project(...) → optional Sort
 *
 * (physical access nodes such as IndexScan / SeqScan are transparent links in
 * the chain). Anything else — joins, aggregation, DISTINCT, set operations,
 * multiple sources — is `NotCovers('shape')`.
 *
 * Soundness is paramount: a false `Covers` would (once the lens layer routes
 * enforcement through the structure) silently miss conflicts. Every check is
 * conservative — a false `NotCovers` only forgoes an optimization. FD-driven
 * coverage and multi-source bodies are deferred (see the backlog tickets named
 * in the implement ticket's out-of-scope list).
 */

import type { RelationalPlanNode, GuardClause } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { FilterNode } from '../nodes/filter.js';
import type { MaterializedViewSchema } from '../../schema/view.js';
import type { TableSchema, UniqueConstraintSchema } from '../../schema/table.js';
import type * as AST from '../../parser/ast.js';
import { recognizeConjunctiveClauses, guardClausesEntail } from './partial-unique-extraction.js';
import { columnIndexFromExpr } from './predicate-shape.js';

export type CoverageFailureReason =
	| 'shape'
	| 'missing-uc-column'
	| 'missing-pk-column'
	| 'ordering-mismatch'
	| 'predicate-entailment'
	| 'missing-null-skip';

export type CoverageResult =
	| { covers: true }
	| { covers: false; reason: CoverageFailureReason };

const COVERS: CoverageResult = { covers: true };
function notCovers(reason: CoverageFailureReason): CoverageResult {
	return { covers: false, reason };
}

/**
 * Row-preserving / single-source pass-through node types that may appear between
 * the projection and the table reference after optimization. They neither change
 * which base rows are present (Filter is handled separately — its predicate is
 * captured) nor split into multiple sources.
 *
 * Row-*dropping* nodes are deliberately excluded — notably `OrdinalSlice` (a
 * pushed-down LIMIT/OFFSET) and `LimitOffset` itself, which materialize only a
 * prefix of the governed rows and so can never cover. A row cap is rejected up
 * front from the AST (see `proveCoverage`); the exclusion here is the structural
 * backstop should the cap ever reach the plan walk by another path.
 */
const PASS_THROUGH: ReadonlySet<PlanNodeType> = new Set([
	PlanNodeType.Sort,
	PlanNodeType.Project,
	PlanNodeType.Retrieve,
	PlanNodeType.SeqScan,
	PlanNodeType.IndexScan,
	PlanNodeType.IndexSeek,
	PlanNodeType.TableSeek,
]);

/**
 * Decides whether `mv` covers `uc` on `baseTable`. `root` is the optimized body
 * relation (`db.getPlan(body).getRelations()[0]`); the body's declared `order by`
 * comes from `mv.selectAst`. See the module doc for the recognition rules.
 */
export function proveCoverage(
	root: RelationalPlanNode,
	mv: MaterializedViewSchema,
	uc: UniqueConstraintSchema,
	baseTable: TableSchema,
): CoverageResult {
	// ---- Row cap: a LIMIT/OFFSET body materializes only a prefix of the
	//      governed rows, so it can never be observation-equivalent. Read from the
	//      AST (the faithful source): the optimizer may push the cap into an
	//      `OrdinalSlice` over an ordinal-seek-capable leaf, which the shape walk
	//      would otherwise traverse as a transparent link. ----
	if (mv.selectAst.type === 'select' && (mv.selectAst.limit !== undefined || mv.selectAst.offset !== undefined)) {
		return notCovers('shape');
	}

	// ---- Shape: walk the single-relation chain to the terminal table reference.
	//      Reject anything that changes the row set's cardinality/identity (joins,
	//      aggregation, DISTINCT, set operations, …); Filter and physical access
	//      nodes are transparent links — the *predicate* is taken from the AST
	//      below (the optimizer may absorb a WHERE into an index range seek and
	//      drop the FilterNode, so the plan is not a faithful predicate source). ----
	let tableRef: TableReferenceNode | undefined;
	let node: RelationalPlanNode | undefined = root;
	while (node) {
		if (node instanceof TableReferenceNode) {
			tableRef = node;
			break;
		}
		if (!(node instanceof FilterNode) && !PASS_THROUGH.has(node.nodeType)) {
			return notCovers('shape');
		}
		const relations: readonly RelationalPlanNode[] = node.getRelations();
		if (relations.length !== 1) return notCovers('shape');
		node = relations[0];
	}
	if (!tableRef) return notCovers('shape');
	if (tableRef.tableSchema.name.toLowerCase() !== baseTable.name.toLowerCase()
		|| tableRef.tableSchema.schemaName.toLowerCase() !== baseTable.schemaName.toLowerCase()) {
		return notCovers('shape');
	}

	// ---- Projection coverage: map output attributes back to base columns via
	//      stable attribute IDs (a bare column reference preserves the source
	//      attribute's id through Project/Sort/scan nodes). ----
	const baseAttrToCol = new Map<number, number>();
	tableRef.getAttributes().forEach((attr, i) => baseAttrToCol.set(attr.id, i));

	const coveredBaseCols = new Set<number>();
	for (const attr of root.getAttributes()) {
		const col = baseAttrToCol.get(attr.id);
		if (col !== undefined) coveredBaseCols.add(col);
	}

	for (const col of uc.columns) {
		if (!coveredBaseCols.has(col)) return notCovers('missing-uc-column');
	}
	for (const pk of baseTable.primaryKeyDefinition) {
		if (!coveredBaseCols.has(pk.index)) return notCovers('missing-pk-column');
	}

	// ---- Ordering: the body's declared ORDER BY columns must be a permutation of
	//      the UC columns. The prover never invents an ordering — a missing one
	//      fails. Read from the body AST rather than `mv.ordering`: the optimizer
	//      drops the Sort (leaving `physical.ordering` empty) whenever an index
	//      scan already supplies the order, so the AST is the faithful source. ----
	const orderingBaseCols = bodyOrderByColumns(mv.selectAst, baseTable);
	if (orderingBaseCols === undefined) return notCovers('ordering-mismatch');
	if (!isPermutation(orderingBaseCols, uc.columns)) return notCovers('ordering-mismatch');

	// ---- Predicate alignment: the materialized set (rows where the body's WHERE
	//      holds) must equal the governed set (rows where uc.predicate holds,
	//      NULL-excluded). The WHERE is read from the AST (see shape note). ----
	const bodyWhere = mv.selectAst.type === 'select' ? mv.selectAst.where : undefined;
	return provePredicateAlignment(bodyWhere, uc, baseTable);
}

/**
 * Verifies the body predicate `P` is observation-equivalent (over the governed
 * rows) to the constraint's scope:
 *
 *   - soundness  — `P` entails every required clause (`uc.predicate` clauses
 *     plus an `is not null` per nullable UC column), so the materialized set is
 *     contained in the governed set; and
 *   - completeness — `P` adds no restriction beyond those clauses (a NOT-NULL on
 *     any UC column is always allowed, since UNIQUE already ignores NULL rows),
 *     so the materialized set is not a strict subset that would miss conflicts.
 */
function provePredicateAlignment(
	bodyWhere: AST.Expression | undefined,
	uc: UniqueConstraintSchema,
	baseTable: TableSchema,
): CoverageResult {
	// Required clauses (the governed scope).
	const requiredClauses: GuardClause[] = [];
	if (uc.predicate) {
		const ucClauses = recognizeConjunctiveClauses(uc.predicate, baseTable);
		if (ucClauses === undefined) return notCovers('predicate-entailment');
		requiredClauses.push(...ucClauses);
	}
	const nullableUcCols = uc.columns.filter(c => baseTable.columns[c]?.notNull !== true);
	for (const c of nullableUcCols) {
		requiredClauses.push({ kind: 'is-null', column: c, negated: true });
	}

	// Recognize P. An unrecognized conjunct makes the materialized set unbounded
	// from the prover's view — reject (we can prove neither containment direction).
	let pClauses: GuardClause[] = [];
	if (bodyWhere) {
		const clauses = recognizeConjunctiveClauses(bodyWhere, baseTable);
		if (clauses === undefined) {
			return notCovers(uc.predicate || nullableUcCols.length === 0 ? 'predicate-entailment' : 'missing-null-skip');
		}
		pClauses = clauses;
	}

	// Soundness: P entails every required clause (per-clause for a precise reason).
	for (const rc of requiredClauses) {
		if (!guardClausesEntail(pClauses, [rc])) {
			return notCovers(rc.kind === 'is-null' && rc.negated ? 'missing-null-skip' : 'predicate-entailment');
		}
	}

	// Completeness: every clause of P is allowed (entailed by the required scope,
	// widened by a permissible NOT-NULL on any UC column). A restriction beyond
	// that would drop governed rows and miss conflicts.
	const allowedForCompleteness: GuardClause[] = [...requiredClauses];
	for (const c of uc.columns) {
		allowedForCompleteness.push({ kind: 'is-null', column: c, negated: true });
	}
	if (!guardClausesEntail(allowedForCompleteness, pClauses)) {
		return notCovers('predicate-entailment');
	}

	return COVERS;
}

/**
 * Base-table column indices named by the body's `ORDER BY`, in order, or
 * `undefined` when there is no `ORDER BY`, the body is not a plain SELECT, or any
 * ordering term is not a bare column of the base table (the prover never invents
 * an ordering).
 */
function bodyOrderByColumns(selectAst: AST.QueryExpr, baseTable: TableSchema): number[] | undefined {
	if (selectAst.type !== 'select') return undefined;
	const orderBy = selectAst.orderBy;
	if (!orderBy || orderBy.length === 0) return undefined;
	const cols: number[] = [];
	for (const term of orderBy) {
		const col = columnIndexFromExpr(term.expr, baseTable.columnIndexMap);
		if (col === undefined) return undefined;
		cols.push(col);
	}
	return cols;
}

/** True when `a` and `b` contain the same column indices (order-insensitive, distinct). */
function isPermutation(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
	if (a.length !== b.length) return false;
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size !== a.length || setB.size !== b.length) return false;
	for (const x of setA) if (!setB.has(x)) return false;
	return true;
}
