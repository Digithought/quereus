import { PlanNode, type VoidNode, type RelationalPlanNode, Attribute } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type * as AST from '../../parser/ast.js';
import { RelationType, type VoidType } from '../../common/datatype.js';
import { TEXT_TYPE } from '../../types/builtin-types.js';

/**
 * DECLARE SCHEMA statement plan node
 */
export class DeclareSchemaNode extends PlanNode implements VoidNode {
	override readonly nodeType = PlanNodeType.DeclareSchema;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.DeclareSchemaStmt
	) {
		super(scope, 1);
	}

	getType(): VoidType {
		return { typeClass: 'void' };
	}

	getChildren(): PlanNode[] {
		return [];
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return new DeclareSchemaNode(this.scope, this.statementAst);
	}

	override toString(): string {
		return `DECLARE SCHEMA ${this.statementAst.schemaName || 'main'}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'declareSchema',
			schemaName: this.statementAst.schemaName || 'main',
			itemCount: this.statementAst.items.length
		};
	}
}

/**
 * DIFF SCHEMA statement plan node - returns DDL statements as rows
 */
export class DiffSchemaNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.DiffSchema;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.DiffSchemaStmt
	) {
		super(scope, 1);
	}

	getType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false, // DDL statements can have duplicates (though unlikely)
			columns: [
				{
					name: 'ddl',
					type: {
						typeClass: 'scalar',
						logicalType: TEXT_TYPE,
						nullable: false,
						isReadOnly: true,
					},
					generated: true,
				}
			],
			keys: [],
			rowConstraints: [],
		};
	}

	get estimatedRows(): number | undefined {
		return 10; // Estimated number of migration statements
	}

	getAttributes(): Attribute[] {
		return this.getType().columns.map((column) => ({
			id: PlanNode.nextAttrId(),
			name: column.name,
			type: column.type,
			sourceRelation: `${this.nodeType}:${this.id}`
		}));
	}

	getChildren(): PlanNode[] {
		return [];
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return new DiffSchemaNode(this.scope, this.statementAst);
	}

	override toString(): string {
		return `DIFF SCHEMA ${this.statementAst.schemaName || 'main'}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'diffSchema',
			schemaName: this.statementAst.schemaName || 'main'
		};
	}
}

/**
 * APPLY SCHEMA statement plan node
 */
export class ApplySchemaNode extends PlanNode implements VoidNode {
	override readonly nodeType = PlanNodeType.ApplySchema;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.ApplySchemaStmt
	) {
		super(scope, 1);
	}

	getType(): VoidType {
		return { typeClass: 'void' };
	}

	getChildren(): PlanNode[] {
		return [];
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return new ApplySchemaNode(this.scope, this.statementAst);
	}

	override toString(): string {
		return `APPLY SCHEMA ${this.statementAst.schemaName || 'main'}${this.statementAst.withSeed ? ' WITH SEED' : ''}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'applySchema',
			schemaName: this.statementAst.schemaName || 'main',
			withSeed: this.statementAst.withSeed || false
		};
	}
}

/**
 * EXPLAIN SCHEMA statement plan node - returns result rows with hash info
 */
export class ExplainSchemaNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.ExplainSchema;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.ExplainSchemaStmt
	) {
		super(scope, 1);
	}

	getType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: true,
			columns: [
				{
					name: 'info',
					type: {
						typeClass: 'scalar',
						logicalType: TEXT_TYPE,
						nullable: false,
						isReadOnly: true,
					},
					generated: true,
				}
			],
			keys: [[]],
			rowConstraints: [],
		};
	}

	get estimatedRows(): number | undefined {
		return 1;
	}

	getAttributes(): Attribute[] {
		return this.getType().columns.map((column) => ({
			id: PlanNode.nextAttrId(),
			name: column.name,
			type: column.type,
			sourceRelation: `${this.nodeType}:${this.id}`
		}));
	}

	getChildren(): PlanNode[] {
		return [];
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return new ExplainSchemaNode(this.scope, this.statementAst);
	}

	override toString(): string {
		return `EXPLAIN SCHEMA ${this.statementAst.schemaName || 'main'}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'explainSchema',
			schemaName: this.statementAst.schemaName || 'main',
			version: this.statementAst.version
		};
	}
}


