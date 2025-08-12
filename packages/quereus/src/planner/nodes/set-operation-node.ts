import { isRelationalNode, PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { quereusError, QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export class SetOperationNode extends PlanNode implements BinaryRelationalNode {
  readonly nodeType = PlanNodeType.SetOperation;
  private attributesCache: Cached<readonly Attribute[]>;

  constructor(
    scope: Scope,
    public readonly left: RelationalPlanNode,
    public readonly right: RelationalPlanNode,
    public readonly op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff'
  ) {
    super(scope, left.getTotalCost() + right.getTotalCost());
    // Validate column counts
    const leftCols = left.getType().columns;
    const rightCols = right.getType().columns;
    if (leftCols.length !== rightCols.length) {
      throw new QuereusError(`SET operation column count mismatch: left has ${leftCols.length}, right has ${rightCols.length}`, StatusCode.ERROR);
    }
    // TODO: optionally check type compatibility (affinity)
    this.attributesCache = new Cached(() => this.buildAttributes());
  }

  private buildAttributes(): readonly Attribute[] {
    const leftAttrs = this.left.getAttributes();
    // Preserve left child's attributes directly to avoid any mapping issues
    // This ensures ORDER BY expressions can resolve to the same attribute IDs
    return leftAttrs;
  }

  getAttributes(): readonly Attribute[] {
    return this.attributesCache.value;
  }

  getType(): RelationType {
    const leftType = this.left.getType();
    return { ...leftType, isSet: true } as RelationType;
  }

  getChildren(): readonly PlanNode[] {
    return [this.left, this.right];
  }

  getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
    return [this.left, this.right];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 2) {
      quereusError(`SetOperationNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
    }

    const [newLeft, newRight] = newChildren;

    // Type check
    if (!isRelationalNode(newLeft)) {
      quereusError('SetOperationNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }
    if (!isRelationalNode(newRight)) {
      quereusError('SetOperationNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }

    // Return same instance if nothing changed
    if (newLeft === this.left && newRight === this.right) {
      return this;
    }

    // Create new instance preserving attributes (set operation preserves left child's attributes)
    return new SetOperationNode(
      this.scope,
      newLeft as RelationalPlanNode,
      newRight as RelationalPlanNode,
      this.op
    );
  }

  override toString(): string {
    return `${this.op.toUpperCase()}(${this.left.id}, ${this.right.id})`;
  }
}
