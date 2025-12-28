import { isRelationalNode, PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode, ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import { JoinCapable, type PredicateSourceCapable } from '../framework/characteristics.js';
import { normalizePredicate } from '../analysis/predicate-normalizer.js';
import { combineJoinKeys } from '../util/key-utils.js';
import { BinaryOpNode } from './scalar.js';
import { ColumnReferenceNode } from './reference.js';

export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross';

/**
 * Represents a logical JOIN operation between two relations.
 * This is a logical node that will be converted to physical join algorithms during optimization.
 */
export class JoinNode extends PlanNode implements BinaryRelationalNode, JoinCapable, PredicateSourceCapable {
	readonly nodeType = PlanNodeType.Join;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly left: RelationalPlanNode,
		public readonly right: RelationalPlanNode,
		public readonly joinType: JoinType,
		public readonly condition?: ScalarPlanNode,
		public readonly usingColumns?: readonly string[]
	) {
		// Cost estimate: base cost is sum of children plus join cost
		const leftCost = left.getTotalCost();
		const rightCost = right.getTotalCost();
		const leftRows = left.estimatedRows ?? 100;
		const rightRows = right.estimatedRows ?? 100;

		// Simple join cost heuristic - nested loop cost
		const joinCost = leftRows * rightRows;
		super(scope, leftCost + rightCost + joinCost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const leftPhys = childrenPhysical[0];
		const rightPhys = childrenPhysical[1];
		const leftType = this.left.getType();
		const rightType = this.right.getType();
		const leftAttrs = this.left.getAttributes();
		const rightAttrs = this.right.getAttributes();

		const leftIdToIndex = new Map<number, number>();
		leftAttrs.forEach((a, i) => leftIdToIndex.set(a.id, i));
		const rightIdToIndex = new Map<number, number>();
		rightAttrs.forEach((a, i) => rightIdToIndex.set(a.id, i));

		// Gather equi-join attribute index pairs from simple AND-of-equalities
		const pairs: Array<{ left: number; right: number }> = [];
		const cond = this.condition ? normalizePredicate(this.condition) : undefined;
		const stack: ScalarPlanNode[] = [];
		if (cond) stack.push(cond);
		while (stack.length) {
			const n = stack.pop()!;
			if (n instanceof BinaryOpNode) {
				const op = n.expression.operator;
				if (op === 'AND') {
					stack.push(n.left, n.right);
					continue;
				}
				if (op === '=') {
					if (n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode) {
						let lIdx = leftIdToIndex.get(n.left.attributeId);
						let rIdx = rightIdToIndex.get(n.right.attributeId);
						if (lIdx !== undefined && rIdx !== undefined) {
							pairs.push({ left: lIdx, right: rIdx });
						} else {
							// Try swapped alignment (right.col = left.col)
							lIdx = leftIdToIndex.get(n.right.attributeId);
							rIdx = rightIdToIndex.get(n.left.attributeId);
							if (lIdx !== undefined && rIdx !== undefined) {
								pairs.push({ left: lIdx, right: rIdx });
							}
						}
					}
				}
			}
		}

		// Check if a logical key (RelationType.keys) is fully covered by equi-join pairs
		function coversLogicalKey(side: 'left' | 'right'): boolean {
			const type = side === 'left' ? leftType : rightType;
			const eqSet = new Set<number>(pairs.map(p => side === 'left' ? p.left : p.right));
			return type.keys.some(key => key.length > 0 && key.every(ref => eqSet.has(ref.index)));
		}

		// Check if a physical unique key (childrenPhysical.uniqueKeys) is fully covered by equi-join pairs
		function coversPhysicalKey(side: 'left' | 'right'): boolean {
			const phys = side === 'left' ? leftPhys : rightPhys;
			if (!phys?.uniqueKeys) return false;
			const eqSet = new Set<number>(pairs.map(p => side === 'left' ? p.left : p.right));
			return phys.uniqueKeys.some(key => key.length > 0 && key.every(idx => eqSet.has(idx)));
		}

		const leftKeyCovered = coversLogicalKey('left') || coversPhysicalKey('left');
		const rightKeyCovered = coversLogicalKey('right') || coversPhysicalKey('right');

		let uniqueKeys: number[][] | undefined = undefined;
		if (this.joinType === 'inner' || this.joinType === 'cross') {
			const leftKeys = (leftPhys.uniqueKeys || []);
			const rightKeys = (rightPhys.uniqueKeys || []).map(k => k.map(i => i + leftType.columns.length));
			const preserved: number[][] = [];
			if (rightKeyCovered) preserved.push(...leftKeys);
			if (leftKeyCovered) preserved.push(...rightKeys);
			if (preserved.length > 0) uniqueKeys = preserved;
		}

		let estimatedRows: number | undefined = undefined;
		const lRows = this.left.estimatedRows;
		const rRows = this.right.estimatedRows;
		if (this.joinType === 'inner') {
			if (rightKeyCovered && typeof lRows === 'number') estimatedRows = lRows;
			if (leftKeyCovered && typeof rRows === 'number') estimatedRows = (estimatedRows === undefined) ? rRows : Math.min(estimatedRows, rRows);
		}

		return {
			uniqueKeys,
			estimatedRows,
		};
	}

	private buildAttributes(): Attribute[] {
		const leftAttrs = this.left.getAttributes();
		const rightAttrs = this.right.getAttributes();

		// For JOINs, concatenate left and right attributes
		// For OUTER joins, mark attributes from the nullable side as nullable
		const attributes: Attribute[] = [];

		// Add left attributes
		for (const attr of leftAttrs) {
			const isNullable = this.joinType === 'right' || this.joinType === 'full';
			attributes.push({
				...attr,
				// For right/full outer joins, left side can be null
				type: isNullable ? { ...attr.type, nullable: true } : attr.type
			});
		}

		// Add right attributes
		for (const attr of rightAttrs) {
			const isNullable = this.joinType === 'left' || this.joinType === 'full';
			attributes.push({
				...attr,
				// For left/full outer joins, right side can be null
				type: isNullable ? { ...attr.type, nullable: true } : attr.type
			});
		}

		return attributes;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		const leftType = this.left.getType();
		const rightType = this.right.getType();

		// Combine column types from both sides
		const leftColumns = leftType.columns;
		const rightColumns = rightType.columns;

		// For outer joins, mark columns as nullable appropriately
		const combinedColumns = [
			...leftColumns.map(col => {
				const isNullable = this.joinType === 'right' || this.joinType === 'full';
				return isNullable ? { ...col, type: { ...col.type, nullable: true } } : col;
			}),
			...rightColumns.map(col => {
				const isNullable = this.joinType === 'left' || this.joinType === 'full';
				return isNullable ? { ...col, type: { ...col.type, nullable: true } } : col;
			})
		];

		// Join result is a set only if both inputs are sets and it's an inner/cross join
		// Outer joins can introduce duplicates due to null padding
		const isSet = (this.joinType === 'inner' || this.joinType === 'cross') &&
			         leftType.isSet && rightType.isSet;

		// Combine keys conservatively
		const combinedKeys = combineJoinKeys(leftType.keys, rightType.keys, this.joinType, leftType.columns.length);

		// Combine row constraints from both sides
		const combinedRowConstraints = [...leftType.rowConstraints, ...rightType.rowConstraints];

		return {
			typeClass: 'relation',
			columns: combinedColumns,
			isSet,
			isReadOnly: leftType.isReadOnly && rightType.isReadOnly,
			keys: combinedKeys,
			rowConstraints: combinedRowConstraints
		};
	}

	getChildren(): readonly PlanNode[] {
		return this.condition ? [this.left, this.right, this.condition] : [this.left, this.right];
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.left, this.right];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.condition ? 3 : 2;
		if (newChildren.length !== expectedLength) {
			quereusError(`JoinNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight, newCondition] = newChildren;

		// Type check
		if (!isRelationalNode(newLeft)) {
			quereusError('JoinNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newRight)) {
			quereusError('JoinNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (newCondition && !('expression' in newCondition)) {
			quereusError('JoinNode: third child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		const leftChanged = newLeft !== this.left;
		const rightChanged = newRight !== this.right;
		const conditionChanged = newCondition !== this.condition;

		if (!leftChanged && !rightChanged && !conditionChanged) {
			return this;
		}

		// Create new instance - JoinNode creates new attributes by combining left and right
		return new JoinNode(
			this.scope,
			newLeft as RelationalPlanNode,
			newRight as RelationalPlanNode,
			this.joinType,
			newCondition as ScalarPlanNode | undefined,
			this.usingColumns
		);
	}

	get estimatedRows(): number | undefined {
		const leftRows = this.left.estimatedRows;
		const rightRows = this.right.estimatedRows;

		if (leftRows === undefined || rightRows === undefined) {
			return undefined;
		}

		// Simple heuristics for different join types
		switch (this.joinType) {
			case 'cross':
				return leftRows * rightRows;
			case 'inner':
				// Assume 10% selectivity for inner joins
				return Math.max(1, leftRows * rightRows * 0.1);
			case 'left':
				// Left joins preserve all left rows
				return leftRows;
			case 'right':
				// Right joins preserve all right rows
				return rightRows;
			case 'full':
				// Full outer joins can have at most left + right rows
				return leftRows + rightRows;
			default:
				return leftRows * rightRows * 0.1;
		}
	}

	override toString(): string {
		const joinTypeDisplay = this.joinType.toUpperCase();
		if (this.condition) {
			return `${joinTypeDisplay} JOIN ON condition`;
		} else if (this.usingColumns) {
			return `${joinTypeDisplay} JOIN USING(${this.usingColumns.join(', ')})`;
		} else {
			return `${joinTypeDisplay} JOIN`;
		}
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const attrs: Record<string, unknown> = {
			joinType: this.joinType,
			hasCondition: !!this.condition,
			usingColumns: this.usingColumns,
			leftRows: this.left.estimatedRows,
			rightRows: this.right.estimatedRows
		};
		// Expose unique keys computed by physical properties
		if (this.physical?.uniqueKeys) {
			attrs.uniqueKeys = this.physical.uniqueKeys;
		}
		return attrs;
	}

	public getJoinType(): JoinType {
		return this.joinType;
	}

	public getJoinCondition(): ScalarPlanNode | undefined {
		return this.condition;
	}

	public getLeftSource(): RelationalPlanNode {
		return this.left;
	}

	public getRightSource(): RelationalPlanNode {
		return this.right;
	}

	public getUsingColumns(): readonly string[] | undefined {
		return this.usingColumns;
	}

	// PredicateSourceCapable: Expose ON condition (if present) as a predicate source
	getPredicates(): readonly ScalarPlanNode[] {
		return this.condition ? [normalizePredicate(this.condition)] : [];
	}
}
