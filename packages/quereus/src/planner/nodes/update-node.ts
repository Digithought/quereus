import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { ScalarPlanNode } from './plan-node.js';
import type { ConflictResolution } from '../../common/constants.js';
import type { RelationType } from '../../common/datatype.js';
import { formatExpression } from '../../util/plan-formatter.js';

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
    public readonly oldRowDescriptor?: RowDescriptor, // For constraint checking
    public readonly newRowDescriptor?: RowDescriptor, // For constraint checking
  ) {
    super(scope);
  }

	getType(): RelationType {
		return this.source.getType();
	}

  getAttributes(): Attribute[] {
    // UPDATE produces the same attributes as its source
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    // The source provides rows to be updated, table is the target of updates.
    return [this.source, this.table];
  }

  getChildren(): readonly ScalarPlanNode[] {
    return this.assignments.map(a => a.value);
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== this.assignments.length) {
      throw new Error(`UpdateNode expects ${this.assignments.length} children, got ${newChildren.length}`);
    }

    // Type check
    for (const child of newChildren) {
      if (!('expression' in child)) {
        throw new Error('UpdateNode: all children must be ScalarPlanNodes');
      }
    }

    // Check if anything changed
    const childrenChanged = newChildren.some((child, i) => child !== this.assignments[i].value);
    if (!childrenChanged) {
      return this;
    }

    // Create new assignments with updated values
    const newAssignments = this.assignments.map((assignment, i) => ({
      targetColumn: assignment.targetColumn,
      value: newChildren[i] as ScalarPlanNode
    }));

    // Create new instance
    return new UpdateNode(
      this.scope,
      this.table,
      newAssignments,
      this.source, // Source doesn't change via withChildren
      this.onConflict,
      this.oldRowDescriptor,
      this.newRowDescriptor
    );
  }

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    return `UPDATE ${this.table.tableSchema.name}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      assignments: this.assignments.map(assign => ({
        column: assign.targetColumn.name,
        value: formatExpression(assign.value)
      }))
    };

    if (this.onConflict) {
      props.onConflict = this.onConflict;
    }

    if (this.oldRowDescriptor) {
      props.hasOldRowDescriptor = true;
    }

    if (this.newRowDescriptor) {
      props.hasNewRowDescriptor = true;
    }

    return props;
  }
}
