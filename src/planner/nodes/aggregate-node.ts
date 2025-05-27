import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Represents an aggregation operation.
 * It takes an input relation and applies aggregate functions,
 * optionally grouping by specified expressions.
 */
export class AggregateNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.Aggregate;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly groupBy: ScalarPlanNode[],
    public readonly aggregates: { expression: ScalarPlanNode; alias: string }[],
    estimatedCostOverride?: number
  ) {
    super(scope, estimatedCostOverride ?? source.getTotalCost());
  }

  getType(): RelationType {
    // Build the output relation type based on group by columns and aggregates
    const columns = [
      // Group by columns come first
      ...this.groupBy.map((expr, index) => ({
        name: `group_${index}`,
        type: expr.getType(),
        isReadOnly: true
      })),
      // Then aggregate columns
      ...this.aggregates.map(agg => ({
        name: agg.alias,
        type: agg.expression.getType(),
        isReadOnly: true
      }))
    ];

    return {
      typeClass: 'relation',
      columns,
      keys: [], // No keys for aggregate results
      rowConstraints: [], // No row constraints for aggregate results
      isReadOnly: true
    };
  }

  getChildren(): readonly ScalarPlanNode[] {
    return [...this.groupBy, ...this.aggregates.map(agg => agg.expression)];
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  get estimatedRows(): number | undefined {
    const sourceRows = this.source.estimatedRows;
    if (sourceRows === undefined) return undefined;

    // If we have GROUP BY, the output rows depend on the number of distinct groups
    // For now, we'll use a conservative estimate
    if (this.groupBy.length > 0) {
      // Estimate that we'll have at most sourceRows/2 groups, but at least 1
      return Math.max(1, Math.floor(sourceRows / 2));
    } else {
      // No GROUP BY means we're aggregating the entire table into a single row
      return 1;
    }
  }

  override toString(): string {
    const groupByStr = this.groupBy.length > 0 ? ` GROUP BY ${this.groupBy.map(g => g.toString()).join(', ')}` : '';
    const aggregatesStr = this.aggregates.map(agg => `${agg.expression.toString()} AS ${agg.alias}`).join(', ');
    return `${super.toString()} (${aggregatesStr})${groupByStr}`;
  }
}
