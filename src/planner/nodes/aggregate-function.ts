import type { ScalarType } from '../../common/datatype.js';
import { PlanNode, type ScalarPlanNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { FunctionSchema } from '../../schema/function.js';
import type * as AST from '../../parser/ast.js';

/**
 * Represents an aggregate function call within a SQL query.
 * This is specifically for aggregate functions (COUNT, SUM, AVG, etc.)
 */
export class AggregateFunctionCallNode extends PlanNode implements ScalarPlanNode {
	readonly nodeType = PlanNodeType.ScalarFunctionCall; // Using same type as scalar functions

	constructor(
		scope: Scope,
		public readonly expression: AST.FunctionExpr,
		public readonly functionName: string,
		public readonly functionSchema: FunctionSchema,
		public readonly args: ReadonlyArray<ScalarPlanNode>,
		public readonly isDistinct: boolean = false,
		public readonly orderBy?: ReadonlyArray<{ expression: ScalarPlanNode; direction: 'asc' | 'desc' }>,
		public readonly filter?: ScalarPlanNode
	) {
		super(scope);
	}

	getType(): ScalarType {
		// Get the return type from the function schema
		// For aggregate functions, we need to determine the type based on the function
		// TODO: This should be derived from the function schema or implementation
		return {
			typeClass: 'scalar',
			affinity: this.functionSchema.affinity || 0,
			nullable: true, // Aggregates can return NULL
			isReadOnly: true
		};
	}

	getChildren(): readonly ScalarPlanNode[] {
		const children: ScalarPlanNode[] = [...this.args];
		if (this.orderBy) {
			children.push(...this.orderBy.map(o => o.expression));
		}
		if (this.filter) {
			children.push(this.filter);
		}
		return children;
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		const argsStr = this.args.map(arg => arg.toString()).join(', ');
		const distinctStr = this.isDistinct ? 'DISTINCT ' : '';
		const orderStr = this.orderBy
			? ` ORDER BY ${this.orderBy.map(o => `${o.expression.toString()} ${o.direction.toUpperCase()}`).join(', ')}`
			: '';
		const filterStr = this.filter ? ` FILTER (WHERE ${this.filter.toString()})` : '';
		return `${this.functionName}(${distinctStr}${argsStr}${orderStr})${filterStr}`;
	}
}
