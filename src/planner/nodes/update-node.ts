import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { ScalarPlanNode } from './plan-node.js';
import type { ConflictResolution } from '../../common/constants.js';
import type { RelationType } from '../../common/datatype.js';

export interface UpdateAssignment {
  targetColumn: AST.ColumnExpr; // Could be resolved ColumnReferenceNode or just index
  value: ScalarPlanNode;
}

/**
 * Represents an UPDATE statement in the logical query plan.
 */
export class UpdateNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Update;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly assignments: ReadonlyArray<UpdateAssignment>,
    public readonly source: RelationalPlanNode, // Typically a FilterNode wrapping a TableScanNode
		public readonly onConflict?: ConflictResolution,
  ) {
    super(scope);
  }

	override getType(): RelationType {
		return this.source.getType();
	}

  override getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    // The source provides rows to be updated, table is the target of updates.
    return [this.source, this.table];
  }

  override getChildren(): readonly PlanNode[] {
    return this.assignments.map(a => a.value);
  }

  override toString(): string {
    return `${super.toString()} (${this.table.tableSchema.name})`;
  }
}
