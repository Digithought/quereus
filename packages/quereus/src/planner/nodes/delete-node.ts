import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor, type PhysicalProperties } from './plan-node.js';
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

  getPhysical(childrenPhysical: PhysicalProperties[]): PhysicalProperties {
    const sourcePhysical = childrenPhysical[0];

    return {
      estimatedRows: sourcePhysical?.estimatedRows,
      uniqueKeys: sourcePhysical?.uniqueKeys,
      readonly: false, // DELETE has side effects
      deterministic: true, // Same input always produces same result
      idempotent: true, // DELETE is idempotent (deleting same row twice has same effect)
      constant: false // Never constant
    };
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    // The source provides keys to be deleted, table is the target of deletions.
    return [this.source, this.table];
  }

  getChildren(): readonly [] {
    return [];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      throw new Error(`DeleteNode expects 0 children, got ${newChildren.length}`);
    }
    return this; // No children in getChildren(), source is accessed via getRelations()
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
