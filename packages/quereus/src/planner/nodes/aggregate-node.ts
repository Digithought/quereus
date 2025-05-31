import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { formatExpressionList } from '../../util/plan-formatter.js';

export interface AggregateExpression {
  expression: ScalarPlanNode;
  alias: string;
}

/**
 * Represents an aggregation operation.
 * It takes an input relation and applies aggregate functions,
 * optionally grouping by specified expressions.
 */
export class AggregateNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.Aggregate;
	override readonly physical: undefined = undefined;

  private outputTypeCache: Cached<RelationType>;
  private attributesCache: Cached<Attribute[]>;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly groupBy: readonly ScalarPlanNode[],
    public readonly aggregates: readonly AggregateExpression[],
    estimatedCostOverride?: number
  ) {
    super(scope, estimatedCostOverride ?? source.getTotalCost());

    this.outputTypeCache = new Cached(() => this.buildOutputType());
    this.attributesCache = new Cached(() => this.buildAttributes());
  }

  private buildOutputType(): RelationType {
    // Build the output relation type based on group by columns and aggregates
    const columns = [
      // Group by columns come first
      ...this.groupBy.map((expr, index) => ({
        name: `group_${index}`,
        type: expr.getType(),
        generated: false
      })),
      // Then aggregate columns
      ...this.aggregates.map(agg => ({
        name: agg.alias,
        type: agg.expression.getType(),
        generated: true
      }))
    ];

    // Determine if result is a set
    // - Without GROUP BY: always produces exactly 1 row, so it's a set
    // - With GROUP BY: produces one row per unique group, so it's a set
    const isSet = true;

    return {
      typeClass: 'relation',
      columns,
      keys: [], // No keys for aggregate results
      rowConstraints: [], // No row constraints for aggregate results
      isReadOnly: true,
      isSet
    };
  }

  private buildAttributes(): Attribute[] {
    const attributes: Attribute[] = [];

    // Group by columns come first
    this.groupBy.forEach((expr, index) => {
      attributes.push({
        id: PlanNode.nextAttrId(),
        name: `group_${index}`,
        type: expr.getType(),
        sourceRelation: `${this.nodeType}:${this.id}`
      });
    });

    // Then aggregate columns
    this.aggregates.forEach((agg) => {
      attributes.push({
        id: PlanNode.nextAttrId(),
        name: agg.alias,
        type: agg.expression.getType(),
        sourceRelation: `${this.nodeType}:${this.id}`
      });
    });

    return attributes;
  }

  getType(): RelationType {
    return this.outputTypeCache.value;
  }

  getAttributes(): Attribute[] {
    return this.attributesCache.value;
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
    const parts: string[] = [];

    if (this.groupBy.length > 0) {
      parts.push(`GROUP BY ${formatExpressionList(this.groupBy)}`);
    }

    if (this.aggregates.length > 0) {
      const aggregatesStr = this.aggregates.map(agg =>
        `${agg.expression.toString()} AS ${agg.alias}`
      ).join(', ');
      parts.push(`AGG ${aggregatesStr}`);
    }

    return parts.join('  ');
  }

  override getLogicalProperties(): Record<string, unknown> {
    const props: Record<string, unknown> = {};

    if (this.groupBy.length > 0) {
      props.groupBy = this.groupBy.map(expr => expr.toString());
    }

    if (this.aggregates.length > 0) {
      props.aggregates = this.aggregates.map(agg => ({
        expression: agg.expression.toString(),
        alias: agg.alias
      }));
    }

    return props;
  }
}
