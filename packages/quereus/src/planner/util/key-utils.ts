import type { ColRef, RelationType } from '../../common/datatype.js';
import type { Attribute, PhysicalProperties, RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { JoinType } from '../nodes/join-node.js';
import type { TableSchema } from '../../schema/table.js';
import { resolveReferencedColumns } from '../../schema/table.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../nodes/reference.js';
import { LiteralNode } from '../nodes/scalar.js';
import { isSuperkey } from './fd-utils.js';

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
	// pure helper: no owning node; callers pass raw attrs incl. unit tests, so we
	// keep the array scan rather than migrating to RelationalPlanNode.getAttributeIndex().
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
 * Test whether any key in `keys` has all of its columns covered by `eqIndices`.
 * A covered key means each row in the source side maps to ≤ 1 row in the join's
 * equi-pair partner, so the partner side's keys survive null-padding (LEFT/RIGHT).
 */
function joinPairsCoverKey(
	keys: ReadonlyArray<ReadonlyArray<{ index: number }>>,
	eqIndices: Set<number>,
): boolean {
	return keys.some(k => k.length > 0 && k.every(c => eqIndices.has(c.index)));
}

/**
 * Combine unique keys across a join (logical `RelationType.keys` form).
 *
 * Soundness mirrors `analyzeJoinKeyCoverage`: a side's key survives the join
 * only when each of its rows matches ≤ 1 row on the other side — i.e. the
 * equi-pairs cover a unique key of the *opposite* side. An unconditional union
 * would be unsound: a plain cross/inner join duplicates one side's key values
 * for every matching row on the other side (`ta CROSS JOIN tb` repeats `ta`'s
 * PK once per `tb` row, so `ta`'s PK is not a key of the product).
 *
 * - `inner` / `cross`: left keys survive iff a right-side key is covered; right
 *   keys (shifted by `leftColumnCount`) survive iff a left-side key is covered.
 *   A key=key join covers both, so both survive. A bare cross join covers
 *   neither, so the result is `[]` — set-ness of the full product is carried by
 *   `RelationType.isSet` instead.
 * - `left`: if `equiPairs` cover any right-side key, return left keys unchanged
 *   (each left row matches ≤ 1 right row, so left's keys survive). Otherwise `[]`.
 * - `right`: symmetric — if `equiPairs` cover any left-side key, return right's
 *   keys shifted by `leftColumnCount`. Otherwise `[]`.
 * - `full`: `[]` (both sides may be null-padded).
 * - `semi` / `anti`: return left keys (left-only output, no null-padding).
 *
 * `equiPairs` is optional; when omitted, the LEFT/RIGHT and inner/cross branches
 * conservatively return `[]` (no coverage can be proven).
 */
export function combineJoinKeys(
	leftKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
	rightKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
	joinType: JoinType,
	leftColumnCount: number,
	equiPairs?: ReadonlyArray<{ left: number; right: number }>,
): ColRef[][] {
	switch (joinType) {
		case 'inner':
		case 'cross': {
			const result: ColRef[][] = [];
			const leftEqSet = new Set<number>((equiPairs ?? []).map(p => p.left));
			const rightEqSet = new Set<number>((equiPairs ?? []).map(p => p.right));
			// Left's keys survive only when each left row matches ≤ 1 right row,
			// i.e. the equi-pairs cover a right-side key.
			if (joinPairsCoverKey(rightKeys, rightEqSet)) {
				for (const key of leftKeys) {
					result.push(key.map(c => ({ index: c.index, desc: c.desc })));
				}
			}
			// Symmetrically for the right side.
			if (joinPairsCoverKey(leftKeys, leftEqSet)) {
				for (const key of rightKeys) {
					result.push(key.map(c => ({ index: c.index + leftColumnCount, desc: c.desc })));
				}
			}
			return result;
		}
		case 'left': {
			if (!equiPairs || equiPairs.length === 0) return [];
			const rightEqSet = new Set<number>(equiPairs.map(p => p.right));
			if (!joinPairsCoverKey(rightKeys, rightEqSet)) return [];
			return leftKeys.map(key => key.map(c => ({ index: c.index, desc: c.desc })));
		}
		case 'right': {
			if (!equiPairs || equiPairs.length === 0) return [];
			const leftEqSet = new Set<number>(equiPairs.map(p => p.left));
			if (!joinPairsCoverKey(leftKeys, leftEqSet)) return [];
			return rightKeys.map(key => key.map(c => ({ index: c.index + leftColumnCount, desc: c.desc })));
		}
		case 'semi':
		case 'anti':
			return leftKeys.map(key => key.map(c => ({ index: c.index, desc: c.desc })));
		case 'full':
		default:
			return [];
	}
}

/**
 * Result of analyzing key coverage for a join's equi-join pairs.
 *
 * `preservedKeys` lists the per-output-column key sets that survive the join
 * (combined left/right indices, with right's indices already shifted by
 * `leftColumnCount`). Empty when no key survives. Callers translate each
 * preserved key into the FD `key → (all_other_join_cols)` via `superkeyToFd`.
 */
export interface JoinKeyCoverageResult {
	leftKeyCovered: boolean;
	rightKeyCovered: boolean;
	preservedKeys: number[][];
	estimatedRows: number | undefined;
}

/**
 * Shared key-coverage analysis for all join node types.
 *
 * Checks whether equi-join pairs cover a unique key on either side (via logical
 * `RelationType.keys` or the FD closure of the side's physical properties). When
 * a key is covered, the other side's unique keys are preserved and
 * estimatedRows is capped at the non-covered side's row count.
 *
 * @param joinType       The join type (inner, left, semi, etc.)
 * @param leftPhys       Physical properties of the left child
 * @param rightPhys      Physical properties of the right child
 * @param leftType       Logical type of the left child (for logical keys + colCount)
 * @param rightType      Logical type of the right child (for logical keys + colCount)
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
	const leftColCount = leftType?.columns.length ?? leftColumnCount;
	const rightColCount = rightType?.columns.length ?? 0;

	// Logical keys on each side, as column-index arrays.
	const leftLogicalKeys = (leftType?.keys ?? []).map(k => k.map(c => c.index));
	const rightLogicalKeys = (rightType?.keys ?? []).map(k => k.map(c => c.index));

	if (joinType === 'semi' || joinType === 'anti') {
		// Left's keys survive (output is the left shape). Preserved-key list mirrors
		// left's logical keys; the propagateJoinFds layer materializes them as FDs.
		return {
			leftKeyCovered: false,
			rightKeyCovered: false,
			preservedKeys: leftLogicalKeys.map(k => k.slice()),
			estimatedRows: undefined,
		};
	}

	if (joinType === 'full') {
		return { leftKeyCovered: false, rightKeyCovered: false, preservedKeys: [], estimatedRows: undefined };
	}

	const leftEqSet = new Set<number>(equiPairs.map(p => p.left));
	const rightEqSet = new Set<number>(equiPairs.map(p => p.right));

	function coversLogicalKey(keys: ReadonlyArray<ReadonlyArray<number>>, eqSet: Set<number>): boolean {
		return keys.some(key => key.length > 0 && key.every(idx => eqSet.has(idx)));
	}

	const leftKeyCovered =
		coversLogicalKey(leftLogicalKeys, leftEqSet) ||
		isSuperkey(leftEqSet, leftPhys?.fds, leftColCount);
	const rightKeyCovered =
		coversLogicalKey(rightLogicalKeys, rightEqSet) ||
		isSuperkey(rightEqSet, rightPhys?.fds, rightColCount);

	// Surviving "physical" keys on each side: union of logical keys and any
	// non-trivial key sets the FD closure makes apparent. We use logical keys
	// (the schema/type-level claim) — they're the source of truth for "this
	// relation has a key on these columns". Physical FDs may have additional
	// implied keys but enumerating them costs more than it saves here.
	const leftKeys = leftLogicalKeys;
	const rightKeysShifted = rightLogicalKeys.map(k => k.map(i => i + leftColumnCount));
	const preservedKeys: number[][] = [];
	let estimatedRows: number | undefined = undefined;

	if (joinType === 'inner' || joinType === 'cross') {
		if (rightKeyCovered) preservedKeys.push(...leftKeys.map(k => k.slice()));
		if (leftKeyCovered) preservedKeys.push(...rightKeysShifted.map(k => k.slice()));

		// Cardinality reduction: when a key is covered, result rows ≤ the other side's rows
		if (rightKeyCovered && typeof leftRows === 'number') estimatedRows = leftRows;
		if (leftKeyCovered && typeof rightRows === 'number') estimatedRows = (estimatedRows === undefined) ? rightRows : Math.min(estimatedRows, rightRows);
	} else if (joinType === 'left') {
		// LEFT outer: left's keys survive (and left's rowcount caps the output) iff
		// the equi-pairs cover a right-side unique key — each left row then matches
		// ≤ 1 right row, so no row duplication. The right-side keys do NOT survive:
		// unmatched left rows produce NULL-padded right columns, breaking right keys.
		if (rightKeyCovered) {
			preservedKeys.push(...leftKeys.map(k => k.slice()));
			if (typeof leftRows === 'number') estimatedRows = leftRows;
		}
	} else if (joinType === 'right') {
		// Symmetric to LEFT.
		if (leftKeyCovered) {
			preservedKeys.push(...rightKeysShifted.map(k => k.slice()));
			if (typeof rightRows === 'number') estimatedRows = rightRows;
		}
	}

	return { leftKeyCovered, rightKeyCovered, preservedKeys, estimatedRows };
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
 * Alignment is *positional*: for each declared FK column at index `i`, the
 * equi-pair partner must equal the FK's declared `referencedColumns[i]`. A
 * composite FK `(fa, fb) REFERENCES p(a, b)` only covers the pairing
 * `fa = a AND fb = b`; a permuted equi-pair set (`fa = b AND fb = a`) is NOT
 * guaranteed by the FK and must not be reported as aligned. A defensive
 * cross-check additionally requires every `fk.referencedColumns[i]` to be a
 * PK column so a malformed FK referencing non-PK columns is never reported as
 * an IND on the PK.
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

		const pkDef = pkTable.primaryKeyDefinition;
		if (pkDef.length === 0 || fk.columns.length !== pkDef.length) continue;

		// FK schemas store an empty referencedColumns at CREATE TABLE time; the
		// real indices are resolved against the parent here.
		let refCols: ReadonlyArray<number>;
		try {
			refCols = resolveReferencedColumns(fk, pkTable);
		} catch {
			continue;
		}
		if (refCols.length !== fk.columns.length) continue;

		// Build mapping: for each equi-pair, fk column index -> pk column index
		const equiMap = new Map<number, number>();
		for (let i = 0; i < fkEquiIndices.length; i++) {
			equiMap.set(fkEquiIndices[i], pkEquiIndices[i]);
		}

		const pkColSet = new Set(pkDef.map(pk => pk.index));
		let allAligned = true;
		for (let i = 0; i < fk.columns.length; i++) {
			// Defensive: a malformed FK referencing a non-PK column must never be
			// reported as an IND on the parent PK.
			if (!pkColSet.has(refCols[i])) {
				allAligned = false;
				break;
			}
			// Positional match: the equi-partner of fk.columns[i] must equal the
			// parent column the FK declares at position i.
			const partner = equiMap.get(fk.columns[i]);
			if (partner !== refCols[i]) {
				allAligned = false;
				break;
			}
		}

		if (allAligned) return true;
	}

	return false;
}
