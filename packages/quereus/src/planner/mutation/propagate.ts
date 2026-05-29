import { PlanNodeType } from '../nodes/plan-node-type.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import type { MutationDiagnosticReason } from './mutation-diagnostic.js';

/**
 * Mutation propagation classifier — the dual of `binding-extractor` /
 * `change-scope`, walking a planned view body from the user-visible relation
 * down to base-table references to decide whether a deterministic decomposition
 * exists at plan time (see `docs/view-updateability.md` § Mutation Propagation).
 *
 * **Phase 1 scope.** Only the *single-source projection-and-filter* shape is
 * decomposable: the relational spine from the body root to a base table may
 * contain only pass-through operators (Project / Filter / Sort / Limit /
 * Distinct / Alias / Retrieve) and must terminate at exactly one
 * `TableReferenceNode`. Joins, aggregates, set-ops, windows, recursive CTEs and
 * VALUES bodies are rejected with a structured reason; the broader FD/EC-driven
 * fan-out is Phase 2+.
 *
 * `Sort` / `Limit` / `Distinct` are tolerated *here* only so the walk can reach
 * the base table through them; the AST-driven rewrite layer
 * (`building/view-mutation.ts`) separately rejects `LIMIT`/`OFFSET`/`DISTINCT`
 * bodies, since a predicate-conjoin cannot faithfully reproduce a row-count
 * window or duplicate-collapse (a mutation would otherwise escape the window).
 *
 * The walk descends only *relational* children (`getRelations()`), so scalar
 * subqueries embedded in predicates/projections never pollute the base-table
 * count.
 */

/** Pass-through relational operators that a phase-1 decomposition tolerates. */
const PASSTHROUGH_NODES: ReadonlySet<PlanNodeType> = new Set([
	PlanNodeType.Retrieve,
	PlanNodeType.Filter,
	PlanNodeType.Project,
	PlanNodeType.Distinct,
	PlanNodeType.Sort,
	PlanNodeType.LimitOffset,
	PlanNodeType.Alias,
]);

export interface SingleSourceDecomposition {
	readonly kind: 'single-source';
	/** The single base table all mutations decompose onto. */
	readonly baseTable: TableReferenceNode;
}

export interface RejectedDecomposition {
	readonly kind: 'rejected';
	readonly reason: MutationDiagnosticReason;
	readonly detail: string;
}

export type ViewBodyClassification = SingleSourceDecomposition | RejectedDecomposition;

/** Map a disallowed body operator to a structured rejection reason. */
function reasonForOperator(nodeType: PlanNodeType): MutationDiagnosticReason {
	switch (nodeType) {
		case PlanNodeType.Join:
		case PlanNodeType.NestedLoopJoin:
		case PlanNodeType.HashJoin:
		case PlanNodeType.MergeJoin:
		case PlanNodeType.AsofScan:
		case PlanNodeType.FanOutLookupJoin:
			return 'unsupported-join';
		case PlanNodeType.Aggregate:
		case PlanNodeType.StreamAggregate:
		case PlanNodeType.HashAggregate:
			return 'unsupported-aggregate';
		case PlanNodeType.SetOperation:
			return 'unsupported-set-op';
		case PlanNodeType.Window:
			return 'unsupported-window';
		case PlanNodeType.RecursiveCTE:
		case PlanNodeType.InternalRecursiveCTERef:
			return 'recursive-cte';
		default:
			return 'no-base-lineage';
	}
}

/**
 * Classify a planned view body for phase-1 mutability. Returns the single base
 * table when the body is a single-source projection-and-filter, or a structured
 * rejection naming the obstructing operator.
 */
export function classifyViewBody(body: RelationalPlanNode): ViewBodyClassification {
	const tableRefs: TableReferenceNode[] = [];
	let rejection: RejectedDecomposition | undefined;

	const visit = (node: PlanNode): void => {
		if (rejection) return;

		if (node instanceof TableReferenceNode) {
			tableRefs.push(node);
			return;
		}

		if (isRelationalNode(node) && !PASSTHROUGH_NODES.has(node.nodeType)) {
			rejection = {
				kind: 'rejected',
				reason: reasonForOperator(node.nodeType),
				detail: `view body operator '${node.nodeType}' is not updateable in phase 1`,
			};
			return;
		}

		for (const child of node.getRelations()) {
			visit(child);
		}
	};

	visit(body);

	if (rejection) return rejection;

	if (tableRefs.length === 0) {
		return {
			kind: 'rejected',
			reason: 'no-base-lineage',
			detail: 'view body reaches no base table (e.g. a VALUES body); no recoverable base operation',
		};
	}

	if (tableRefs.length > 1) {
		return {
			kind: 'rejected',
			reason: 'unsupported-join',
			detail: `view body references ${tableRefs.length} base tables; multi-source decomposition is phase 2`,
		};
	}

	return { kind: 'single-source', baseTable: tableRefs[0] };
}
