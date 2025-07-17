import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type PhysicalProperties, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { formatSortKey } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { extractOrderingFromSortKeys } from '../framework/physical-utils.js';
import { SortCapable } from '../framework/characteristics.js';

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
export class SortNode extends PlanNode implements UnaryRelationalNode, SortCapable {
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

	getChildren(): readonly PlanNode[] {
		// Return source first, then all sort key expressions
		return [this.source, ...this.sortKeys.map(key => key.expression)];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		// Sort doesn't change the number of rows
		return this.source.estimatedRows;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0]; // Source is first relation
		const sourceAttributes = this.source.getAttributes();

		// Extract ordering from sort keys if they are trivial column references
		const ordering = extractOrderingFromSortKeys(this.sortKeys, sourceAttributes);

		return {
			estimatedRows: this.estimatedRows,
			// Only set ordering if we can extract it from trivial column references
			ordering,
			// Preserve unique keys from source
			uniqueKeys: sourcePhysical?.uniqueKeys,
		};
	}

	override toString(): string {
		const keyDescriptions = this.sortKeys.map(key =>
			formatSortKey(key.expression, key.direction, key.nulls)
		).join(', ');
		return `ORDER BY ${keyDescriptions}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			sortKeys: this.sortKeys.map(key => ({
				expression: key.expression.toString(),
				direction: key.direction,
				nulls: key.nulls
			}))
		};
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1 + this.sortKeys.length) {
			quereusError(`SortNode expects ${1 + this.sortKeys.length} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource, ...newSortExpressions] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			quereusError('SortNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		const sourceChanged = newSource !== this.source;
		const sortExpressionsChanged = newSortExpressions.some((expr, i) => expr !== this.sortKeys[i].expression);

		if (!sourceChanged && !sortExpressionsChanged) {
			return this;
		}

		// Build new sort keys array
		const newSortKeys = newSortExpressions.map((expr, i) => ({
			expression: expr as ScalarPlanNode,
			direction: this.sortKeys[i].direction,
			nulls: this.sortKeys[i].nulls
		}));

		// Create new instance preserving attributes (sort preserves source attributes)
		return new SortNode(
			this.scope,
			newSource as RelationalPlanNode,
			newSortKeys
		);
	}

	// SortCapable interface implementation
	getSortKeys(): readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc' }[] {
		return this.sortKeys.map(key => ({
			expression: key.expression,
			direction: key.direction
		}));
	}

	withSortKeys(keys: readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc' }[]): PlanNode {
		// Convert to internal SortKey format with nulls handling
		const newSortKeys = keys.map(key => ({
			expression: key.expression,
			direction: key.direction,
			nulls: undefined as 'first' | 'last' | undefined
		}));

		// Check if anything changed
		const changed = newSortKeys.length !== this.sortKeys.length ||
			newSortKeys.some((key, i) =>
				key.expression !== this.sortKeys[i].expression ||
				key.direction !== this.sortKeys[i].direction
			);

		if (!changed) {
			return this;
		}

		return new SortNode(this.scope, this.source, newSortKeys);
	}
}
