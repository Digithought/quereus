import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Represents a LIMIT/OFFSET operation.
 * It takes an input relation and returns at most 'limit' rows, skipping 'offset' rows.
 */
export class LimitOffsetNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.LimitOffset;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly limit: ScalarPlanNode | undefined,
    public readonly offset: ScalarPlanNode | undefined,
    estimatedCostOverride?: number
  ) {
    // Cost is proportional to offset + limit (rows we need to process)
    // We assume limit and offset are constants, but in practice they could be expressions
    super(scope, estimatedCostOverride ?? source.getTotalCost());
  }

  getType(): RelationType {
    // LIMIT/OFFSET preserves the type of the source relation
    return this.source.getType();
  }

  getChildren(): readonly ScalarPlanNode[] {
    const children: ScalarPlanNode[] = [];
    if (this.limit) children.push(this.limit);
    if (this.offset) children.push(this.offset);
    return children;
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  get estimatedRows(): number | undefined {
    const sourceRows = this.source.estimatedRows;
    if (sourceRows === undefined) return undefined;

    // TODO: Evaluate limit/offset if they are constants
    // For now, assume limit is 100 if specified, otherwise use source rows
    if (this.limit) {
      return Math.min(sourceRows, 100);
    }
    return sourceRows;
  }

  override toString(): string {
    const parts: string[] = [];
    if (this.limit) parts.push(`LIMIT ${this.limit.toString()}`);
    if (this.offset) parts.push(`OFFSET ${this.offset.toString()}`);
    return `${super.toString()} (${parts.join(' ')})`;
  }
}
