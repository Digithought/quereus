import type { Scope } from '../scopes/scope.js';
import { PlanNode, type VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { VoidType } from '../../common/datatype.js';
import type * as AST from '../../parser/ast.js';

/**
 * Represents adding a constraint to an existing table.
 * This is a DDL operation that modifies the table schema at runtime.
 */
export class AddConstraintNode extends PlanNode implements VoidNode {
  override readonly nodeType = PlanNodeType.AddConstraint;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly constraint: AST.TableConstraint,
  ) {
    super(scope);
  }

  getType(): VoidType {
    return { typeClass: 'void' };
  }

  getRelations(): readonly [TableReferenceNode] {
    return [this.table];
  }

  getChildren(): readonly PlanNode[] {
    return [];
  }

  override toString(): string {
    const constraintType = this.constraint.type.toUpperCase();
    const constraintName = this.constraint.name || 'unnamed';
    return `ADD CONSTRAINT ${constraintName} ${constraintType}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    return {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      constraintType: this.constraint.type,
      constraintName: this.constraint.name,
      hasOperations: !!this.constraint.operations,
      operations: this.constraint.operations,
    };
  }
}
