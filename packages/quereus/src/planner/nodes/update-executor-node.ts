import type { Scope } from '../scopes/scope.js';
import { PlanNode, type VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationalPlanNode } from './plan-node.js';
import type { VoidType } from '../../common/datatype.js';

/**
 * Executes actual database updates after constraint validation.
 * This node performs the actual vtab.xUpdate operations.
 */
export class UpdateExecutorNode extends PlanNode implements VoidNode {
  override readonly nodeType = PlanNodeType.UpdateExecutor;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly table: TableReferenceNode,
  ) {
    super(scope);
  }

  getType(): VoidType {
    return { typeClass: 'void' };
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  getChildren(): readonly PlanNode[] {
    return [this.source];
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
