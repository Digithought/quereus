/**
 * Rule: Fan-out Lookup Join (FK→PK + correlated scalar-aggregate subqueries)
 *
 * Clusters two kinds of at-most-one, per-outer-row branches into one
 * `FanOutLookupJoinNode` that drives them concurrently per outer row:
 *
 *   1. **Join-spine branches.** A chain of N LEFT/INNER nested-loop joins from
 *      a common outer where every join's non-preserved side is a parameterized
 *      FK→PK lookup matching the same alignment `ruleJoinElimination` trusts.
 *
 *   2. **Subquery branches.** Correlated scalar-aggregate `ScalarSubqueryNode`s
 *      in the SELECT projection list (e.g. `(select count(*) from c where
 *      c.fk = o.k)`). A scalar aggregate with no GROUP BY emits exactly one row
 *      per outer row regardless of how many child rows match — relationally an
 *      `atMostOne-left` branch driven per outer row, exactly what the fan-out
 *      node already does. The subquery's relational root is used verbatim as
 *      the branch child (its correlation predicate is internal and resolves
 *      through `rctx.context`); only the projection's scalar reference is
 *      rewritten to a column reference into the fan-out's wide row.
 *
 * When the *combined* branch count clears `tuning.parallel.minBranches` AND the
 * projected latency win covers the per-branch setup overhead, the cluster
 * forms.
 *
 * Cost gate is anchored on `physical.expectedLatencyMs` — populated 0 for
 * in-process / memory-vtab paths, non-zero for remote vtabs whose access plan
 * declares per-call latency. As a consequence, with no remote-vtab plugin in
 * tree the rule is inert by design (memory-vtab golden plans don't change).
 *
 * Join-spine branch eligibility mirrors `ruleJoinElimination`:
 *   - AND-of-column-equalities ON-clause (any residual disqualifies the
 *     branch — leave it as a normal nested-loop join),
 *   - FK→PK alignment validated via `lookupCoveringFK` + `checkFkPkAlignment`,
 *   - INNER branches additionally require NOT-NULL FK + row-preserving path
 *     to the PK table.
 *
 * Subquery branch eligibility:
 *   - the projection node is *exactly* a `ScalarSubqueryNode` (no wrapping
 *     scalar expression in v1),
 *   - the subquery is correlated,
 *   - beneath pass-through wrappers the relational root is aggregate-shaped
 *     with zero grouping keys (⇒ exactly one row per outer),
 *   - the subquery exposes exactly one output attribute.
 */

import { createLogger } from '../../../common/logger.js';
import type { OptContext } from '../../framework/context.js';
import {
	isRelationalNode,
	type Attribute,
	type PlanNode,
	type RelationalPlanNode,
	type ScalarPlanNode,
} from '../../nodes/plan-node.js';
import type { ScalarType } from '../../../common/datatype.js';
import type * as AST from '../../../parser/ast.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode } from '../../nodes/sort.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { ScalarSubqueryNode } from '../../nodes/subquery.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { checkFkPkAlignment, extractTableSchema } from '../../util/key-utils.js';
import { lookupCoveringFK, isRowPreservingPathToTable } from '../../util/ind-utils.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import { CapabilityDetectors } from '../../framework/characteristics.js';
import { isAndOfColumnEqualities } from './rule-join-elimination.js';
import { FanOutLookupJoinNode, type FanOutBranchSpec, type FanOutBranchMode } from '../../nodes/fanout-lookup-join-node.js';
import type { TableSchema } from '../../../schema/table.js';

const log = createLogger('optimizer:rule:fanout-lookup-join');

type ChainEntry =
	| { kind: 'filter'; node: FilterNode }
	| { kind: 'sort'; node: SortNode }
	| { kind: 'limit'; node: LimitOffsetNode }
	| { kind: 'distinct'; node: DistinctNode }
	| { kind: 'alias'; node: AliasNode };

interface RecognizedBranch {
	readonly lookup: RelationalPlanNode;
	readonly mode: FanOutBranchMode;
	readonly condition: ScalarPlanNode;
}

/**
 * A correlated scalar-aggregate subquery recognized as an `atMostOne-left`
 * fan-out branch. `subqueryRoot` is the subquery's relational root and
 * `valueAttr` is its column-0 attribute (the scalar value). `subqueryNode` is
 * the projection-list node that must be rewritten to a column reference into
 * the fan-out's wide row.
 *
 * The branch child is NOT the subquery root verbatim: a no-GROUP-BY aggregate
 * exposes a single output attribute as the logical `AggregateNode`, but its
 * physical `StreamAggregateNode` form additionally exposes the source columns
 * (for HAVING access). Driving that 4-column relation as the branch would
 * misalign the wide row. Instead the assembly wraps `subqueryRoot` in a stable
 * single-column `ProjectNode` selecting `valueAttr`, so the branch always
 * contributes exactly the scalar value regardless of the aggregate's physical
 * shape.
 */
interface RecognizedSubqueryBranch {
	readonly subqueryNode: ScalarSubqueryNode;
	readonly subqueryRoot: RelationalPlanNode;
	readonly valueAttr: Attribute;
	readonly mode: FanOutBranchMode;
	readonly concurrencySafe: boolean;
}

export function ruleFanOutLookupJoin(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const tuning = context.tuning.parallel;
	if (tuning.minBranches < 2) return null;

	// Walk pass-through wrappers down to the first JoinNode or a non-wrapper
	// bottom. Unlike the join-only v1, hitting a non-JoinNode/non-wrapper node
	// is NOT a bail — it just means there is no join spine and that node is the
	// outer (e.g. the `orders` access node for `select …, (subq) from orders`).
	const chain: ChainEntry[] = [];
	let current: RelationalPlanNode = node.source;
	while (true) {
		if (current instanceof JoinNode) break;
		if (current instanceof FilterNode) {
			chain.push({ kind: 'filter', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof SortNode) {
			chain.push({ kind: 'sort', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof LimitOffsetNode) {
			chain.push({ kind: 'limit', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof DistinctNode) {
			chain.push({ kind: 'distinct', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof AliasNode) {
			chain.push({ kind: 'alias', node: current });
			current = current.source;
			continue;
		}
		break;
	}

	// Collect the join chain top-to-bottom and find the outer subtree at the
	// deepest left. With no join spine the outer is `current` itself.
	const joins: JoinNode[] = [];
	let walker: RelationalPlanNode = current;
	while (walker instanceof JoinNode) {
		joins.push(walker);
		walker = walker.left;
	}
	const outerSubtree = walker;
	const outerAttrs = outerSubtree.getAttributes();

	// Join-spine branches. FK→PK alignment is validated against the outer
	// subtree's schema, so a spine requires the outer to resolve to a single
	// table schema (mirrors `ruleJoinElimination`). `extractTableSchema` is
	// needed ONLY here — pure-subquery clusters skip it.
	//
	// Bottom-up walk: joins[joins.length - 1] is the innermost (its .left ==
	// outerSubtree), joins[0] is the outermost. Process bottom-up so the order
	// of `spineBranches` reflects the natural wide-row layout.
	const spineBranches: RecognizedBranch[] = [];
	if (joins.length > 0) {
		const outerSchema = extractTableSchema(outerSubtree);
		if (!outerSchema) return null;
		for (let i = joins.length - 1; i >= 0; i--) {
			const recognized = recognizeBranch(joins[i], outerSchema, outerAttrs);
			if (!recognized) {
				// A non-eligible branch in the middle breaks the cluster — without
				// a way to keep that branch in the original nested-loop position we
				// would change semantics. Bail out conservatively.
				return null;
			}
			spineBranches.push(recognized);
		}
	}

	// Subquery branches: correlated scalar-aggregate ScalarSubqueryNodes that
	// appear directly as a projection node.
	const subqueryBranches: RecognizedSubqueryBranch[] = [];
	for (const proj of node.projections) {
		if (!(proj.node instanceof ScalarSubqueryNode)) continue;
		const recognized = recognizeSubqueryBranch(proj.node);
		if (recognized) subqueryBranches.push(recognized);
	}

	const totalBranches = spineBranches.length + subqueryBranches.length;
	if (totalBranches < tuning.minBranches) return null;

	// Cost gate over the COMBINED branch set. `expectedLatencyMs` is populated 0
	// except on remote-vtab access plans (propagated up through the aggregate
	// for subquery branches), so this skip keeps the rule inert for local chains.
	let maxLatency = 0;
	for (const b of spineBranches) {
		const l = b.lookup.physical.expectedLatencyMs ?? 0;
		if (l > maxLatency) maxLatency = l;
	}
	for (const b of subqueryBranches) {
		const l = b.subqueryRoot.physical.expectedLatencyMs ?? 0;
		if (l > maxLatency) maxLatency = l;
	}
	if (maxLatency === 0) return null;

	const concurrencyCap = Math.max(1, Math.min(tuning.concurrency, totalBranches));
	const savings = (totalBranches - concurrencyCap) * maxLatency;
	const overhead = totalBranches * tuning.branchSetupCost;
	if (savings <= overhead) return null;

	// Build branch specs: spine branches first (preserving left-deep order),
	// then subquery branches.
	//
	// A spine branch's `child` is the lookup wrapped in a FilterNode carrying
	// the original equi-condition. A subquery branch's `child` is the subquery's
	// relational root verbatim — its correlation predicate is already inside it.
	// Both resolve outer-side references via `rctx.context`: the parent fork's
	// snapshot carries the outer slot, set by `runFanOutLookupJoin` before the
	// fork.
	const branchSpecs: FanOutBranchSpec[] = [];
	for (const b of spineBranches) {
		const parameterized = new FilterNode(node.scope, b.lookup, b.condition);
		branchSpecs.push({
			child: parameterized,
			mode: b.mode,
			outputAttrs: b.lookup.getAttributes(),
			concurrencySafe: b.lookup.physical.concurrencySafe !== false,
		});
	}
	for (const b of subqueryBranches) {
		// Pin the branch to a single column (the scalar value) so its attribute
		// count is invariant under the inner aggregate's logical→physical
		// expansion. `attributeId: valueAttr.id` keeps the branch output attribute
		// identical to what the outer projection's column reference targets.
		const colRef = new ColumnReferenceNode(
			node.scope,
			columnExprFor(b.valueAttr.name),
			b.valueAttr.type,
			b.valueAttr.id,
			0,
		);
		const projectedChild = new ProjectNode(
			node.scope,
			b.subqueryRoot,
			[{ node: colRef, alias: b.valueAttr.name, attributeId: b.valueAttr.id }],
		);
		branchSpecs.push({
			child: projectedChild,
			mode: b.mode,
			outputAttrs: projectedChild.getAttributes(),
			concurrencySafe: b.concurrencySafe,
		});
	}

	// `preserveAttributeIds` pins the wide-row layout: outer attrs + each
	// branch's output attrs (nullable-widened for atMostOne-left). The branch
	// outputs are the lookups'/subqueries' own attributes, so any reference
	// resolves by attribute ID regardless of wide-row position.
	const preserveAttrs: Attribute[] = [];
	for (const a of outerAttrs) preserveAttrs.push(a);
	for (const spec of branchSpecs) {
		const nullable = spec.mode === 'atMostOne-left';
		for (const a of spec.outputAttrs) {
			if (nullable && !a.type.nullable) {
				preserveAttrs.push({ ...a, type: { ...a.type, nullable: true } });
			} else {
				preserveAttrs.push(a);
			}
		}
	}

	const fanout = new FanOutLookupJoinNode(
		node.scope,
		outerSubtree,
		branchSpecs,
		concurrencyCap,
		preserveAttrs,
	);

	// Build the projection rewrite map. Each subquery branch's single output
	// attribute materializes at a fixed wide-row index (outer + preceding branch
	// outputs); replace the ScalarSubqueryNode in the projection with a column
	// reference at that index. Correctness comes from the attribute ID (resolved
	// via the row descriptor); the index is the runtime read position.
	const subqueryReplacements = new Map<ScalarSubqueryNode, ColumnReferenceNode>();
	let wideIndex = outerAttrs.length;
	for (const b of spineBranches) wideIndex += b.lookup.getAttributes().length;
	for (const b of subqueryBranches) {
		const outAttr = b.valueAttr;
		// atMostOne-left can null-fill (empty children), so the read type is
		// nullable; this matches the wide-row widening in `preserveAttrs`.
		const colType: ScalarType = outAttr.type.nullable
			? outAttr.type
			: { ...outAttr.type, nullable: true };
		const colRef = new ColumnReferenceNode(
			node.scope,
			columnExprFor(outAttr.name),
			colType,
			outAttr.id,
			wideIndex,
		);
		subqueryReplacements.set(b.subqueryNode, colRef);
		wideIndex += 1; // each subquery branch contributes exactly one column
	}

	log(
		'Forming FanOutLookupJoin with %d branches (%d spine + %d subquery, cap=%d, maxLatency=%d)',
		totalBranches, spineBranches.length, subqueryBranches.length, concurrencyCap, maxLatency,
	);

	const rebuilt = rebuildChain(chain, fanout);
	return rebuildProject(node, rebuilt, subqueryReplacements);
}

/** Minimal synthetic AST.ColumnExpr for a rewritten projection column ref. */
function columnExprFor(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

/**
 * Recognize a correlated scalar-aggregate subquery as an `atMostOne-left`
 * fan-out branch. Returns null when the subquery is not correlated, is not
 * aggregate-shaped with zero grouping keys beneath pass-through wrappers, or
 * does not expose exactly one output attribute.
 *
 * The aggregate-shape test uses `CapabilityDetectors.isAggregating`, which
 * matches both the logical `AggregateNode` and the physical
 * `StreamAggregateNode` / `HashAggregateNode`, so it is robust to optimizer
 * pass ordering (the subquery root may still be logical at structural time).
 */
function recognizeSubqueryBranch(scalarSubquery: ScalarSubqueryNode): RecognizedSubqueryBranch | null {
	if (!isCorrelatedSubquery(scalarSubquery.subquery)) return null;

	// Descend pass-through wrappers (Project/Alias/Sort/LimitOffset) to the
	// aggregate root.
	let root: RelationalPlanNode = scalarSubquery.subquery;
	while (!CapabilityDetectors.isAggregating(root)) {
		if (
			root instanceof ProjectNode ||
			root instanceof AliasNode ||
			root instanceof SortNode ||
			root instanceof LimitOffsetNode
		) {
			root = root.source;
			continue;
		}
		return null;
	}
	// Empty grouping ⇒ exactly one row per outer ⇒ at-most-one branch. A
	// GROUP BY subquery may yield more than one row and is rejected here.
	if (root.getGroupingKeys().length !== 0) return null;

	// A scalar subquery's relational root exposes exactly one output column at
	// structural time (validated at build); its column-0 attribute is the
	// scalar value the branch contributes.
	const subAttrs = scalarSubquery.subquery.getAttributes();
	if (subAttrs.length !== 1) return null;

	return {
		subqueryNode: scalarSubquery,
		subqueryRoot: scalarSubquery.subquery,
		valueAttr: subAttrs[0],
		mode: 'atMostOne-left',
		concurrencySafe: scalarSubquery.subquery.physical.concurrencySafe !== false,
	};
}

/**
 * Decide whether `join`'s `right` side is an FK→PK lookup eligible for branch
 * clustering. The FK side is sourced from `outerSchema` + `outerAttrs` — both
 * the equi-pair's left attribute and its `outerAttrs` membership are checked,
 * which is the safety net keeping per-join alignment honest in the presence
 * of intermediate joins in the chain (the join's own `.left` resolves to a
 * combined relation, so we cannot extract a single schema from it).
 */
function recognizeBranch(
	join: JoinNode,
	outerSchema: TableSchema,
	outerAttrs: readonly Attribute[],
): RecognizedBranch | null {
	if (join.joinType !== 'left' && join.joinType !== 'inner') return null;
	if (!join.condition) return null;

	const leftAttrs = join.left.getAttributes();
	const rightAttrs = join.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(join.condition, leftAttrs, rightAttrs);
	if (pairs.length === 0) return null;

	const normalized = normalizePredicate(join.condition);
	if (!isAndOfColumnEqualities(normalized)) return null;

	const outerAttrIdToIdx = new Map<number, number>();
	outerAttrs.forEach((a, i) => outerAttrIdToIdx.set(a.id, i));

	// Translate each equi-pair from "(left subtree column index, right column
	// index)" to "(outer column index, right column index)". The left subtree
	// may span multiple joins, but the equi-pair's left attribute must
	// originate in the outer subtree for an FK→PK relationship to make sense.
	const outerCols: number[] = [];
	const rightCols: number[] = [];
	for (const p of pairs) {
		const leftAttrId = leftAttrs[p.left]?.id;
		if (leftAttrId === undefined) return null;
		const outerIdx = outerAttrIdToIdx.get(leftAttrId);
		if (outerIdx === undefined) return null;
		outerCols.push(outerIdx);
		rightCols.push(p.right);
	}

	const rightSchema = extractTableSchema(join.right);
	if (!rightSchema) return null;

	if (!checkFkPkAlignment(outerSchema, rightSchema, outerCols, rightCols)) {
		return null;
	}

	if (join.joinType === 'inner') {
		const match = lookupCoveringFK(outerSchema, rightSchema, outerCols, rightCols);
		if (!match || match.nullable) return null;
		if (!isRowPreservingPathToTable(join.right)) return null;
	}

	const mode: FanOutBranchMode = join.joinType === 'left' ? 'atMostOne-left' : 'atMostOne-inner';
	return { lookup: join.right, mode, condition: join.condition };
}

function rebuildChain(chain: ReadonlyArray<ChainEntry>, bottom: RelationalPlanNode): RelationalPlanNode {
	let current = bottom;
	// Chain was collected top→bottom (root pushed first); rebuild bottom→top.
	for (let i = chain.length - 1; i >= 0; i--) {
		const entry = chain[i];
		switch (entry.kind) {
			case 'filter': {
				current = new FilterNode(entry.node.scope, current, entry.node.predicate);
				break;
			}
			case 'sort': {
				current = new SortNode(entry.node.scope, current, entry.node.sortKeys);
				break;
			}
			case 'limit': {
				current = new LimitOffsetNode(
					entry.node.scope,
					current,
					entry.node.limit,
					entry.node.offset,
				);
				break;
			}
			case 'distinct': {
				current = new DistinctNode(entry.node.scope, current);
				break;
			}
			case 'alias': {
				current = new AliasNode(entry.node.scope, current, entry.node.alias);
				break;
			}
		}
	}
	return current;
}

function rebuildProject(
	project: ProjectNode,
	newSource: RelationalPlanNode,
	subqueryReplacements?: ReadonlyMap<ScalarSubqueryNode, ColumnReferenceNode>,
): ProjectNode {
	const attributes = project.getAttributes();
	const newProjections = project.projections.map((p, i) => {
		// Substitute a recognized subquery projection with the column reference
		// into the fan-out's wide row; keep the projection's own attributeId/alias.
		const replacement =
			subqueryReplacements && p.node instanceof ScalarSubqueryNode
				? subqueryReplacements.get(p.node)
				: undefined;
		return {
			node: replacement ?? p.node,
			alias: p.alias,
			attributeId: attributes[i].id,
		};
	});
	if (!isRelationalNode(newSource)) {
		throw new Error('rule-fanout-lookup-join: rebuilt source must be relational');
	}
	return new ProjectNode(
		project.scope,
		newSource,
		newProjections,
		undefined,
		attributes,
		project.preserveInputColumns,
	);
}
