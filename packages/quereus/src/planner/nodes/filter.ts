import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { formatExpression } from '../../util/plan-formatter.js';

/**
 * Represents a filter operation (WHERE clause).
 * It takes an input relation and a predicate expression,
 * and outputs rows for which the predicate is true.
 */
export class FilterNode extends PlanNode implements UnaryRelationalNode {
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

  getAttributes(): Attribute[] {
    // Filter preserves the same attributes as its source
    return this.source.getAttributes();
  }

  getChildren(): readonly [ScalarPlanNode] {
    return [this.predicate];
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

  override toString(): string {
    return `WHERE ${formatExpression(this.predicate)}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    return {
      predicate: formatExpression(this.predicate)
    };
  }
}
