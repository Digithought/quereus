import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';

/**
 * Represents a DELETE statement in the logical query plan.
 */
export class DeleteNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Delete;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly source: RelationalPlanNode, // Typically a FilterNode wrapping a TableScanNode
    public readonly oldRowDescriptor?: RowDescriptor, // For constraint checking
  ) {
    super(scope);
  }

	getType(): RelationType {
		return this.source.getType();
	}

  getAttributes(): Attribute[] {
    // DELETE produces the same attributes as its source
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    // The source provides keys to be deleted, table is the target of deletions.
    return [this.source, this.table];
  }

  getChildren(): readonly [] {
    return [];
  }

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    return `DELETE FROM ${this.table.tableSchema.name}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName
    };

    if (this.oldRowDescriptor) {
      props.hasOldRowDescriptor = true;
    }

    return props;
  }
}
