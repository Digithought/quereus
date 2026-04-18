import type { Scope } from '../scopes/scope.js';
import { VoidNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type * as AST from '../../parser/ast.js';

/**
 * Discriminated union of ALTER TABLE actions handled by AlterTableNode.
 * addConstraint is handled separately by AddConstraintNode.
 */
export type AlterTableAction =
	| { type: 'renameTable'; newName: string }
	| { type: 'renameColumn'; oldName: string; newName: string }
	| { type: 'addColumn'; column: AST.ColumnDef }
	| { type: 'dropColumn'; name: string }
	| { type: 'alterPrimaryKey'; columns: Array<{ name: string; direction?: 'asc' | 'desc' }> }
	| {
		type: 'alterColumn';
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: AST.Expression | null;
	};

/**
 * Plan node for ALTER TABLE operations (rename table/column, add/drop column).
 * Constraint additions are handled by the separate AddConstraintNode.
 */
export class AlterTableNode extends VoidNode {
	override readonly nodeType = PlanNodeType.AlterTable;

	constructor(
		scope: Scope,
		public readonly table: TableReferenceNode,
		public readonly action: AlterTableAction,
	) {
		super(scope);
	}

	override getRelations(): readonly [TableReferenceNode] {
		return [this.table];
	}

	override toString(): string {
		switch (this.action.type) {
			case 'renameTable':
				return `ALTER TABLE RENAME TO ${this.action.newName}`;
			case 'renameColumn':
				return `ALTER TABLE RENAME COLUMN ${this.action.oldName} TO ${this.action.newName}`;
			case 'addColumn':
				return `ALTER TABLE ADD COLUMN ${this.action.column.name}`;
			case 'dropColumn':
				return `ALTER TABLE DROP COLUMN ${this.action.name}`;
			case 'alterPrimaryKey':
				return `ALTER TABLE ALTER PRIMARY KEY (${this.action.columns.map(c => c.name).join(', ')})`;
			case 'alterColumn':
				return `ALTER TABLE ALTER COLUMN ${this.action.columnName}`;
		}
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			table: this.table.tableSchema.name,
			schema: this.table.tableSchema.schemaName,
			actionType: this.action.type,
			...this.action,
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
