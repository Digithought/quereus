import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { RowOp } from '../../schema/table.js';

/**
 * Represents constraint checking for DML operations.
 * This node validates constraints against rows flowing through it.
 */
export class ConstraintCheckNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.ConstraintCheck;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly table: TableReferenceNode,
    public readonly operation: RowOp,
    public readonly oldRowDescriptor?: RowDescriptor,
    public readonly newRowDescriptor?: RowDescriptor,
  ) {
    super(scope);
  }

  getType(): RelationType {
    return this.source.getType();
  }

  getAttributes(): Attribute[] {
    // ConstraintCheck passes through the same attributes as its source
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  getChildren(): readonly PlanNode[] {
    return [this.source];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 1) {
      throw new Error(`ConstraintCheckNode expects 1 child, got ${newChildren.length}`);
    }

    const [newSource] = newChildren;

    // Type check
    if (!('getAttributes' in newSource) || typeof (newSource as any).getAttributes !== 'function') {
      throw new Error('ConstraintCheckNode: child must be a RelationalPlanNode');
    }

    // Return same instance if nothing changed
    if (newSource === this.source) {
      return this;
    }

    // Create new instance
    return new ConstraintCheckNode(
      this.scope,
      newSource as RelationalPlanNode,
      this.table,
      this.operation,
      this.oldRowDescriptor,
      this.newRowDescriptor
    );
  }

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    const opName = this.operation === 1 ? 'INSERT' :
                   this.operation === 2 ? 'UPDATE' :
                   this.operation === 4 ? 'DELETE' : 'UNKNOWN';
    return `CHECK CONSTRAINTS ON ${opName}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    const opName = this.operation === 1 ? 'INSERT' :
                   this.operation === 2 ? 'UPDATE' :
                   this.operation === 4 ? 'DELETE' : 'UNKNOWN';

    return {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      operation: opName,
      hasOldDescriptor: !!this.oldRowDescriptor,
      hasNewDescriptor: !!this.newRowDescriptor,
    };
  }
}
