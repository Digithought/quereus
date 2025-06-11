import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';

/**
 * Executes actual database updates after constraint validation.
 * This node performs the actual vtab.xUpdate operations and yields the updated rows.
 */
export class UpdateExecutorNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.UpdateExecutor;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly table: TableReferenceNode,
  ) {
    super(scope);
  }

  getType(): RelationType {
    return this.source.getType();
  }

  getAttributes(): Attribute[] {
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
      throw new Error(`UpdateExecutorNode expects 1 child, got ${newChildren.length}`);
    }

    const [newSource] = newChildren;

    // Type check
    if (!('getAttributes' in newSource) || typeof (newSource as any).getAttributes !== 'function') {
      throw new Error('UpdateExecutorNode: child must be a RelationalPlanNode');
    }

    // Return same instance if nothing changed
    if (newSource === this.source) {
      return this;
    }

    // Create new instance
    return new UpdateExecutorNode(
      this.scope,
      newSource as RelationalPlanNode,
      this.table
    );
  }

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    return `EXECUTE UPDATE ${this.table.tableSchema.name}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    return {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
    };
  }
}
