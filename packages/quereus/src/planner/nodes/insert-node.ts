import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { ConflictResolution } from '../../common/constants.js';
import type { ColumnDef, RelationType } from '../../common/datatype.js';

/**
 * Represents an INSERT statement in the logical query plan.
 * RelationalPlanNode because this node may be a return value of a SELECT node.
 */
export class InsertNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Insert;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly targetColumns: ColumnDef[],
    public readonly source: RelationalPlanNode, // Could be ValuesNode or output of a SELECT
		public readonly onConflict?: ConflictResolution,
    public readonly newRowDescriptor?: RowDescriptor, // For constraint checking
  ) {
    super(scope);
  }

	override getType(): RelationType {
		return this.source.getType();
	}

  getAttributes(): Attribute[] {
    // INSERT produces the same attributes as its source
    return this.source.getAttributes();
  }

  override getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  override getChildren(): readonly PlanNode[] {
    return [];
  }

  override toString(): string {
    return `INSERT INTO ${this.table.tableSchema.name}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      targetColumns: this.targetColumns.map(col => col.name)
    };

    if (this.onConflict) {
      props.onConflict = this.onConflict;
    }

    if (this.newRowDescriptor) {
      props.hasNewRowDescriptor = true;
    }

    return props;
  }
}
