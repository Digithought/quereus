import type { ScalarType } from "../../common/datatype.js";
import { PlanNode, type ScalarPlanNode } from "./plan-node.js";
import type * as AST from "../../parser/ast.js";
import type { Scope } from "../scopes/scope.js";
import { SqlDataType } from "../../common/types.js";
import { PlanNodeType } from "./plan-node-type.js";
import { Cached } from "../../util/cached.js";
import { getLiteralSqlType } from "../../common/type-inference.js";

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
