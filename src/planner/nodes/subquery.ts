import { PlanNode, type ScalarPlanNode } from "./plan-node.js";
import type { ScalarType } from "../../common/datatype.js";
import type { RelationalPlanNode } from "./plan-node.js";
import { type CompareFn, SqlDataType } from "../../common/types.js";
import { PlanNodeType } from "./plan-node-type.js";
import type { Scope } from "../scopes/scope.js";
import { compareSqlValues } from "../../util/comparison.js";
import type { Expression } from "../../parser/ast.js";

export class InNode extends PlanNode implements ScalarPlanNode {
	readonly nodeType = PlanNodeType.In;

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

	toString(): string {
		return `${super.toString()}`;
	}
}
