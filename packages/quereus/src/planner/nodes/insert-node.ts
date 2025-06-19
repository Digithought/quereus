import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { ConflictResolution } from '../../common/constants.js';
import { ConflictResolution as CR } from '../../common/constants.js';
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
    public readonly flatRowDescriptor?: RowDescriptor, // For flat OLD/NEW row output
  ) {
    super(scope);
  }

	override getType(): RelationType {
		return this.source.getType();
	}

  getAttributes(): Attribute[] {
    // If we have a flatRowDescriptor, produce attributes that correspond to the flat OLD/NEW row structure
    if (this.flatRowDescriptor && Object.keys(this.flatRowDescriptor).length > 0) {
      // Create attributes for the flat row: OLD columns first, then NEW columns
      const attributes: Attribute[] = [];

      // Add attributes for each position in the flat row
      for (const attrIdStr in this.flatRowDescriptor) {
        const attrId = parseInt(attrIdStr);
        const flatIndex = this.flatRowDescriptor[attrId];

        // Determine if this is OLD or NEW based on index
        const tableColumnCount = this.table.tableSchema.columns.length;
        const isOld = flatIndex < tableColumnCount;
        const columnIndex = isOld ? flatIndex : flatIndex - tableColumnCount;
        const col = this.table.tableSchema.columns[columnIndex];

        attributes[flatIndex] = {
          id: attrId,
          name: col.name,
          type: {
            typeClass: 'scalar',
            affinity: col.affinity,
            nullable: isOld ? true : !col.notNull, // OLD values can be null, NEW follows column constraints
            isReadOnly: false
          },
          sourceRelation: `${isOld ? 'OLD' : 'NEW'}.${this.table.tableSchema.name}`
        };
      }

      return attributes;
    }

    // INSERT produces the same attributes as its source (for non-RETURNING cases)
    return this.source.getAttributes();
  }

  getPhysical(childrenPhysical: PhysicalProperties[]): PhysicalProperties {
    const sourcePhysical = childrenPhysical[0];

    return {
      estimatedRows: sourcePhysical?.estimatedRows,
      uniqueKeys: sourcePhysical?.uniqueKeys,
      readonly: false, // INSERT has side effects
      deterministic: true, // Same input always produces same result
      idempotent: this.onConflict === CR.IGNORE, // Only idempotent with IGNORE conflict resolution
      constant: false // Never constant
    };
  }

  override getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  override getChildren(): readonly PlanNode[] {
    return [];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      throw new Error(`InsertNode expects 0 children, got ${newChildren.length}`);
    }
    return this; // No children in getChildren(), source is accessed via getRelations()
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

    if (this.flatRowDescriptor) {
      props.hasFlatRowDescriptor = true;
    }

    return props;
  }
}
