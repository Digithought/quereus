import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { formatExpression } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

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

  getAttributes(): Attribute[] {
    // LIMIT/OFFSET preserves the same attributes as its source
    return this.source.getAttributes();
  }

  getChildren(): readonly PlanNode[] {
    const children: PlanNode[] = [this.source];
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
    if (this.limit) parts.push(`LIMIT ${formatExpression(this.limit)}`);
    if (this.offset) parts.push(`OFFSET ${formatExpression(this.offset)}`);
    return parts.join(' ');
  }

  override getLogicalProperties(): Record<string, unknown> {
    const props: Record<string, unknown> = {};

    if (this.limit) {
      props.limit = formatExpression(this.limit);
    }

    if (this.offset) {
      props.offset = formatExpression(this.offset);
    }

    return props;
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const expectedLength = 1 + (this.limit ? 1 : 0) + (this.offset ? 1 : 0);
    if (newChildren.length !== expectedLength) {
      quereusError(`LimitOffsetNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
    }

    const [newSource, ...restChildren] = newChildren;

    // Type check
    if (!('getAttributes' in newSource) || typeof (newSource as any).getAttributes !== 'function') {
      quereusError('LimitOffsetNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }

    // Parse optional limit and offset from remaining children
    let newLimit: ScalarPlanNode | undefined = undefined;
    let newOffset: ScalarPlanNode | undefined = undefined;
    let childIndex = 0;

    if (this.limit) {
      newLimit = restChildren[childIndex] as ScalarPlanNode;
      childIndex++;
    }
    if (this.offset) {
      newOffset = restChildren[childIndex] as ScalarPlanNode;
    }

    // Check if anything changed
    const sourceChanged = newSource !== this.source;
    const limitChanged = newLimit !== this.limit;
    const offsetChanged = newOffset !== this.offset;

    if (!sourceChanged && !limitChanged && !offsetChanged) {
      return this;
    }

    // Create new instance preserving attributes (limit/offset preserves source attributes)
    return new LimitOffsetNode(
      this.scope,
      newSource as RelationalPlanNode,
      newLimit,
      newOffset
    );
  }
}
