import type { ColRef } from '../../common/datatype.js';

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
 * Combine unique keys across a join.
 * - For inner/cross joins: keys from left and right are preserved; right indices are shifted by left column count.
 * - For outer joins: return [] conservatively (null padding may break uniqueness).
 */
export function combineJoinKeys(leftKeys: ReadonlyArray<ReadonlyArray<ColRef>>, rightKeys: ReadonlyArray<ReadonlyArray<ColRef>>, joinType: 'inner' | 'left' | 'right' | 'full' | 'cross', leftColumnCount: number): ColRef[][] {
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


