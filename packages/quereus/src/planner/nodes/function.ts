import type { ScalarType } from '../../common/datatype.js';
import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type NaryScalarNode, type ScalarPlanNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { formatExpressionList, formatScalarType } from '../../util/plan-formatter.js';

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

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== this.operands.length) {
			throw new Error(`ScalarFunctionCallNode expects ${this.operands.length} children, got ${newChildren.length}`);
		}

		// Type check
		for (const child of newChildren) {
			if (!('expression' in child)) {
				throw new Error('ScalarFunctionCallNode: all children must be ScalarPlanNodes');
			}
		}

		// Check if anything changed
		const childrenChanged = newChildren.some((child, i) => child !== this.operands[i]);
		if (!childrenChanged) {
			return this;
		}

		// Create new instance
		return new ScalarFunctionCallNode(
			this.scope,
			this.expression,
			this.targetType,
			newChildren as ScalarPlanNode[]
		);
	}

	override toString(): string {
		return `${this.expression.name}(${formatExpressionList(this.operands)})`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			function: this.expression.name,
			arguments: this.operands.map(op => op.toString()),
			resultType: formatScalarType(this.targetType)
		};
	}
}
