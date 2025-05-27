import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Represents a LIMIT/OFFSET operation.
 * It takes an input relation and limits the number of rows returned,
 * optionally skipping a number of rows (OFFSET).
 */
export class LimitOffsetNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.LimitOffset;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly limit: ScalarPlanNode,	// Null if not given
    public readonly offset: ScalarPlanNode,	// Null if not given
    estimatedCostOverride?: number
  ) {
    super(scope, estimatedCostOverride ?? source.getTotalCost());
  }

  getType(): RelationType {
    // LimitOffset preserves the type of the source relation
    return this.source.getType();
  }

  getChildren(): readonly ScalarPlanNode[] {
    return [this.limit, this.offset];
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  get estimatedRows(): number | undefined {
    const sourceRows = this.source.estimatedRows;
    if (sourceRows === undefined) return undefined;

    // If we have a limit, the output rows will be at most the limit
    // For now, we'll assume limit is a literal value for estimation purposes
    // TODO: Handle dynamic limit expressions
    return sourceRows; // Conservative estimate - actual implementation will limit at runtime
  }

  override toString(): string {
    const limitStr = this.limit ? ` LIMIT ${this.limit.toString()}` : '';
    const offsetStr = this.offset ? ` OFFSET ${this.offset.toString()}` : '';
    return `${this.nodeType}${limitStr}${offsetStr} ON (${this.source.toString()})`;
  }
}
