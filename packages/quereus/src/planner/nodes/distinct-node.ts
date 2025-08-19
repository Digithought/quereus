import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, isRelationalNode, type PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

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
      isSet: true
    };
  }

  getAttributes(): readonly Attribute[] {
    // DISTINCT preserves the same attributes as its source
    return this.source.getAttributes();
  }

  getChildren(): readonly [RelationalPlanNode] {
    return [this.source];
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

  override getLogicalAttributes(): Record<string, unknown> {
    const colCount = this.source.getAttributes().length;
    const allColsKey = [Array.from({ length: colCount }, (_, i) => i)];
    return {
      uniqueKeys: allColsKey
    };
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    const sourcePhysical = childrenPhysical[0];
    const colCount = this.source.getAttributes().length;
    const allColsKey = [Array.from({ length: colCount }, (_, i) => i)];
    return {
      uniqueKeys: allColsKey,
      estimatedRows: this.estimatedRows,
      ordering: sourcePhysical?.ordering,
    };
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 1) {
      quereusError(`DistinctNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
    }

    const [newSource] = newChildren;

    // Type check
    if (!isRelationalNode(newSource)) {
      quereusError('DistinctNode: child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }

    // Return same instance if nothing changed
    if (newSource === this.source) {
      return this;
    }

    // Create new instance preserving attributes (distinct preserves source attributes)
    return new DistinctNode(
      this.scope,
      newSource as RelationalPlanNode
    );
  }
}
