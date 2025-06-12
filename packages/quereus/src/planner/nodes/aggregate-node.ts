import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { formatExpressionList } from '../../util/plan-formatter.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';

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
    estimatedCostOverride?: number,
    public readonly preserveAttributeIds?: readonly Attribute[]
  ) {
    super(scope, estimatedCostOverride ?? source.getTotalCost());

    this.outputTypeCache = new Cached(() => this.buildOutputType());
    this.attributesCache = new Cached(() => this.buildAttributes());
  }

  // Helper function to extract a meaningful name from a GROUP BY expression
  private getGroupByColumnName(expr: ScalarPlanNode, index: number): string {
    // If it's a column reference, use the column name
    if (expr.nodeType === PlanNodeType.ColumnReference) {
      const colRef = expr as any; // ColumnReferenceNode
      return colRef.expression.name;
    }
    // Otherwise, use a generic name
    return `group_${index}`;
  }

  private buildOutputType(): RelationType {
    // Build the output relation type based on group by columns and aggregates
    const columns = [
      // Group by columns come first
      ...this.groupBy.map((expr, index) => ({
        name: this.getGroupByColumnName(expr, index),
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
    // If we have preserved attribute IDs, use them
    if (this.preserveAttributeIds) {
      return this.preserveAttributeIds.slice(); // Return a copy
    }

    const attributes: Attribute[] = [];

    // Group by columns come first
    this.groupBy.forEach((expr, index) => {
      const name = this.getGroupByColumnName(expr, index);
      attributes.push({
        id: PlanNode.nextAttrId(),
        name,
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

  getChildren(): readonly PlanNode[] {
    return [this.source, ...this.groupBy, ...this.aggregates.map(agg => agg.expression)];
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const expectedLength = 1 + this.groupBy.length + this.aggregates.length;
    if (newChildren.length !== expectedLength) {
      quereusError(`AggregateNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
    }

    const [newSource, ...restChildren] = newChildren;
    const newGroupBy = restChildren.slice(0, this.groupBy.length);
    const newAggregateExpressions = restChildren.slice(this.groupBy.length);

    // Type check
    if (!('getAttributes' in newSource) || typeof (newSource as any).getAttributes !== 'function') {
      quereusError('AggregateNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }

    // Check if anything changed
    const sourceChanged = newSource !== this.source;
    const groupByChanged = newGroupBy.some((expr, i) => expr !== this.groupBy[i]);
    const aggregatesChanged = newAggregateExpressions.some((expr, i) => expr !== this.aggregates[i].expression);

    if (!sourceChanged && !groupByChanged && !aggregatesChanged) {
      return this;
    }

    // Build new aggregates array
    const newAggregates = newAggregateExpressions.map((expr, i) => ({
      expression: expr as ScalarPlanNode,
      alias: this.aggregates[i].alias
    }));

    // Create new instance that preserves original attribute IDs
    return new AggregateNode(
      this.scope,
      newSource as RelationalPlanNode,
      newGroupBy as ScalarPlanNode[],
      newAggregates,
      undefined, // estimatedCostOverride
      this.getAttributes() // Preserve original attribute IDs
    );
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
