import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { ConflictResolution } from '../../common/constants.js';
import type { ColumnDef, RelationType } from '../../common/datatype.js';

/**
 * Represents an INSERT statement in the logical query plan.
 */
export class InsertNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Insert;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly targetColumns: ColumnDef[],
    public readonly source: RelationalPlanNode, // Could be ValuesNode or output of a SELECT
		public readonly onConflict?: ConflictResolution,
  ) {
    super(scope);
  }

	override getType(): RelationType {
		return this.source.getType();
	}

  override getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  override getChildren(): readonly PlanNode[] {
    return [];
  }

  override toString(): string {
    return `${super.toString()} INTO ${this.table.tableSchema.name}`;
  }
}
