import type { ColRef, RelationType } from '../../common/datatype.js';
import type { Attribute, PhysicalProperties, RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { JoinType } from '../nodes/join-node.js';
import type { TableSchema } from '../../schema/table.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../nodes/reference.js';
import { LiteralNode } from '../nodes/scalar.js';

/**
 * Project unique keys through a projection mapping.
 * - sourceKeys: keys defined on the source relation (arrays of column refs by source column index)
 * - projectionMap: mapping from source column index -> projected column index
 * Returns keys that survive projection (all columns present), with indices remapped to output.
 */
export function projectKeys(sourceKeys: ReadonlyArray<ReadonlyArray<ColRef>>, projectionMap: ReadonlyMap<number, number>): ColRef[][] {
	const result: ColRef[][] = [];
	for (const key of sourceKeys) {
		const projected: ColRef[] = [];
		let missing = false;
		for (const col of key) {
			const projectedIndex = projectionMap.get(col.index);
			if (projectedIndex === undefined) {
				missing = true;
				break;
			}
			projected.push({ index: projectedIndex, desc: col.desc });
		}
		if (!missing) {
			result.push(projected);
		}
	}
	return result;
}

/**
 * One projected scalar expression annotated with its zero-based output column index.
 */
export interface InjectiveProjectionEntry {
	expr: ScalarPlanNode;
	outIndex: number;
}

/**
 * Result of `deriveProjectionColumnMap`. `map` carries the source→output column
 * mapping that key/FD/EC propagation should walk; `injectivePairs` lists the
 * extra `[sourceIdx, outIdx]` entries that originate from an *injective unary*
 * projection over a single source attribute (e.g. `id + 1` over PK `id`).
 *
 * `injectivePairs` is reported separately so callers can emit a bi-directional
 * FD between the bare-source output column and the injectively-derived output
 * column (when both ends are present in the projection list). Bare-column
 * projections are NOT listed in `injectivePairs` — they are trivially identity
 * and would only produce useless `{i} → {i}` FDs.
 */
export interface ProjectionMappingResult {
	map: Map<number, number>;
	injectivePairs: Array<[number, number]>;
}

/**
 * Walk the scalar `expr` collecting:
 *   - `attrIds`: the set of unique `ColumnReferenceNode` attribute IDs it depends on,
 *   - `allOtherLeavesConstant`: true iff every non-column leaf is a `LiteralNode`
 *     or `ParameterReferenceNode`.
 *
 * Early-exits when a non-constant non-column leaf is found.
 */
function analyzeProjectionLeaves(expr: ScalarPlanNode): { attrIds: Set<number>; allOtherLeavesConstant: boolean } {
	const attrIds = new Set<number>();
	let allOtherLeavesConstant = true;

	const stack: ScalarPlanNode[] = [expr];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n instanceof ColumnReferenceNode) {
			attrIds.add(n.attributeId);
			continue;
		}
		const children = n.getChildren();
		if (children.length === 0) {
			// Leaf that is not a column reference: must be a compile-time constant.
			if (!(n instanceof LiteralNode || n instanceof ParameterReferenceNode)) {
				allOtherLeavesConstant = false;
				break;
			}
			continue;
		}
		for (const c of children) {
			// Only descend through scalar children; scalar expressions only have scalar children.
			stack.push(c as ScalarPlanNode);
		}
	}

	return { attrIds, allOtherLeavesConstant };
}

/**
 * Build a source→output column mapping that includes BOTH:
 *   - direct `ColumnReferenceNode` projections (bare passthrough), and
 *   - injective unary projections: the expression references exactly one source
 *     attribute `a`, `expr.isInjectiveIn(a).injective === true`, and every other
 *     leaf is a compile-time constant (`LiteralNode` / `ParameterReferenceNode`).
 *     For those, the output column is treated as a synonym of source column
 *     `src(a)`.
 *
 * The bare-column rule wins on collisions: if the same source column is also
 * projected directly, that mapping is preserved (first-occurrence wins, matching
 * the historical behaviour) and the injective entry is recorded in
 * `injectivePairs` instead.
 */
export function deriveProjectionColumnMap(
	sourceAttrs: readonly Attribute[],
	projections: readonly InjectiveProjectionEntry[],
): ProjectionMappingResult {
	const map = new Map<number, number>();
	const injectivePairs: Array<[number, number]> = [];

	// Pass 1: bare column references (highest priority for `map`).
	for (const { expr, outIndex } of projections) {
		if (expr instanceof ColumnReferenceNode) {
			const srcIndex = sourceAttrs.findIndex(a => a.id === expr.attributeId);
			if (srcIndex >= 0 && !map.has(srcIndex)) {
				map.set(srcIndex, outIndex);
			}
		}
	}

	// Pass 2: injectively-derived columns.
	for (const { expr, outIndex } of projections) {
		if (expr instanceof ColumnReferenceNode) continue;

		const { attrIds, allOtherLeavesConstant } = analyzeProjectionLeaves(expr);
		if (!allOtherLeavesConstant) continue;
		if (attrIds.size !== 1) continue;

		const attrId = attrIds.values().next().value as number;
		if (!expr.isInjectiveIn(attrId).injective) continue;

		const srcIndex = sourceAttrs.findIndex(a => a.id === attrId);
		if (srcIndex < 0) continue;

		// Map first-occurrence wins; injective entries fill in slots not already
		// claimed by a bare-column projection. The pair is *always* recorded so
		// callers can decide whether to emit the bi-directional FD.
		if (!map.has(srcIndex)) {
			map.set(srcIndex, outIndex);
		}
		injectivePairs.push([srcIndex, outIndex]);
	}

	return { map, injectivePairs };
}

/**
 * Combine unique keys across a join.
 * - For inner/cross joins: keys from left and right are preserved; right indices are shifted by left column count.
 * - For outer joins: return [] conservatively (null padding may break uniqueness).
 */
export function combineJoinKeys(leftKeys: ReadonlyArray<ReadonlyArray<ColRef>>, rightKeys: ReadonlyArray<ReadonlyArray<ColRef>>, joinType: string, leftColumnCount: number): ColRef[][] {
	if (joinType !== 'inner' && joinType !== 'cross') return [];
	const result: ColRef[][] = [];
	for (const key of leftKeys) {
		result.push(key.map(c => ({ index: c.index, desc: c.desc })));
	}
	for (const key of rightKeys) {
		result.push(key.map(c => ({ index: c.index + leftColumnCount, desc: c.desc })));
	}
	return result;
}

/**
 * Result of analyzing key coverage for a join's equi-join pairs.
 */
export interface JoinKeyCoverageResult {
	leftKeyCovered: boolean;
	rightKeyCovered: boolean;
	uniqueKeys: number[][] | undefined;
	estimatedRows: number | undefined;
}

/**
 * Shared key-coverage analysis for all join node types.
 *
 * Checks whether equi-join pairs cover a unique key on either side (logical or
 * physical). When a key is covered, the other side's unique keys are preserved
 * and estimatedRows is capped at the non-covered side's row count.
 *
 * @param joinType       The join type (inner, left, semi, etc.)
 * @param leftPhys       Physical properties of the left child
 * @param rightPhys      Physical properties of the right child
 * @param leftType       Logical type of the left child (for logical keys)
 * @param rightType      Logical type of the right child (for logical keys)
 * @param equiPairs      Equi-join column index pairs (left index, right index)
 * @param leftRows       Estimated rows from left child
 * @param rightRows      Estimated rows from right child
 * @param leftColumnCount Number of columns on the left side (for shifting right key indices)
 */
export function analyzeJoinKeyCoverage(
	joinType: JoinType,
	leftPhys: PhysicalProperties | undefined,
	rightPhys: PhysicalProperties | undefined,
	leftType: RelationType | undefined,
	rightType: RelationType | undefined,
	equiPairs: ReadonlyArray<{ left: number; right: number }>,
	leftRows: number | undefined,
	rightRows: number | undefined,
	leftColumnCount: number,
): JoinKeyCoverageResult {
	let uniqueKeys: number[][] | undefined = undefined;
	let estimatedRows: number | undefined = undefined;

	if (joinType === 'semi' || joinType === 'anti') {
		return {
			leftKeyCovered: false,
			rightKeyCovered: false,
			uniqueKeys: leftPhys?.uniqueKeys,
			estimatedRows: undefined,
		};
	}

	if (joinType !== 'inner' && joinType !== 'cross') {
		return { leftKeyCovered: false, rightKeyCovered: false, uniqueKeys: undefined, estimatedRows: undefined };
	}

	const leftEqSet = new Set<number>(equiPairs.map(p => p.left));
	const rightEqSet = new Set<number>(equiPairs.map(p => p.right));

	function coversKey(keys: ReadonlyArray<ReadonlyArray<{ index: number }>> | undefined, eqSet: Set<number>): boolean {
		if (!keys) return false;
		return keys.some(key => key.length > 0 && key.every(ref => eqSet.has(ref.index)));
	}

	function coversPhysicalKey(phys: PhysicalProperties | undefined, eqSet: Set<number>): boolean {
		if (!phys?.uniqueKeys) return false;
		return phys.uniqueKeys.some(key => key.length > 0 && key.every(idx => eqSet.has(idx)));
	}

	const leftKeyCovered = coversKey(leftType?.keys, leftEqSet) || coversPhysicalKey(leftPhys, leftEqSet);
	const rightKeyCovered = coversKey(rightType?.keys, rightEqSet) || coversPhysicalKey(rightPhys, rightEqSet);

	const leftKeys = leftPhys?.uniqueKeys || [];
	const rightKeys = (rightPhys?.uniqueKeys || []).map(k => k.map(i => i + leftColumnCount));
	const preserved: number[][] = [];
	if (rightKeyCovered) preserved.push(...leftKeys);
	if (leftKeyCovered) preserved.push(...rightKeys);
	if (preserved.length > 0) uniqueKeys = preserved;

	// Cardinality reduction: when a key is covered, result rows ≤ the other side's rows
	if (rightKeyCovered && typeof leftRows === 'number') estimatedRows = leftRows;
	if (leftKeyCovered && typeof rightRows === 'number') estimatedRows = (estimatedRows === undefined) ? rightRows : Math.min(estimatedRows, rightRows);

	return { leftKeyCovered, rightKeyCovered, uniqueKeys, estimatedRows };
}

/**
 * Extract TableSchema from a plan node by walking down through common wrappers
 * to find a RetrieveNode or TableReferenceNode.
 */
export function extractTableSchema(node: RelationalPlanNode): TableSchema | undefined {
	// Use duck typing to avoid circular imports
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const n = node as any;

	// TableReferenceNode
	if (n.nodeType === 'TableReference' && n.tableSchema) {
		return n.tableSchema as TableSchema;
	}

	// RetrieveNode
	if (n.nodeType === 'Retrieve' && n.tableRef) {
		return n.tableRef.tableSchema as TableSchema | undefined;
	}

	// Walk through single-child wrappers (Filter, Project, Sort, etc.)
	const relations = node.getRelations?.() ?? [];
	if (relations.length === 1) {
		return extractTableSchema(relations[0] as RelationalPlanNode);
	}

	return undefined;
}

/**
 * Check if an FK→PK relationship aligns with equi-join pairs.
 *
 * Given FK constraints on one side and the other side's table, checks if
 * the equi-join pairs align with an FK referencing the other side's PK.
 * Returns true if the FK side's columns map to the PK side through equi-pairs.
 */
export function checkFkPkAlignment(
	fkTable: TableSchema,
	pkTable: TableSchema,
	fkEquiIndices: ReadonlyArray<number>,
	pkEquiIndices: ReadonlyArray<number>,
): boolean {
	if (!fkTable.foreignKeys) return false;

	for (const fk of fkTable.foreignKeys) {
		if (fk.referencedTable.toLowerCase() !== pkTable.name.toLowerCase()) continue;

		// Check if the FK columns are all present as equi-join columns
		// and the corresponding PK columns on the other side match the PK definition
		const pkDef = pkTable.primaryKeyDefinition;
		if (pkDef.length === 0 || fk.columns.length !== pkDef.length) continue;

		// Build mapping: for each equi-pair, fk column index -> pk column index
		const equiMap = new Map<number, number>();
		for (let i = 0; i < fkEquiIndices.length; i++) {
			equiMap.set(fkEquiIndices[i], pkEquiIndices[i]);
		}

		// Check: every FK column is in equi-pairs, and the corresponding PK column
		// is part of the primary key
		const pkColSet = new Set(pkDef.map(pk => pk.index));
		let allAligned = true;
		for (const fkColIdx of fk.columns) {
			const pkColIdx = equiMap.get(fkColIdx);
			if (pkColIdx === undefined || !pkColSet.has(pkColIdx)) {
				allAligned = false;
				break;
			}
		}

		if (allAligned) return true;
	}

	return false;
}
