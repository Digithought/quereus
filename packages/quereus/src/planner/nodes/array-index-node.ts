import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type ScalarPlanNode, type ZeroAryScalarNode } from './plan-node.js';
import type { ScalarType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type * as AST from '../../parser/ast.js';

/**
 * Represents direct access to a value in a row by array index.
 * This is used when we know the exact position of a value in the output row.
 */
export class ArrayIndexNode extends PlanNode implements ZeroAryScalarNode {
	override readonly nodeType = PlanNodeType.ArrayIndex;
	public readonly expression: AST.Expression;

	constructor(
		scope: Scope,
		public readonly index: number,
		public readonly type: ScalarType
	) {
		super(scope);
		// Create a synthetic expression for this array access
		this.expression = {
			type: 'literal',
			value: `[${index}]`
		} as AST.LiteralExpr;
	}

	getType(): ScalarType {
		return this.type;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `[${this.index}]`;
	}
}
