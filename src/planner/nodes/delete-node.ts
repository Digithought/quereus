import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';

/**
 * Represents a DELETE statement in the logical query plan.
 */
export class DeleteNode extends VoidNode {
  override readonly nodeType = PlanNodeType.Delete;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly source: RelationalPlanNode, // Typically a FilterNode wrapping a TableScanNode
  ) {
    super(scope);
  }

	override getType(): RelationType {
		return this.source.getType();
	}

  override getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    // The source provides keys to be deleted, table is the target of deletions.
    return [this.source, this.table];
  }

  override getChildren(): readonly PlanNode[] {
    return [];
  }

  override toString(): string {
    return `${super.toString()} FROM ${this.table.tableSchema.name}`;
  }
}
