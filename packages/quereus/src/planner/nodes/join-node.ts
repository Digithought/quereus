import { PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode, ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { SqlDataType } from '../../common/types.js';

export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross';

/**
 * Represents a logical JOIN operation between two relations.
 * This is a logical node that will be converted to physical join algorithms during optimization.
 */
export class JoinNode extends PlanNode implements BinaryRelationalNode {
	readonly nodeType = PlanNodeType.Join;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly left: RelationalPlanNode,
		public readonly right: RelationalPlanNode,
		public readonly joinType: JoinType,
		public readonly condition?: ScalarPlanNode,
		public readonly usingColumns?: string[]
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

		// Combine keys from both sides - for joins this gets complex but we'll keep it simple for now
		const combinedKeys = [...leftType.keys, ...rightType.keys];

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

	getChildren(): readonly [ScalarPlanNode] | readonly [] {
		return this.condition ? [this.condition] : [];
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.left, this.right];
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

	override getLogicalProperties(): Record<string, unknown> {
		return {
			joinType: this.joinType,
			hasCondition: !!this.condition,
			usingColumns: this.usingColumns,
			leftRows: this.left.estimatedRows,
			rightRows: this.right.estimatedRows
		};
	}
}
