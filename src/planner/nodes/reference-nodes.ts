import type { BaseType, ScalarType, RelationType } from '../../common/datatype.js';
import { PlanNode, type RelationalPlanNode, type ZeroAryRelationalNode, type ZeroAryScalarNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableSchema } from '../../schema/table.js';
import type { Scope } from '../scope.js';
import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';
import { relationTypeFromTableSchema } from '../type-utils.js';
import { Cached } from '../../util/cached.js';
import type { FunctionSchema } from '../../schema/function.js';

/** Represents a reference to a table in the global schema. */
export class TableReferenceNode extends PlanNode implements ZeroAryRelationalNode {
	override readonly nodeType = PlanNodeType.TableReference;

	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly tableSchema: TableSchema,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride ?? 1);
		this.typeCache = new Cached(() => relationTypeFromTableSchema(tableSchema));
	}

	getType(): RelationType {
		return this.typeCache.value;;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	get estimatedRows(): number | undefined {
		return this.tableSchema.estimatedRows;
	}

	override toString(): string {
		return `${super.toString()} (${this.tableSchema.schemaName}.${this.tableSchema.name})`;
	}
}

/** Handles column references into a parent relation - FROM, JOIN, CTE, etc. */
export class ColumnReferenceNode extends PlanNode implements ZeroAryScalarNode {
	override readonly nodeType = PlanNodeType.ColumnReference;

	constructor(
		scope: Scope,
		public readonly expression: AST.ColumnExpr, // Original AST expression for this reference
		public readonly columnType: ScalarType,
		public relationalNode: RelationalPlanNode, // Reference to the table/alias node providing this column
		public columnIndex: number, // Index of the column in the sourceTableReference's targetNode schema
	) {
		super(scope, 0);
	}

	getType(): ScalarType {
		return this.columnType;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `${super.toString()} (${this.expression.alias ?? (this.expression.schema ? this.expression.schema + '.' : '') + this.expression.name} from ${this.relationalNode})`;
	}
}

/** Handles parameter references in the query - ? or :paramName or :1, :2, etc. */
export class ParameterReferenceNode extends PlanNode implements ZeroAryScalarNode {
	override readonly nodeType = PlanNodeType.ParameterReference;

	constructor(
		scope: Scope,
		public readonly expression: AST.ParameterExpr, // Original AST expression for this parameter
		public readonly nameOrIndex: string | number, // Parameter name (e.g., ':foo') or 1-based index
		public readonly targetType: ScalarType,
	) {
		super(scope, 0.01);
	}

	getType(): ScalarType {
		return this.targetType;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `${super.toString()} (:${this.nameOrIndex})`;
	}
}

export class FunctionReferenceNode extends PlanNode {
	override readonly nodeType = PlanNodeType.TableFunctionReference;

	constructor(
		scope: Scope,
		public readonly functionSchema: FunctionSchema,
		public readonly targetType: BaseType,
	) {
		super(scope);
	}

	// Type has to be determined by scalar or relation call node
	getType(): BaseType {
		return this.targetType;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `${super.toString()} (${this.functionSchema.name}(${this.functionSchema.numArgs}))`;
	}
}
