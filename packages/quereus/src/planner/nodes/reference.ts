import type { BaseType, ScalarType, RelationType } from '../../common/datatype.js';
import { PlanNode, type RelationalPlanNode, type ZeroAryRelationalNode, type ZeroAryScalarNode, type Attribute } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableSchema } from '../../schema/table.js';
import type { Scope } from '../scopes/scope.js';
import type * as AST from '../../parser/ast.js';
import { relationTypeFromTableSchema } from '../type-utils.js';
import { Cached } from '../../util/cached.js';
import type { FunctionSchema } from '../../schema/function.js';
import { isTableValuedFunctionSchema } from '../../schema/function.js';
import { formatScalarType } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/** Represents a reference to a table in the global schema. */
export class TableReferenceNode extends PlanNode implements ZeroAryRelationalNode {
	override readonly nodeType = PlanNodeType.TableReference;

	private typeCache: Cached<RelationType>;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly tableSchema: TableSchema,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride ?? 1);
		this.typeCache = new Cached(() => relationTypeFromTableSchema(tableSchema));
		this.attributesCache = new Cached(() => {
			// Create attributes from table schema columns
			return this.tableSchema.columns.map((column, index) => ({
				id: PlanNode.nextAttrId(),
				name: column.name,
				type: {
					typeClass: 'scalar' as const,
					affinity: column.affinity,
					nullable: !column.notNull,
					isReadOnly: false,
					collationName: column.collation
				},
				sourceRelation: `${this.tableSchema.schemaName}.${this.tableSchema.name}`
			}));
		});
	}

	getType(): RelationType {
		return this.typeCache.value;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
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
		return `${this.tableSchema.schemaName}.${this.tableSchema.name}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			schema: this.tableSchema.schemaName,
			table: this.tableSchema.name,
			columns: this.tableSchema.columns.map(col => col.name),
			estimates: {
				rows: this.tableSchema.estimatedRows
			}
		};
	}
}

export class TableFunctionReferenceNode extends PlanNode implements ZeroAryRelationalNode {
	override readonly nodeType = PlanNodeType.TableFunctionReference;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly functionSchema: FunctionSchema,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride ?? 1);

		this.attributesCache = new Cached(() => {
			// Create attributes from function schema return type
			if (isTableValuedFunctionSchema(this.functionSchema)) {
				return this.functionSchema.returnType.columns.map((column) => ({
					id: PlanNode.nextAttrId(),
					name: column.name,
					type: column.type,
					sourceRelation: `${this.functionSchema.name}()`
				}));
			}
			return [];
		});
	}

	getType(): RelationType {
		if (isTableValuedFunctionSchema(this.functionSchema)) {
			return this.functionSchema.returnType;
		}
		quereusError(
			`Function ${this.functionSchema.name} is not a table-valued function`,
			StatusCode.INTERNAL
		);
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	get estimatedRows(): number | undefined {
		return 100; // Default estimate for table functions
	}

	override toString(): string {
		return `${this.functionSchema.name}()`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			function: this.functionSchema.name,
			numArgs: this.functionSchema.numArgs
		};

		if (isTableValuedFunctionSchema(this.functionSchema)) {
			props.columns = this.functionSchema.returnType.columns.map(col => col.name);
		}

		return props;
	}
}

/**
 * Represents a reference to a column from a relational node.
 * Uses attribute IDs for stable references across plan transformations.
 */
export class ColumnReferenceNode extends PlanNode implements ZeroAryScalarNode {
	override readonly nodeType = PlanNodeType.ColumnReference;
	override readonly physical: undefined = undefined; // Never physical

	constructor(
		scope: Scope,
		public readonly expression: AST.ColumnExpr, // Original AST expression for this reference
		public readonly columnType: ScalarType,
		public readonly attributeId: number, // Stable attribute ID instead of node reference
		public readonly columnIndex: number, // Position in the row (for runtime efficiency)
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
		const columnName = this.expression.alias ??
			(this.expression.schema ? this.expression.schema + '.' : '') + this.expression.name;
		return columnName;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			column: this.expression.alias ?? this.expression.name,
			schema: this.expression.schema,
			attributeId: this.attributeId,
			resultType: formatScalarType(this.columnType)
		};
	}
}

/**
 * Represents a reference to a parameter (placeholder in a prepared statement).
 * The actual value will be provided at execution time.
 */
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
		return `:${this.nameOrIndex}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			parameter: this.nameOrIndex,
			resultType: formatScalarType(this.targetType)
		};
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
		return `${this.functionSchema.name}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			function: this.functionSchema.name,
			numArgs: this.functionSchema.numArgs,
			targetType: this.targetType.typeClass
		};
	}
}
