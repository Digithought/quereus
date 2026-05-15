/**
 * Inclusion-dependency reasoning helpers.
 *
 * Foreign keys are inclusion dependencies (`child.fk ⊆ parent.pk`). The rules
 * under `planner/rules/{join,subquery}/` that exploit this — join elimination,
 * anti-join-to-empty, semi-join trivialization, FK-covered aggregate elim —
 * all need the same primitives:
 *   - find a declared FK on the child that covers a given set of equi-pairs
 *     against a parent table,
 *   - extract the underlying `TableSchema` of a relational subtree (through
 *     standard row-preserving wrappers),
 *   - decide whether a relational subtree exposes the full row set of its
 *     underlying base table (no row-reducing wrapper between the join and the
 *     table).
 *
 * `extractTableSchema` and `checkFkPkAlignment` live in `key-utils.ts` because
 * they also serve non-IND callers (key coverage, FD propagation). This file
 * adds the IND-specific extensions: a covering-FK lookup that *returns* the
 * matched FK (so callers can inspect nullability), and the row-preserving
 * path walker.
 */

import type { TableSchema, ForeignKeyConstraintSchema } from '../../schema/table.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { RetrieveNode } from '../nodes/retrieve-node.js';
import { AliasNode } from '../nodes/alias-node.js';
import { SortNode } from '../nodes/sort.js';
import { extractTableSchema } from './key-utils.js';

/**
 * Result of a successful covering-FK lookup.
 *
 * `fk` is the matched declaration; `nullable` is true iff any child column in
 * the FK is nullable (the IND child→parent inclusion only guarantees the
 * non-null FK rows have a parent; NULL FK rows are not covered by the FK).
 */
export interface CoveringFKMatch {
	fk: ForeignKeyConstraintSchema;
	nullable: boolean;
}

/**
 * Look up a foreign key on `childSchema` that references `parentSchema` whose
 * `(fk_columns → referenced_pk_columns)` mapping equals the requested equi-pairs
 * — in some permutation — and where every referenced column is a primary-key
 * column of the parent.
 *
 * Returns the matched FK plus a nullability bit (true iff any FK child column
 * is nullable).
 *
 * The matching mirrors `checkFkPkAlignment` (`key-utils.ts`): an equi-pair list
 * is valid if there is some FK whose `columns` set equals the child's
 * equi-side and whose corresponding referenced PK columns are all in
 * `parentSchema.primaryKeyDefinition`.
 */
export function lookupCoveringFK(
	childSchema: TableSchema,
	parentSchema: TableSchema,
	childEquiCols: ReadonlyArray<number>,
	parentEquiCols: ReadonlyArray<number>,
): CoveringFKMatch | undefined {
	if (!childSchema.foreignKeys) return undefined;
	if (childEquiCols.length !== parentEquiCols.length) return undefined;
	if (childEquiCols.length === 0) return undefined;

	const equiMap = new Map<number, number>();
	for (let i = 0; i < childEquiCols.length; i++) {
		equiMap.set(childEquiCols[i], parentEquiCols[i]);
	}

	const pkColSet = new Set(parentSchema.primaryKeyDefinition.map(p => p.index));

	for (const fk of childSchema.foreignKeys) {
		if (fk.referencedTable.toLowerCase() !== parentSchema.name.toLowerCase()) continue;
		if (parentSchema.primaryKeyDefinition.length === 0) continue;
		if (fk.columns.length !== parentSchema.primaryKeyDefinition.length) continue;
		if (fk.columns.length !== childEquiCols.length) continue;

		let aligned = true;
		for (const fkColIdx of fk.columns) {
			const pkColIdx = equiMap.get(fkColIdx);
			if (pkColIdx === undefined || !pkColSet.has(pkColIdx)) {
				aligned = false;
				break;
			}
		}
		if (!aligned) continue;

		let nullable = false;
		for (const colIdx of fk.columns) {
			if (!childSchema.columns[colIdx]?.notNull) {
				nullable = true;
				break;
			}
		}
		return { fk, nullable };
	}
	return undefined;
}

/**
 * Convenience wrapper around `extractTableSchema` — same behaviour, exported
 * under a name that matches the IND-rules' vocabulary so callers don't need
 * to reach into key-utils for an unrelated import.
 */
export function tableSchemaOf(node: RelationalPlanNode): TableSchema | undefined {
	return extractTableSchema(node);
}

/**
 * True when `node` is a chain of wrappers that produces the full row set of
 * its underlying base table — i.e. nothing between the node and the table can
 * filter, limit, or deduplicate rows.
 *
 * Allowed wrappers: TableReferenceNode (base), RetrieveNode whose pipeline is
 * the bare TableReferenceNode (no pushed-down pipeline filter), AliasNode,
 * SortNode — all preserve row count *and* attribute-id mapping of their
 * source. ProjectNode is intentionally excluded: it may reorder/drop columns
 * which would invalidate the table-column-index→attribute-index assumption
 * the FK→PK alignment check relies on. Anything else (Filter, LimitOffset,
 * Distinct, Project, Join, Aggregate, Window, CTE, SetOperation, …)
 * disqualifies.
 *
 * Used by: INNER join elimination (PK side must be unfiltered) and aggregate
 * elimination over FK-covered joins (same reason — a row-reducing wrapper on
 * the eliminable side would have dropped rows the FK→PK guarantee assumes
 * are present).
 */
export function isRowPreservingPathToTable(node: RelationalPlanNode): boolean {
	if (node instanceof TableReferenceNode) return true;
	if (node instanceof RetrieveNode) {
		return node.source instanceof TableReferenceNode;
	}
	if (node instanceof AliasNode) return isRowPreservingPathToTable(node.source);
	if (node instanceof SortNode) return isRowPreservingPathToTable(node.source);
	return false;
}
