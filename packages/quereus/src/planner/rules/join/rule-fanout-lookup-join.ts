/**
 * Rule: Fan-out Lookup Join (FK→PK)
 *
 * Recognizes a chain of N LEFT/INNER nested-loop joins from a common outer
 * where every join's non-preserved side is a parameterized FK→PK lookup
 * matching the same alignment `ruleJoinElimination` already trusts. When the
 * branch count clears `tuning.parallel.minBranches` AND the projected latency
 * win covers the per-branch setup overhead, the chain rewrites to one
 * `FanOutLookupJoinNode` that drives the branches concurrently per outer row.
 *
 * Cost gate is anchored on `physical.expectedLatencyMs` — populated 0 for
 * in-process / memory-vtab paths, non-zero for remote vtabs whose access plan
 * declares per-call latency. As a consequence, with no remote-vtab plugin in
 * tree the rule is inert by design (memory-vtab golden plans don't change).
 *
 * Branch eligibility mirrors `ruleJoinElimination`:
 *   - AND-of-column-equalities ON-clause (any residual disqualifies the
 *     branch — leave it as a normal nested-loop join),
 *   - FK→PK alignment validated via `lookupCoveringFK` + `checkFkPkAlignment`,
 *   - INNER branches additionally require NOT-NULL FK + row-preserving path
 *     to the PK table.
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
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode } from '../../nodes/sort.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { checkFkPkAlignment, extractTableSchema } from '../../util/key-utils.js';
import { lookupCoveringFK, isRowPreservingPathToTable } from '../../util/ind-utils.js';
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

export function ruleFanOutLookupJoin(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const tuning = context.tuning.parallel;
	if (tuning.minBranches < 2) return null;

	// Walk pass-through wrappers down to the first JoinNode.
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
		return null;
	}

	// Collect the join chain top-to-bottom and find the outer subtree at the
	// deepest left. We will validate FK→PK alignment for each join, using the
	// outer subtree's schema as the FK side. This means the outer must resolve
	// to a single table schema (mirrors `ruleJoinElimination`'s requirement).
	const joins: JoinNode[] = [];
	let walker: RelationalPlanNode = current;
	while (walker instanceof JoinNode) {
		joins.push(walker);
		walker = walker.left;
	}
	const outerSubtree = walker;
	const outerSchema = extractTableSchema(outerSubtree);
	if (!outerSchema) return null;
	const outerAttrs = outerSubtree.getAttributes();

	// Bottom-up walk: joins[joins.length - 1] is the innermost (its .left ==
	// outerSubtree), joins[0] is the outermost. Process bottom-up so the order
	// of `branches` reflects the natural wide-row layout (outer + b0 + b1 + …).
	const branches: RecognizedBranch[] = [];
	for (let i = joins.length - 1; i >= 0; i--) {
		const join = joins[i];
		const recognized = recognizeBranch(join, outerSchema, outerAttrs);
		if (!recognized) {
			// A non-eligible branch in the middle breaks the cluster — without
			// a way to keep that branch in the original nested-loop position we
			// would change semantics. Bail out conservatively.
			return null;
		}
		branches.push(recognized);
	}

	if (branches.length < tuning.minBranches) return null;

	// Cost gate. `expectedLatencyMs` is populated 0 except on remote-vtab
	// access plans, so this skip keeps the rule inert for local-only chains.
	let maxLatency = 0;
	for (const b of branches) {
		const l = b.lookup.physical.expectedLatencyMs ?? 0;
		if (l > maxLatency) maxLatency = l;
	}
	if (maxLatency === 0) return null;

	const concurrencyCap = Math.max(1, Math.min(tuning.concurrency, branches.length));
	const savings = (branches.length - concurrencyCap) * maxLatency;
	const overhead = branches.length * tuning.branchSetupCost;
	if (savings <= overhead) return null;

	// Build branch specs. Each branch's `child` is the lookup wrapped in a
	// FilterNode carrying the original equi-condition — the runtime evaluates
	// that condition over each lookup row, with outer-side references resolved
	// via `rctx.context` (the parent fork's snapshot already carries the outer
	// slot, set by `runFanOutLookupJoin` before the fork). `outputAttrs`
	// mirrors the lookup's attribute identities so the final FanOut produces
	// the same attribute IDs the surrounding chain already references.
	const branchSpecs: FanOutBranchSpec[] = branches.map(b => {
		const parameterized = new FilterNode(node.scope, b.lookup, b.condition);
		return {
			child: parameterized,
			mode: b.mode,
			outputAttrs: b.lookup.getAttributes(),
			concurrencySafe: b.lookup.physical.concurrencySafe !== false,
		};
	});

	// `preserveAttributeIds` pins the wide-row layout to exactly what the
	// original join chain produced: outer attrs + each branch's lookup attrs.
	// Mirrors the layout `JoinNode` would build through nested-loop composition.
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

	log(
		'Forming FanOutLookupJoin with %d branches (cap=%d, maxLatency=%d)',
		branches.length, concurrencyCap, maxLatency,
	);

	const rebuilt = rebuildChain(chain, fanout);
	return rebuildProject(node, rebuilt);
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

function rebuildProject(project: ProjectNode, newSource: RelationalPlanNode): ProjectNode {
	const attributes = project.getAttributes();
	const newProjections = project.projections.map((p, i) => ({
		node: p.node,
		alias: p.alias,
		attributeId: attributes[i].id,
	}));
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
