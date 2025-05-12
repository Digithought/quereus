import type { ScalarType } from '../../common/datatype';
import type * as AST from '../../parser/ast';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type NaryScalarNode, type ScalarPlanNode } from './plan-node';
import { PlanNodeType } from './plan-node-type';

export class ScalarFunctionCallNode extends PlanNode implements NaryScalarNode {
	override readonly nodeType = PlanNodeType.ScalarFunctionCall;

	constructor(
		scope: Scope,
		public readonly expression: AST.FunctionExpr,
		public readonly targetType: ScalarType,
		public readonly operands: ScalarPlanNode[]
	) {
		super(scope);
	}

	getType(): ScalarType {
		return this.targetType;
	}

	getChildren(): readonly ScalarPlanNode[] {
		return this.operands;
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `${super.toString()} (${this.expression.name}(${this.operands.length}))`;
	}
}
