import type * as AST from '../../parser/ast.js';
import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Plan node for CREATE VIEW statements.
 * Creates a new view definition in the schema.
 */
export class CreateViewNode extends VoidNode {
	readonly nodeType = PlanNodeType.CreateView;

	constructor(
		scope: Scope,
		public readonly viewName: string,
		public readonly schemaName: string,
		public readonly ifNotExists: boolean,
		public readonly columns: string[] | undefined,
		public readonly selectStmt: AST.SelectStmt,
		public readonly sql: string
	) {
		super(scope, 1); // Low cost for DDL operations
	}

	override toString(): string {
		const ifNotExistsClause = this.ifNotExists ? 'IF NOT EXISTS ' : '';
		const columnsClause = this.columns ? `(${this.columns.join(', ')})` : '';
		return `CREATE VIEW ${ifNotExistsClause}${this.schemaName}.${this.viewName}${columnsClause}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			viewName: this.viewName,
			schemaName: this.schemaName,
			ifNotExists: this.ifNotExists,
			columns: this.columns,
			selectSql: this.sql
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
