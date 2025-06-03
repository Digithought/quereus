import { PlanNode, type ScalarPlanNode } from "./plan-node.js";
import type { ScalarType } from "../../common/datatype.js";
import type { RelationalPlanNode } from "./plan-node.js";
import { type CompareFn, SqlDataType } from "../../common/types.js";
import { PlanNodeType } from "./plan-node-type.js";
import type { Scope } from "../scopes/scope.js";
import { compareSqlValues } from "../../util/comparison.js";
import type { Expression } from "../../parser/ast.js";
import { formatExpression, formatScalarType } from "../../util/plan-formatter.js";

export class ScalarSubqueryNode extends PlanNode implements ScalarPlanNode {
	override readonly nodeType = PlanNodeType.ScalarSubquery;

	constructor(
		readonly scope: Scope,
		readonly expression: Expression, // The original SubqueryExpr AST node
		readonly subquery: RelationalPlanNode,
	) {
		super(scope);
	}

	getType(): ScalarType {
		// Scalar subqueries produce a single value, type depends on the subquery's first column
		const subqueryType = this.subquery.getType();
		if (subqueryType.typeClass === 'relation' && subqueryType.columns.length > 0) {
			const firstColumn = subqueryType.columns[0];
			return firstColumn.type;
		}
		// Fallback to nullable BLOB if we can't determine type
		return {
			typeClass: 'scalar',
			affinity: SqlDataType.BLOB,
			nullable: true,
			isReadOnly: true,
			datatype: SqlDataType.BLOB,
		};
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.subquery];
	}

	override toString(): string {
		return `(subquery)`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			subqueryType: 'scalar',
			resultType: formatScalarType(this.getType()),
		};
	}
}

export class InNode extends PlanNode implements ScalarPlanNode {
	override readonly nodeType = PlanNodeType.In;

	public readonly comparator: CompareFn;

	constructor(
		readonly scope: Scope,
		readonly condition: ScalarPlanNode,
		readonly source: RelationalPlanNode,
	) {
		super(scope);
		this.comparator = (a, b) => compareSqlValues(a, b);
	}

	// To satisfy ScalarPlanNode interface
	get expression(): Expression {
		return this.condition.expression;
	}

  getType(): ScalarType {
		return {
			typeClass: 'scalar',
			affinity: SqlDataType.INTEGER,
			nullable: false,
			isReadOnly: true,
			datatype: SqlDataType.INTEGER,
		}
	}

  getChildren(): readonly [ScalarPlanNode] {
		return [this.condition];
	}

  getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	override toString(): string {
		return `${formatExpression(this.condition)} IN (subquery)`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			condition: formatExpression(this.condition),
			subqueryType: 'in',
			resultType: formatScalarType(this.getType())
		};
	}
}
