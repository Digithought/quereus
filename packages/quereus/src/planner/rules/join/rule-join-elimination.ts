/**
 * Rule: Join Elimination (FK→PK)
 *
 * Eliminates a join whose non-preserved side is never referenced above the join
 * and is guaranteed at-most-one-matching per FK→PK alignment.
 *
 * The rule fires on ProjectNode and walks down through a whitelist of
 * pass-through nodes (Filter, Sort, LimitOffset, Distinct, Alias) collecting
 * the set of attribute IDs that any caller above the join still demands. When
 * the walk reaches a JoinNode, the demanded set is final for that chain:
 *
 *   - If the demanded set only references the preserved side and the equi-join
 *     condition aligns FK columns on the preserved side with the PK on the
 *     other side, the join is rewritten away.
 *   - For LEFT/RIGHT outer joins, only the non-preserved side may be eliminated
 *     (the preserved side is required by SQL semantics).
 *   - For INNER joins, either side may be eliminated, but additionally the FK
 *     columns must be NOT NULL — otherwise NULL FK rows that wouldn't have
 *     matched on the join would now survive.
 *
 * Non-equi residual conjuncts in the ON-clause disqualify the rewrite (they
 * may alter cardinality beyond the FK→PK guarantee).
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode } from '../../nodes/sort.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { ColumnReferenceNode, TableReferenceNode } from '../../nodes/reference.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { checkFkPkAlignment, extractTableSchema } from '../../util/key-utils.js';
import type { ForeignKeyConstraintSchema, TableSchema } from '../../../schema/table.js';

const log = createLogger('optimizer:rule:join-elimination');

type ChainEntry =
	| { kind: 'filter'; node: FilterNode }
	| { kind: 'sort'; node: SortNode }
	| { kind: 'limit'; node: LimitOffsetNode }
	| { kind: 'distinct'; node: DistinctNode }
	| { kind: 'alias'; node: AliasNode };

interface ChainWalkResult {
	join: JoinNode;
	chain: ChainEntry[];
}

export function ruleJoinElimination(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const demanded = new Set<number>();
	for (const proj of node.projections) {
		collectAttrIds(proj.node, demanded);
	}

	const walk = walkChain(node.source, demanded);
	if (!walk) return null;

	const { join, chain } = walk;
	if (join.joinType !== 'left' && join.joinType !== 'right' && join.joinType !== 'inner') return null;
	if (!join.condition) return null;

	const leftAttrs = join.left.getAttributes();
	const rightAttrs = join.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(join.condition, leftAttrs, rightAttrs);
	if (pairs.length === 0) return null;

	const normalized = normalizePredicate(join.condition);
	if (!isAndOfColumnEqualities(normalized)) return null;

	const leftIds = new Set(leftAttrs.map(a => a.id));
	const rightIds = new Set(rightAttrs.map(a => a.id));
	const usesLeft = setsIntersect(demanded, leftIds);
	const usesRight = setsIntersect(demanded, rightIds);

	let preserved: RelationalPlanNode | null = null;
	switch (join.joinType) {
		case 'left':
			if (usesRight) return null;
			preserved = tryEliminate(join, 'right', pairs);
			break;
		case 'right':
			if (usesLeft) return null;
			preserved = tryEliminate(join, 'left', pairs);
			break;
		case 'inner':
			if (!usesRight) {
				preserved = tryEliminate(join, 'right', pairs);
			}
			if (!preserved && !usesLeft) {
				preserved = tryEliminate(join, 'left', pairs);
			}
			break;
	}

	if (!preserved) return null;

	log('Eliminating %s join under Project; preserved side has %d attrs',
		join.joinType, preserved.getAttributes().length);

	const newSource = rebuildChain(chain, preserved);
	return rebuildProject(node, newSource);
}

function collectAttrIds(expr: PlanNode, out: Set<number>): void {
	if (expr instanceof ColumnReferenceNode) {
		out.add(expr.attributeId);
		return;
	}
	for (const child of expr.getChildren()) {
		collectAttrIds(child, out);
	}
}

function walkChain(root: RelationalPlanNode, demanded: Set<number>): ChainWalkResult | null {
	const chain: ChainEntry[] = [];
	let current: RelationalPlanNode = root;

	while (true) {
		if (current instanceof JoinNode) {
			return { join: current, chain };
		}
		if (current instanceof FilterNode) {
			collectAttrIds(current.predicate, demanded);
			chain.push({ kind: 'filter', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof SortNode) {
			for (const k of current.sortKeys) {
				collectAttrIds(k.expression, demanded);
			}
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
			// DISTINCT collapses duplicates that the join (with at-most-one matching)
			// would never have produced anyway; safe to walk through.
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
}

function setsIntersect(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const v of small) {
		if (large.has(v)) return true;
	}
	return false;
}

/**
 * AND-of-equalities check: every conjunct must be `colRef = colRef`. Any other
 * predicate shape (range comparison, non-equality, OR, function calls, …)
 * disqualifies the rewrite — those residuals can change row counts beyond what
 * the FK→PK guarantee covers.
 */
function isAndOfColumnEqualities(expr: ScalarPlanNode): boolean {
	if (!(expr instanceof BinaryOpNode)) return false;
	const stack: ScalarPlanNode[] = [expr];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (!(n instanceof BinaryOpNode)) return false;
		const op = n.expression.operator;
		if (op === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}
		if (op !== '=') return false;
		if (!(n.left instanceof ColumnReferenceNode)) return false;
		if (!(n.right instanceof ColumnReferenceNode)) return false;
	}
	return true;
}

/**
 * Validate FK→PK alignment for eliminating `sideToRemove` and return the
 * preserved side relational node when safe.
 */
function tryEliminate(
	join: JoinNode,
	sideToRemove: 'left' | 'right',
	pairs: ReadonlyArray<{ left: number; right: number }>,
): RelationalPlanNode | null {
	const leftSchema = extractTableSchema(join.left as RelationalPlanNode);
	const rightSchema = extractTableSchema(join.right as RelationalPlanNode);
	if (!leftSchema || !rightSchema) return null;

	// FK side is the preserved side; PK side is the side being removed.
	const fkSchema = sideToRemove === 'right' ? leftSchema : rightSchema;
	const pkSchema = sideToRemove === 'right' ? rightSchema : leftSchema;
	const fkEquiCols = pairs.map(p => sideToRemove === 'right' ? p.left : p.right);
	const pkEquiCols = pairs.map(p => sideToRemove === 'right' ? p.right : p.left);

	if (!checkFkPkAlignment(fkSchema, pkSchema, fkEquiCols, pkEquiCols)) return null;

	// INNER joins additionally require:
	//  1. NOT NULL on every FK column — with nullable FK, rows with NULL FKs
	//     wouldn't survive the inner join but would survive elimination.
	//  2. The eliminable side must produce the underlying PK table's full row
	//     set — any row-reducing wrapper (Filter, LimitOffset, Distinct,
	//     RetrieveNode with a non-trivial pipeline) between the join and the
	//     base table would have dropped rows that the FK→PK guarantee assumes
	//     are present, so eliminating would silently survive orphaned FK rows.
	if (join.joinType === 'inner') {
		const fkRow = findMatchingForeignKey(fkSchema, pkSchema, fkEquiCols, pkEquiCols);
		if (!fkRow) return null;
		for (const colIdx of fkRow.columns) {
			if (!fkSchema.columns[colIdx]?.notNull) return null;
		}
		const eliminableSide = sideToRemove === 'right' ? join.right : join.left;
		if (!isRowPreservingPathToTable(eliminableSide as RelationalPlanNode)) return null;
	}

	return (sideToRemove === 'right' ? join.left : join.right) as RelationalPlanNode;
}

/**
 * True when `node` is a chain of wrappers that produces the full row set of
 * its underlying base table — i.e. nothing between the join and the table can
 * filter, limit, or deduplicate rows. Required for INNER-JOIN elimination so
 * that dropping the eliminable side doesn't silently survive rows the join
 * would have filtered.
 *
 * Allowed wrappers: TableReferenceNode (base), RetrieveNode whose pipeline is
 * the bare TableReferenceNode (no pushed-down pipeline filter), AliasNode,
 * SortNode — all preserve row count *and* attribute-id mapping of their
 * source. ProjectNode is intentionally excluded: it may reorder/drop columns
 * which would invalidate the table-column-index→attribute-index assumption
 * `checkFkPkAlignment` relies on.
 * Anything else (Filter, LimitOffset, Distinct, Project, Join, Aggregate,
 * Window, CTE, SetOperation, …) disqualifies.
 */
function isRowPreservingPathToTable(node: RelationalPlanNode): boolean {
	if (node instanceof TableReferenceNode) return true;
	if (node instanceof RetrieveNode) {
		return node.source instanceof TableReferenceNode;
	}
	if (node instanceof AliasNode) return isRowPreservingPathToTable(node.source);
	if (node instanceof SortNode) return isRowPreservingPathToTable(node.source);
	return false;
}

function findMatchingForeignKey(
	fkSchema: TableSchema,
	pkSchema: TableSchema,
	fkEquiCols: ReadonlyArray<number>,
	pkEquiCols: ReadonlyArray<number>,
): ForeignKeyConstraintSchema | undefined {
	if (!fkSchema.foreignKeys) return undefined;

	const equiMap = new Map<number, number>();
	for (let i = 0; i < fkEquiCols.length; i++) {
		equiMap.set(fkEquiCols[i], pkEquiCols[i]);
	}

	const pkColSet = new Set(pkSchema.primaryKeyDefinition.map(p => p.index));

	for (const fk of fkSchema.foreignKeys) {
		if (fk.referencedTable.toLowerCase() !== pkSchema.name.toLowerCase()) continue;
		if (pkSchema.primaryKeyDefinition.length === 0) continue;
		if (fk.columns.length !== pkSchema.primaryKeyDefinition.length) continue;

		let aligned = true;
		for (const fkColIdx of fk.columns) {
			const pkColIdx = equiMap.get(fkColIdx);
			if (pkColIdx === undefined || !pkColSet.has(pkColIdx)) {
				aligned = false;
				break;
			}
		}
		if (aligned) return fk;
	}
	return undefined;
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
		throw new Error('rule-join-elimination: rebuilt source must be relational');
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
