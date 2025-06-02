import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Represents a DISTINCT operation that eliminates duplicate rows.
 * It takes an input relation and outputs unique rows.
 */
export class DistinctNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.Distinct;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    estimatedCostOverride?: number
  ) {
    // Cost: cost of source + cost of deduplication (roughly O(n log n) for sorting approach)
    const sourceCost = source.getTotalCost();
    const sourceRows = source.estimatedRows ?? 1;
    const deduplicationCost = sourceRows * Math.log2(Math.max(1, sourceRows));
    super(scope, estimatedCostOverride ?? (sourceCost + deduplicationCost));
  }

  getType(): RelationType {
    // DISTINCT always produces a set (no duplicates)
    const sourceType = this.source.getType();
    return {
      ...sourceType,
      isSet: true // DISTINCT guarantees uniqueness
    };
  }

  getAttributes(): Attribute[] {
    // DISTINCT preserves the same attributes as its source
    return this.source.getAttributes();
  }

  getChildren(): readonly [] {
    return [];
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  get estimatedRows(): number | undefined {
    // DISTINCT reduces the number of rows by eliminating duplicates
    // This is a rough estimate - in reality it depends on data distribution
    const sourceRows = this.source.estimatedRows;
    if (sourceRows === undefined) return undefined;
    if (sourceRows <= 1) return sourceRows;

    // Rough heuristic: assume some duplicates exist
    // More sophisticated planners would use column statistics
    return Math.max(1, Math.floor(sourceRows * 0.7));
  }

  override toString(): string {
    return 'DISTINCT';
  }

  override getLogicalProperties(): Record<string, unknown> {
    return { };
  }
}
