/**
 * Rule: Anti-Join FK → Empty
 *
 * Inclusion-dependency folding for `NOT EXISTS` patterns after
 * `rule-subquery-decorrelation` has materialized them as anti-joins.
 *
 * Pattern:
 *   AntiJoin(L, R, p)
 *     where p is an AND-of-column-equalities,
 *     L's equi columns form a declared FK referencing R's PK (via the equi
 *     pairs in some permutation),
 *     every FK child column is NOT NULL, and
 *     R is a row-preserving path to its base table (no filter / limit / distinct
 *     between the anti-join and the parent table).
 *
 * Rewrite:
 *   Filter(L, false)
 *
 * Why correct: under the FK inclusion `L.fk ⊆ R.pk`, every non-null FK row in L
 * has a matching parent in R, so the anti-join contains no rows. With nullable
 * FKs, NULL FK rows survive (the equality is UNKNOWN, never matched), so the
 * rule conservatively requires all FK columns NOT NULL. Row-preserving R is
 * required because the IND only guarantees the parent row exists in the table
 * — a filter on the R side could remove it.
 *
 * Why not a dedicated EmptyRelationNode: the codebase has no generic empty
 * relation for arbitrary schemas. `Filter(L, false)` preserves L's attribute
 * IDs and relies on the runtime's predicate-evaluation short-circuit. Plan
 * shape is the same as any `where false` query; downstream readers see the
 * literal-false predicate and can short-circuit if they choose.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { LiteralNode } from '../../nodes/scalar.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { lookupCoveringFK, isRowPreservingPathToTable, tableSchemaOf } from '../../util/ind-utils.js';
import { isAndOfColumnEqualities } from '../join/rule-join-elimination.js';

const log = createLogger('optimizer:rule:anti-join-fk-empty');

export function ruleAntiJoinFkEmpty(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof JoinNode)) return null;
	if (node.joinType !== 'anti') return null;
	if (!node.condition) return null;

	const normalized = normalizePredicate(node.condition);
	if (!isAndOfColumnEqualities(normalized)) return null;

	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(node.condition, leftAttrs, rightAttrs);
	if (pairs.length === 0) return null;

	const leftSchema = tableSchemaOf(node.left);
	const rightSchema = tableSchemaOf(node.right);
	if (!leftSchema || !rightSchema) return null;

	const childEquiCols = pairs.map(p => p.left);
	const parentEquiCols = pairs.map(p => p.right);
	const match = lookupCoveringFK(leftSchema, rightSchema, childEquiCols, parentEquiCols);
	if (!match) return null;

	// Nullable FK leaks NULL rows through the anti-join (NULL = X is UNKNOWN,
	// never matched), so we can only fold when every FK column is NOT NULL.
	if (match.nullable) return null;

	// The parent side must expose the full base-table row set — otherwise the
	// IND `L.fk ⊆ R.pk` doesn't guarantee a match in the filtered relation.
	if (!isRowPreservingPathToTable(node.right)) return null;

	log('Folding anti-join over FK %s.%s → %s to empty',
		leftSchema.name,
		match.fk.columns.map(c => leftSchema.columns[c]?.name ?? c).join(','),
		rightSchema.name,
	);

	const literalFalse = new LiteralNode(node.scope, { type: 'literal', value: false });
	return new FilterNode(node.scope, node.left, literalFalse);
}
