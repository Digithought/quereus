import type { Attribute } from './plan-node.js';
import type { JoinType } from './join-node.js';
import type { RelationType, ColRef } from '../../common/datatype.js';

/**
 * An equi-join pair: left attribute = right attribute.
 * Attribute IDs are stable across plan transformations.
 */
export interface EquiJoinPair {
	leftAttrId: number;
	rightAttrId: number;
}

/**
 * Build the output attributes for a join node.
 *
 * If `preserveAttributeIds` is supplied (physical join nodes created from a
 * logical JoinNode) the preserved set is returned directly.  Otherwise the
 * attributes are computed from the left/right inputs and the join type.
 */
export function buildJoinAttributes(
	leftAttrs: readonly Attribute[],
	rightAttrs: readonly Attribute[],
	joinType: JoinType,
	preserveAttributeIds?: readonly Attribute[],
): Attribute[] {
	if (preserveAttributeIds) return preserveAttributeIds.slice() as Attribute[];
	if (joinType === 'semi' || joinType === 'anti') return leftAttrs.slice() as Attribute[];

	const attributes: Attribute[] = [];
	for (const attr of leftAttrs) {
		const isNullable = joinType === 'right' || joinType === 'full';
		attributes.push(isNullable ? { ...attr, type: { ...attr.type, nullable: true } } : attr);
	}
	for (const attr of rightAttrs) {
		const isNullable = joinType === 'left' || joinType === 'full';
		attributes.push(isNullable ? { ...attr, type: { ...attr.type, nullable: true } } : attr);
	}
	return attributes;
}

/**
 * Build the `RelationType` for a join result.
 *
 * Semi/anti joins return the left type shape.  All other join types combine
 * columns from both sides with appropriate nullable marking.
 */
export function buildJoinRelationType(
	leftType: RelationType,
	rightType: RelationType,
	joinType: JoinType,
	keys?: ReadonlyArray<ReadonlyArray<ColRef>>,
): RelationType {
	if (joinType === 'semi' || joinType === 'anti') {
		return {
			typeClass: 'relation',
			columns: leftType.columns,
			isSet: leftType.isSet,
			isReadOnly: leftType.isReadOnly,
			keys: leftType.keys,
			rowConstraints: leftType.rowConstraints,
		};
	}

	const combinedColumns = [
		...leftType.columns.map(col => {
			const isNullable = joinType === 'right' || joinType === 'full';
			return isNullable ? { ...col, type: { ...col.type, nullable: true } } : col;
		}),
		...rightType.columns.map(col => {
			const isNullable = joinType === 'left' || joinType === 'full';
			return isNullable ? { ...col, type: { ...col.type, nullable: true } } : col;
		}),
	];

	const isSet = (joinType === 'inner' || joinType === 'cross') &&
		leftType.isSet && rightType.isSet;

	return {
		typeClass: 'relation',
		columns: combinedColumns,
		isSet,
		isReadOnly: leftType.isReadOnly && rightType.isReadOnly,
		keys: (keys ?? []) as ColRef[][],
		rowConstraints: [...leftType.rowConstraints, ...rightType.rowConstraints],
	};
}

/**
 * Estimate the number of output rows for a join given the input cardinalities.
 */
export function estimateJoinRows(
	leftRows: number | undefined,
	rightRows: number | undefined,
	joinType: JoinType,
): number | undefined {
	if (leftRows === undefined || rightRows === undefined) return undefined;

	switch (joinType) {
		case 'cross':
			return leftRows * rightRows;
		case 'inner':
			return Math.max(1, leftRows * rightRows * 0.1);
		case 'left':
			return leftRows;
		case 'right':
			return rightRows;
		case 'full':
			return leftRows + rightRows;
		case 'semi':
		case 'anti':
			return Math.max(1, Math.floor(leftRows * 0.5));
		default:
			return leftRows * rightRows * 0.1;
	}
}
