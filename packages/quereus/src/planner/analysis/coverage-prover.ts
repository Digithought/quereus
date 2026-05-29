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
 * conservative — a false `NotCovers` only forgoes an optimization. Multi-source
 * bodies are deferred (see the backlog tickets named in the implement ticket's
 * out-of-scope list).
 *
 * ---
 *
 * Two different "coverage" questions live in this module; keep them apart:
 *
 *  1. **Base-table covering** (`proveCoverage`, above) — does an explicit MV's
 *     materialized row set cover a `unique` constraint on a *base table* `T`,
 *     keyed so a point lookup answers the uniqueness question and the base PK is
 *     reconstructible so a conflicting row can be identified? Requires literal
 *     projection of every UC column + the source PK, an `order by` permutation of
 *     the UC columns, and predicate/NULL-skip alignment.
 *
 *  2. **Output-relation effective key** (`proveEffectiveKeyUnique`, below) — is
 *     the body's *own output relation* provably unique on the declared key
 *     columns, via its effective key (declared keys, FD-closure-derived keys, or
 *     the all-columns/set fallback, all read through the unified `isUnique`
 *     surface)? This is the obligation primitive the lens prover consumes for its
 *     `obligation: proved` class — e.g. a `group by x, y` body whose output is
 *     intrinsically one row per `(x, y)` vacuously satisfies a logical
 *     `unique(x, y)`, so no runtime enforcement structure is needed.
 *
 * **Why (2) is NOT folded into (1).** An FD-derived output key cannot prove a
 * *base-table* constraint, and folding it in would be unsound. A `group by x`
 * body's output is *always* unique on `x` — whether or not `T` satisfies
 * `unique(x)` — because grouping collapses base-row duplicates: two base rows
 * with `x = 5` (a base-constraint violation) still yield exactly one output row
 * for `x = 5`. Output-key uniqueness is therefore silent about base duplicates;
 * that masking is the whole problem. Aggregating bodies also drop the base PK, so
 * the "identify the conflicting base row" half of the v1 covering contract (for
 * REPLACE / IGNORE conflict resolution) is unrecoverable. (2) is thus a proof
 * about the *derived (output) relation's own* constraint, deliberately kept out
 * of `proveCoverage` to preserve the v1 soundness boundary and leave the
 * eager-link path (`linkCoveredUniqueConstraints`) untouched. Whether a covering
 * *enforcement* structure can ever be FD-derived (detection-only, ABORT) is a
 * separate concern of the row-time-enforcement / lens tickets, not this one.
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
import { isUnique } from '../util/fd-utils.js';

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
 * Outcome of `proveEffectiveKeyUnique`. `not-a-key` means the body's effective
 * key does not subsume `keyColumns`; `out-of-frame` means an index fell outside
 * the body's output columns.
 */
export type EffectiveKeyResult =
	| { proved: true }
	| { proved: false; reason: 'not-a-key' | 'out-of-frame' };

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
 * "Body proves it": true iff the body's output relation is provably unique on
 * `keyColumns` (output-column indices) via its effective key — declared keys,
 * FD-closure-derived keys, or the set/all-columns fallback, all read through the
 * unified `isUnique` surface. This is the obligation primitive the lens prover
 * consumes for its `obligation: proved` class (e.g. a `group by x, y` body
 * proving a logical `unique(x, y)`).
 *
 * `root` MUST be the optimized body relation (the same node `proveCoverage`
 * receives: `db.getPlan(body).getRelations()[0]`), so `physical.fds` is
 * populated — the group-key FD (`propagateAggregateFds`) and projected
 * source-key FDs live there.
 *
 * Soundness notes (why the v1 base-table covering checks do NOT apply here):
 *  - Ordering: irrelevant — a proof of intrinsic uniqueness needs no ordered
 *    point-lookup path, so the canonical `group by` body (no ORDER BY) qualifies.
 *  - PK reconstructibility / observation-equivalence: irrelevant — there is no
 *    enforcement and no base row to identify; the constraint is on the output.
 *  - NULL-skip: composes trivially by subsumption. `isUnique` proves *strict*
 *    key-uniqueness (NULL treated as a value); SQL `unique` is NULL-permissive
 *    (weaker), so strict-unique ⟹ `unique` holds. No extra NULL handling.
 *  - Superkey semantics are correct: if the body's real key is a subset of
 *    `keyColumns`, the (stronger) constraint on the smaller set still implies the
 *    declared one — `isUnique` already returns true for any superset of a key.
 *
 * `keyColumns` are **body-output** column indices; the lens prover owns the
 * logical-column → output-column mapping (this primitive does no base-table
 * attribute-id translation — that was a v1 mechanism for the base frame and does
 * not apply to the output frame). Delegates uniqueness entirely to `isUnique`
 * (DRY); the value this adds is the named obligation seam, the diagnostic result
 * shape, and the load-bearing soundness documentation above.
 */
export function proveEffectiveKeyUnique(
	root: RelationalPlanNode,
	keyColumns: readonly number[],
): EffectiveKeyResult {
	const columnCount = root.getType().columns.length;
	for (const c of keyColumns) {
		if (c < 0 || c >= columnCount) return { proved: false, reason: 'out-of-frame' };
	}
	return isUnique(keyColumns, root) ? { proved: true } : { proved: false, reason: 'not-a-key' };
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
