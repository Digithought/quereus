import type { ScalarType } from "../../common/datatype.js";
import { PlanNode, type ScalarPlanNode, type UnaryScalarNode, type NaryScalarNode } from "./plan-node.js";
import type * as AST from "../../parser/ast.js";
import type { Scope } from "../scopes/scope.js";
import { SqlDataType } from "../../common/types.js";
import { PlanNodeType } from "./plan-node-type.js";
import { Cached } from "../../util/cached.js";
import { getLiteralSqlType } from "../../common/type-inference.js";

export class UnaryOpNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.UnaryOp;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.UnaryExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope);
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		const operandType = this.operand.getType();

		let datatype: SqlDataType | undefined;
		let affinity: SqlDataType = operandType.affinity;
		let nullable = operandType.nullable;

		switch (this.expression.operator) {
			case 'NOT':
			case 'IS NULL':
			case 'IS NOT NULL':
				datatype = SqlDataType.INTEGER;
				affinity = SqlDataType.INTEGER;
				nullable = false; // Boolean results are never null
				break;
			case '-':
			case '+':
				// Numeric unary operators preserve type but may change nullability
				datatype = operandType.datatype;
				break;
			case '~':
				// Bitwise NOT - results in integer
				datatype = SqlDataType.INTEGER;
				affinity = SqlDataType.INTEGER;
				break;
		}

		return {
			typeClass: 'scalar',
			affinity,
			nullable,
			isReadOnly: operandType.isReadOnly,
			datatype,
			collationName: operandType.collationName,
		};
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `${super.toString()} (${this.expression.operator} ${this.operand.toString()})`;
	}
}

export class BinaryOpNode extends PlanNode implements ScalarPlanNode {
	readonly nodeType = PlanNodeType.BinaryOp;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.BinaryExpr,
		public readonly left: ScalarPlanNode,
		public readonly right: ScalarPlanNode,
	) {
		super(scope);

		this.cachedType = new Cached(this.generateType);
	}

	// Required by PlanNode
	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		const leftType = this.left.getType();
		const rightType = this.right.getType();

		const affinity = leftType.affinity;

		let datatype: SqlDataType | undefined;
		switch (this.expression.operator) {
			case 'OR':
			case 'AND':
			case '+':
			case '-':
			case '*':
			case '/':
			case '%':
			case '=':
			case '!=':
			case '<':
			case '<=':
			case '>':
			case '>=':
			case 'IS':
			case 'IS NOT':
				datatype = SqlDataType.INTEGER;
				break;
			case '||':
				datatype = SqlDataType.TEXT;
				break;
		};

		// TODO: Handle collation conflict
		const collationName = leftType.collationName || rightType.collationName;

		return {
			typeClass: 'scalar',
			affinity,
			nullable: leftType.nullable || rightType.nullable,
			isReadOnly: leftType.isReadOnly || rightType.isReadOnly,
			datatype,
			collationName,
		};
	}

	getChildren(): readonly [ScalarPlanNode, ScalarPlanNode] {
		return [this.left, this.right];
	}

	getRelations(): readonly [] {
		return [];
	}
}

export class LiteralNode extends PlanNode implements ScalarPlanNode {
	readonly nodeType = PlanNodeType.Literal;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.LiteralExpr,
	) {
		super(scope);
	}

	getType(): ScalarType {
		const sqlType = getLiteralSqlType(this.expression.value);
		return {
			typeClass: 'scalar',
			affinity: sqlType === SqlDataType.NULL ? SqlDataType.TEXT : sqlType,
			nullable: sqlType === SqlDataType.NULL,
			isReadOnly: true,
			datatype: sqlType,
			collationName: undefined,
		}
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	toString(): string {
		return `${super.toString()} (${this.expression.value})`;
	}
}

export class CaseExprNode extends PlanNode implements NaryScalarNode {
	readonly nodeType = PlanNodeType.CaseExpr;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CaseExpr,
		public readonly baseExpr: ScalarPlanNode | undefined,
		public readonly whenThenClauses: { when: ScalarPlanNode; then: ScalarPlanNode }[],
		public readonly elseExpr: ScalarPlanNode | undefined,
	) {
		super(scope);
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		// Determine the result type based on all THEN expressions and the ELSE expression
		const resultExpressions = [
			...this.whenThenClauses.map(clause => clause.then),
			...(this.elseExpr ? [this.elseExpr] : [])
		];

		if (resultExpressions.length === 0) {
			// No THEN clauses and no ELSE - should not happen in valid SQL
			return {
				typeClass: 'scalar',
				affinity: SqlDataType.NULL,
				nullable: true,
				isReadOnly: true,
				datatype: SqlDataType.NULL,
			};
		}

		// Use the first result expression as the base type
		const firstType = resultExpressions[0].getType();
		let affinity = firstType.affinity;
		let nullable = firstType.nullable;
		let isReadOnly = firstType.isReadOnly;
		let collationName = firstType.collationName;

		// Check all other result expressions for type compatibility
		for (let i = 1; i < resultExpressions.length; i++) {
			const exprType = resultExpressions[i].getType();

			// If any result can be null, the whole CASE can be null
			if (exprType.nullable) {
				nullable = true;
			}

			// If any result is read-only, consider the whole CASE read-only
			if (exprType.isReadOnly) {
				isReadOnly = true;
			}

			// Handle collation conflicts - for now, use the first non-null collation
			if (!collationName && exprType.collationName) {
				collationName = exprType.collationName;
			}

			// TODO: Implement proper type coercion rules for SQL
			// For now, if types differ, default to TEXT affinity
			if (exprType.affinity !== affinity) {
				affinity = SqlDataType.TEXT;
			}
		}

		// If there's no ELSE clause, the result can be NULL
		if (!this.elseExpr) {
			nullable = true;
		}

		return {
			typeClass: 'scalar',
			affinity,
			nullable,
			isReadOnly,
			collationName,
			// Don't set datatype since it can vary based on runtime conditions
		};
	}

	get operands(): readonly ScalarPlanNode[] {
		const allOperands: ScalarPlanNode[] = [];

		if (this.baseExpr) {
			allOperands.push(this.baseExpr);
		}

		for (const clause of this.whenThenClauses) {
			allOperands.push(clause.when, clause.then);
		}

		if (this.elseExpr) {
			allOperands.push(this.elseExpr);
		}

		return allOperands;
	}

	getChildren(): readonly ScalarPlanNode[] {
		return this.operands;
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		const baseStr = this.baseExpr ? ` ${this.baseExpr.toString()}` : '';
		const whenThenStr = this.whenThenClauses
			.map(clause => ` WHEN ${clause.when.toString()} THEN ${clause.then.toString()}`)
			.join('');
		const elseStr = this.elseExpr ? ` ELSE ${this.elseExpr.toString()}` : '';
		return `${super.toString()} (CASE${baseStr}${whenThenStr}${elseStr} END)`;
	}
}

export class CastNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.Cast;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CastExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope);
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		const operandType = this.operand.getType();
		const targetType = this.expression.targetType.toUpperCase();

		// Determine the SQL data type and affinity based on the target type
		let datatype: SqlDataType;
		let affinity: SqlDataType;

		switch (targetType) {
			case 'INTEGER':
			case 'INT':
			case 'TINYINT':
			case 'SMALLINT':
			case 'MEDIUMINT':
			case 'BIGINT':
			case 'UNSIGNED BIG INT':
			case 'INT2':
			case 'INT8':
				datatype = SqlDataType.INTEGER;
				affinity = SqlDataType.INTEGER;
				break;
			case 'REAL':
			case 'DOUBLE':
			case 'DOUBLE PRECISION':
			case 'FLOAT':
				datatype = SqlDataType.REAL;
				affinity = SqlDataType.REAL;
				break;
			case 'TEXT':
			case 'CHARACTER':
			case 'VARCHAR':
			case 'VARYING CHARACTER':
			case 'NCHAR':
			case 'NATIVE CHARACTER':
			case 'NVARCHAR':
			case 'CLOB':
				datatype = SqlDataType.TEXT;
				affinity = SqlDataType.TEXT;
				break;
			case 'BLOB':
				datatype = SqlDataType.BLOB;
				affinity = SqlDataType.BLOB;
				break;
			case 'NUMERIC':
			case 'DECIMAL':
			case 'BOOLEAN':
			case 'DATE':
			case 'DATETIME':
				datatype = SqlDataType.NUMERIC;
				affinity = SqlDataType.NUMERIC;
				break;
			default:
				// For unknown types, default to BLOB affinity
				datatype = SqlDataType.BLOB;
				affinity = SqlDataType.BLOB;
				break;
		}

		return {
			typeClass: 'scalar',
			affinity,
			nullable: operandType.nullable, // CAST preserves nullability
			isReadOnly: operandType.isReadOnly,
			datatype,
			collationName: affinity === SqlDataType.TEXT ? operandType.collationName : undefined,
		};
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `${super.toString()} (CAST ${this.operand.toString()} AS ${this.expression.targetType})`;
	}
}

export class CollateNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.Collate;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CollateExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope);
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		const operandType = this.operand.getType();

		// COLLATE preserves the operand type but changes the collation
		return {
			typeClass: 'scalar',
			affinity: operandType.affinity,
			nullable: operandType.nullable,
			isReadOnly: operandType.isReadOnly,
			datatype: operandType.datatype,
			collationName: this.expression.collation.toUpperCase(),
		};
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `${super.toString()} (${this.operand.toString()} COLLATE ${this.expression.collation})`;
	}
}
