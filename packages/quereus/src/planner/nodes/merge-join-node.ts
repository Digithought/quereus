import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type BinaryRelationalNode, type ScalarPlanNode, type PhysicalProperties, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import type { JoinCapable, PredicateSourceCapable } from '../framework/characteristics.js';
import { mergeJoinCost } from '../cost/index.js';
import type { JoinType } from './join-node.js';
import type { EquiJoinPair } from './bloom-join-node.js';

/**
 * Physical plan node implementing a merge join.
 *
 * Requires both inputs sorted on the equi-join columns. Performs a single
 * linear pass over both sides, collecting "runs" of equal keys and producing
 * the cross-product of matching runs.
 *
 * Cost: O(n + m) when inputs are already sorted; O(n log n + m log m) otherwise
 * (sort costs handled by upstream SortNodes inserted by the optimizer).
 */
export class MergeJoinNode extends PlanNode implements BinaryRelationalNode, JoinCapable, PredicateSourceCapable {
	override readonly nodeType = PlanNodeType.MergeJoin;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		/** Left side (sorted on join keys) */
		public readonly left: RelationalPlanNode,
		/** Right side (sorted on join keys) */
		public readonly right: RelationalPlanNode,
		public readonly joinType: JoinType,
		/** Pre-extracted equi-join pairs (left.col = right.col) */
		public readonly equiPairs: readonly EquiJoinPair[],
		/** Non-equi remainder of the ON condition, if any */
		public readonly residualCondition?: ScalarPlanNode,
		/** Preserved attribute IDs from the logical JoinNode */
		public readonly preserveAttributeIds?: readonly Attribute[],
	) {
		const leftRows = left.estimatedRows ?? 100;
		const rightRows = right.estimatedRows ?? 100;
		// Merge cost only (no sort cost here — SortNodes are inserted upstream if needed)
		const cost = left.getTotalCost() + right.getTotalCost() + mergeJoinCost(leftRows, rightRows, false, false);
		super(scope, cost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	private buildAttributes(): Attribute[] {
		if (this.preserveAttributeIds) {
			return this.preserveAttributeIds.slice() as Attribute[];
		}

		const leftAttrs = this.left.getAttributes();

		// Semi/anti joins produce only left-side attributes
		if (this.joinType === 'semi' || this.joinType === 'anti') {
			return leftAttrs.slice() as Attribute[];
		}

		// Combine left + right attributes
		const rightAttrs = this.right.getAttributes();
		const attributes: Attribute[] = [];

		for (const attr of leftAttrs) {
			const isNullable = this.joinType === 'right' || this.joinType === 'full';
			attributes.push(isNullable ? { ...attr, type: { ...attr.type, nullable: true } } : attr);
		}
		for (const attr of rightAttrs) {
			const isNullable = this.joinType === 'left' || this.joinType === 'full';
			attributes.push(isNullable ? { ...attr, type: { ...attr.type, nullable: true } } : attr);
		}

		return attributes;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		const leftType = this.left.getType();

		// Semi/anti joins produce only left-side columns
		if (this.joinType === 'semi' || this.joinType === 'anti') {
			return {
				typeClass: 'relation',
				columns: leftType.columns,
				isSet: leftType.isSet,
				isReadOnly: leftType.isReadOnly,
				keys: leftType.keys,
				rowConstraints: leftType.rowConstraints
			};
		}

		const rightType = this.right.getType();

		const combinedColumns = [
			...leftType.columns.map(col => {
				const isNullable = this.joinType === 'right' || this.joinType === 'full';
				return isNullable ? { ...col, type: { ...col.type, nullable: true } } : col;
			}),
			...rightType.columns.map(col => {
				const isNullable = this.joinType === 'left' || this.joinType === 'full';
				return isNullable ? { ...col, type: { ...col.type, nullable: true } } : col;
			})
		];

		const isSet = (this.joinType === 'inner' || this.joinType === 'cross') &&
			leftType.isSet && rightType.isSet;

		return {
			typeClass: 'relation',
			columns: combinedColumns,
			isSet,
			isReadOnly: leftType.isReadOnly && rightType.isReadOnly,
			keys: [],
			rowConstraints: [...leftType.rowConstraints, ...rightType.rowConstraints]
		};
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const leftPhys = childrenPhysical[0];
		const rightPhys = childrenPhysical[1];

		// Semi/anti joins preserve left-side unique keys
		if (this.joinType === 'semi' || this.joinType === 'anti') {
			return {
				// Merge join preserves left-side ordering
				ordering: leftPhys.ordering,
				uniqueKeys: leftPhys.uniqueKeys,
			};
		}

		// Merge join preserves the left-side ordering (both sides are sorted on
		// equi-join keys, and the output follows the left side's sort order)
		let ordering = leftPhys.ordering;

		// Unique keys: same logic as BloomJoinNode
		let uniqueKeys: number[][] | undefined = undefined;
		if (this.joinType === 'inner') {
			const leftAttrs = this.left.getAttributes();
			const rightAttrs = this.right.getAttributes();

			const leftEqSet = new Set(this.equiPairs.map(p => leftAttrs.findIndex(a => a.id === p.leftAttrId)));
			const rightEqSet = new Set(this.equiPairs.map(p => rightAttrs.findIndex(a => a.id === p.rightAttrId)));

			const leftKeyCovered = leftPhys.uniqueKeys?.some(key => key.length > 0 && key.every(idx => leftEqSet.has(idx))) ?? false;
			const rightKeyCovered = rightPhys.uniqueKeys?.some(key => key.length > 0 && key.every(idx => rightEqSet.has(idx))) ?? false;

			const leftKeys = leftPhys.uniqueKeys || [];
			const rightKeys = (rightPhys.uniqueKeys || []).map(k => k.map(i => i + leftAttrs.length));
			const preserved: number[][] = [];
			if (rightKeyCovered) preserved.push(...leftKeys);
			if (leftKeyCovered) preserved.push(...rightKeys);
			if (preserved.length > 0) uniqueKeys = preserved;
		}

		return { ordering, uniqueKeys };
	}

	get estimatedRows(): number | undefined {
		const leftRows = this.left.estimatedRows;
		const rightRows = this.right.estimatedRows;
		if (leftRows === undefined || rightRows === undefined) return undefined;

		switch (this.joinType) {
			case 'cross':
				return leftRows * rightRows;
			case 'inner':
				return Math.max(1, leftRows * rightRows * 0.1);
			case 'left':
				return leftRows;
			case 'semi':
			case 'anti':
				return Math.max(1, Math.floor(leftRows * 0.5));
			default:
				return leftRows * rightRows * 0.1;
		}
	}

	getChildren(): readonly PlanNode[] {
		const children: PlanNode[] = [this.left, this.right];
		if (this.residualCondition) children.push(this.residualCondition);
		return children;
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.left, this.right];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.residualCondition ? 3 : 2;
		if (newChildren.length !== expectedLength) {
			quereusError(`MergeJoinNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight, newResidual] = newChildren;

		if (!isRelationalNode(newLeft)) {
			quereusError('MergeJoinNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newRight)) {
			quereusError('MergeJoinNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		if (newLeft === this.left && newRight === this.right &&
			(!this.residualCondition || newResidual === this.residualCondition)) {
			return this;
		}

		return new MergeJoinNode(
			this.scope,
			newLeft as RelationalPlanNode,
			newRight as RelationalPlanNode,
			this.joinType,
			this.equiPairs,
			newResidual as ScalarPlanNode | undefined,
			this.preserveAttributeIds
		);
	}

	// JoinCapable interface
	getJoinType(): JoinType { return this.joinType; }
	getJoinCondition(): ScalarPlanNode | undefined { return this.residualCondition; }
	getLeftSource(): RelationalPlanNode { return this.left; }
	getRightSource(): RelationalPlanNode { return this.right; }
	getUsingColumns(): readonly string[] | undefined { return undefined; }

	// PredicateSourceCapable
	getPredicates(): readonly ScalarPlanNode[] {
		return this.residualCondition ? [this.residualCondition] : [];
	}

	override toString(): string {
		const pairs = this.equiPairs.map(p => `${p.leftAttrId}=${p.rightAttrId}`).join(', ');
		return `${this.joinType.toUpperCase()} MERGE JOIN on [${pairs}]`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const attrs: Record<string, unknown> = {
			joinType: this.joinType,
			algorithm: 'merge',
			equiPairs: this.equiPairs.map(p => ({ left: p.leftAttrId, right: p.rightAttrId })),
			hasResidual: !!this.residualCondition,
			leftRows: this.left.estimatedRows,
			rightRows: this.right.estimatedRows,
		};
		if (this.physical?.uniqueKeys) {
			attrs.uniqueKeys = this.physical.uniqueKeys;
		}
		return attrs;
	}
}
