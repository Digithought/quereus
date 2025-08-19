import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type Attribute, isRelationalNode, isScalarNode, type PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { formatExpression } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { PredicateCapable, type PredicateSourceCapable } from '../framework/characteristics.js';

/**
 * Represents a filter operation (WHERE clause).
 * It takes an input relation and a predicate expression,
 * and outputs rows for which the predicate is true.
 */
export class FilterNode extends PlanNode implements UnaryRelationalNode, PredicateCapable, PredicateSourceCapable {
	override readonly nodeType = PlanNodeType.Filter;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly predicate: ScalarPlanNode,
		estimatedCostOverride?: number
	) {
		// Cost: cost of source + cost of evaluating predicate for each source row
		super(scope, estimatedCostOverride ?? (source.getTotalCost() + (source.estimatedRows ?? 1) * predicate.getTotalCost()));
	}

	getType(): RelationType {
		// Filter preserves the type of the source relation
		return this.source.getType();
	}

	getAttributes(): readonly Attribute[] {
		// Filter preserves the same attributes as its source
		return this.source.getAttributes();
	}

	getChildren(): readonly [RelationalPlanNode, ScalarPlanNode] {
		return [this.source, this.predicate];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		// This is a rough estimate. A more sophisticated planner would use selectivity estimates.
		// For now, assume a selectivity of 0.5 if source has rows, otherwise 0.
		// TODO: Use selectivity estimates
		const sourceRows = this.source.estimatedRows;
		if (sourceRows === undefined) return undefined;
		return sourceRows > 0 ? Math.max(1, Math.floor(sourceRows * 0.5)) : 0;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		const srcRows = sourcePhysical?.estimatedRows;
		const est = this.estimatedRows;
		const rows = (typeof srcRows === 'number' && typeof est === 'number')
			? Math.min(srcRows, est)
			: (srcRows ?? est);

		return {
			estimatedRows: rows,
			ordering: sourcePhysical?.ordering,
			uniqueKeys: sourcePhysical?.uniqueKeys,
		};
	}

	override toString(): string {
		return `WHERE ${formatExpression(this.predicate)}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			predicate: formatExpression(this.predicate)
		};
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 2) {
			quereusError(`FilterNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource, newPredicate] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			quereusError('FilterNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isScalarNode(newPredicate)) {
			quereusError('FilterNode: second child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newSource === this.source && newPredicate === this.predicate) {
			return this;
		}

		// Create new instance preserving attributes (filter preserves source attributes)
		return new FilterNode(
			this.scope,
			newSource as RelationalPlanNode,
			newPredicate as ScalarPlanNode
		);
	}

	// PredicateCapable interface implementation
	getPredicate(): ScalarPlanNode | null {
		return this.predicate;
	}

	withPredicate(newPredicate: ScalarPlanNode | null): PlanNode {
		if (newPredicate === null) {
			// If predicate is null, return the source directly (no filter needed)
			return this.source;
		}

		if (newPredicate === this.predicate) {
			return this;
		}

		return new FilterNode(this.scope, this.source, newPredicate);
	}

  // PredicateSourceCapable interface implementation
  getPredicates(): readonly ScalarPlanNode[] {
    return [this.predicate];
  }
}
