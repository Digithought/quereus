import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type BinaryRelationalNode, type ScalarPlanNode, type PhysicalProperties, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import type { JoinCapable, PredicateSourceCapable } from '../framework/characteristics.js';
import { hashJoinCost } from '../cost/index.js';
import type { JoinType } from './join-node.js';

/**
 * An equi-join pair: left attribute = right attribute.
 * Attribute IDs are stable across plan transformations.
 */
export interface EquiJoinPair {
	leftAttrId: number;
	rightAttrId: number;
}

/**
 * Physical plan node implementing a hash (bloom) join.
 *
 * Build phase: materializes the smaller (right) side into a Map keyed by
 * serialized equi-join column values.
 * Probe phase: streams the larger (left) side, probing the map for matches.
 *
 * Reduces O(n*m) nested-loop to O(n+m) for equi-joins.
 */
export class BloomJoinNode extends PlanNode implements BinaryRelationalNode, JoinCapable, PredicateSourceCapable {
	override readonly nodeType = PlanNodeType.HashJoin;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		/** Probe side (streamed) */
		public readonly left: RelationalPlanNode,
		/** Build side (materialized into hash map) */
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
		const cost = left.getTotalCost() + right.getTotalCost() + hashJoinCost(rightRows, leftRows);
		super(scope, cost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	private buildAttributes(): Attribute[] {
		if (this.preserveAttributeIds) {
			return this.preserveAttributeIds.slice() as Attribute[];
		}

		// Fallback: combine left + right attributes (should rarely happen)
		const leftAttrs = this.left.getAttributes();
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
			keys: [], // Conservative: don't infer keys for hash join
			rowConstraints: [...leftType.rowConstraints, ...rightType.rowConstraints]
		};
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const leftPhys = childrenPhysical[0];
		const rightPhys = childrenPhysical[1];

		// Hash join does not preserve ordering
		// Unique keys: if equi-pairs cover a unique key on one side,
		// the other side's keys are preserved (same logic as JoinNode)
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

		return { uniqueKeys };
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
			quereusError(`BloomJoinNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight, newResidual] = newChildren;

		if (!isRelationalNode(newLeft)) {
			quereusError('BloomJoinNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newRight)) {
			quereusError('BloomJoinNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		if (newLeft === this.left && newRight === this.right &&
			(!this.residualCondition || newResidual === this.residualCondition)) {
			return this;
		}

		return new BloomJoinNode(
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
		return `${this.joinType.toUpperCase()} HASH JOIN on [${pairs}]`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const attrs: Record<string, unknown> = {
			joinType: this.joinType,
			algorithm: 'bloom',
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
