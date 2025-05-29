import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Physical node representing a streaming aggregate operation.
 * Requires input to be ordered by grouping columns.
 */
export class StreamAggregateNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.StreamAggregate;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly groupBy: ScalarPlanNode[],
    public readonly aggregates: { expression: ScalarPlanNode; alias: string }[],
    estimatedCostOverride?: number
  ) {
    // Streaming aggregation is cheaper than hash aggregation
    // Cost is linear in the number of input rows
    const sourceRows = source.estimatedRows ?? 1000;
    const streamingCost = sourceRows * 0.1; // Lower cost multiplier for streaming

    super(scope, estimatedCostOverride ?? (source.getTotalCost() + streamingCost));
  }

  getType(): RelationType {
    // Helper function to extract a meaningful name from a GROUP BY expression
    const getGroupByColumnName = (expr: ScalarPlanNode, index: number): string => {
      // If it's a column reference, use the column name
      if (expr.nodeType === PlanNodeType.ColumnReference) {
        const colRef = expr as any; // ColumnReferenceNode
        return colRef.expression.name;
      }
      // Otherwise, use a generic name
      return `group_${index}`;
    };

    // Same output type as logical aggregate
    const columns = [
      // Group by columns come first
      ...this.groupBy.map((expr, index) => ({
        name: getGroupByColumnName(expr, index),
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
      rowConstraints: [],
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

    if (this.groupBy.length > 0) {
      // For streaming aggregate, we assume groups are somewhat clustered
      // so we estimate fewer groups than hash aggregate would
      return Math.max(1, Math.floor(sourceRows / 10));
    } else {
      // No GROUP BY means single output row
      return 1;
    }
  }

  getPhysical(childrenPhysical: PhysicalProperties[]): PhysicalProperties {
    const sourcePhysical = childrenPhysical[0]; // Source is first relation

    return {
      estimatedRows: this.estimatedRows,
      // Stream aggregate preserves ordering on GROUP BY columns
      ordering: this.groupBy.length > 0 ?
        this.groupBy.map((_, idx) => ({ column: idx, desc: false })) :
        undefined,
      // Aggregation creates unique keys on GROUP BY columns
      uniqueKeys: this.groupBy.length > 0 ?
        [this.groupBy.map((_, idx) => idx)] :
        [[]], // Single row if no GROUP BY
      readonly: true,
      deterministic: sourcePhysical?.deterministic ?? true,
      constant: this.groupBy.length === 0 && (sourcePhysical?.constant ?? false)
    };
  }

  override toString(): string {
    const groupByStr = this.groupBy.length > 0 ? ` GROUP BY ${this.groupBy.length} cols` : '';
    const aggregatesStr = `${this.aggregates.length} aggs`;
    return `${super.toString()} (${aggregatesStr}${groupByStr})`;
  }
}
