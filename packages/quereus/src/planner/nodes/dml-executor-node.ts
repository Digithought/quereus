import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { ConflictResolution } from '../../common/constants.js';
import { RowOp } from '../../parser/ast.js';

/**
 * Executes actual database insert/update/delete operations after constraint validation.
 * This node performs the actual vtab.xUpdate operations and yields the affected rows.
 * All data transformations (defaults, conversions, etc.) happen before this node.
 */
export class DmlExecutorNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.UpdateExecutor;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly table: TableReferenceNode,
    public readonly operation: RowOp,
    public readonly onConflict?: ConflictResolution, // Used for INSERT operations
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
    return new DmlExecutorNode(
      this.scope,
      newSource as RelationalPlanNode,
      this.table,
      this.operation,
      this.onConflict
    );
  }

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    return `EXECUTE ${this.operation} ${this.table.tableSchema.name}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      operation: this.operation,
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
    };

    if (this.onConflict) {
      props.onConflict = this.onConflict;
    }

    return props;
  }

  getPhysical(childrenPhysical: PhysicalProperties[]): PhysicalProperties {
    const sourcePhysical = childrenPhysical[0];

    return {
      estimatedRows: sourcePhysical?.estimatedRows,
      uniqueKeys: sourcePhysical?.uniqueKeys,
      readonly: false, // DML executor has side effects
      deterministic: true, // Same input always produces same result
      idempotent: false, // DML operations are generally not idempotent
      constant: false // Never constant
    };
  }
}
