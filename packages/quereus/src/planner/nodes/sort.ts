import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type PhysicalProperties, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Represents a sort key for ordering results
 */
export interface SortKey {
	/** The expression to sort by */
	expression: ScalarPlanNode;
	/** Sort direction */
	direction: 'asc' | 'desc';
	/** How to handle nulls */
	nulls?: 'first' | 'last';
}

/**
 * Represents a sort operation (ORDER BY clause).
 * It takes an input relation and sort keys,
 * and outputs rows sorted according to the keys.
 * This is a physical operation that materializes and sorts rows.
 */
export class SortNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Sort;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly sortKeys: readonly SortKey[],
		estimatedCostOverride?: number
	) {
		// Cost: cost of source + cost of sorting (O(n log n) * cost of evaluating sort expressions)
		// This is a simplified cost model - a more sophisticated one would consider the actual data size
		const sourceRows = source.estimatedRows ?? 1000;
		const sortCost = sourceRows * Math.log2(sourceRows + 1);
		const keyCost = sortKeys.reduce((sum, key) => sum + key.expression.getTotalCost(), 0);

		super(scope, estimatedCostOverride ?? (source.getTotalCost() + sortCost * keyCost));
	}

	getType(): RelationType {
		// Sort preserves the type of the source relation
		return this.source.getType();
	}

	getAttributes(): Attribute[] {
		// Sort preserves the same attributes as its source
		return this.source.getAttributes();
	}

	getChildren(): readonly ScalarPlanNode[] {
		// Return all sort key expressions as children
		return this.sortKeys.map(key => key.expression);
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		// Sort doesn't change the number of rows
		return this.source.estimatedRows;
	}

	getPhysical(childrenPhysical: PhysicalProperties[]): PhysicalProperties {
		const sourcePhysical = childrenPhysical[0]; // Source is first relation

		return {
			estimatedRows: this.estimatedRows,
			// Sort establishes ordering based on sort keys
			ordering: this.sortKeys.map((key, idx) => ({
				column: idx, // This would need to map to actual column indices
				desc: key.direction === 'desc'
			})),
			// Preserve unique keys from source
			uniqueKeys: sourcePhysical?.uniqueKeys,
			readonly: sourcePhysical?.readonly ?? true,
			deterministic: sourcePhysical?.deterministic ?? true,
			constant: sourcePhysical?.constant ?? false
		};
	}

	override toString(): string {
		const keyDescriptions = this.sortKeys.map(key =>
			`${key.expression.toString()} ${key.direction.toUpperCase()}${key.nulls ? ` NULLS ${key.nulls.toUpperCase()}` : ''}`
		).join(', ');
		return `${this.nodeType} (${keyDescriptions}) ON (${this.source.toString()})`;
	}
}
