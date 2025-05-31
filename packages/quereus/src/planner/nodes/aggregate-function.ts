import type { ScalarType } from '../../common/datatype.js';
import { PlanNode, type ScalarPlanNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { FunctionSchema } from '../../schema/function.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import type * as AST from '../../parser/ast.js';
import { formatExpressionList, formatScalarType } from '../../util/plan-formatter.js';

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
		if (isAggregateFunctionSchema(this.functionSchema)) {
			return this.functionSchema.returnType;
		}

		// Fallback for non-aggregate functions (shouldn't happen)
		return {
			typeClass: 'scalar',
			affinity: 0,
			nullable: true, // Aggregates can return NULL
			isReadOnly: true
		};
	}

	getChildren(): readonly ScalarPlanNode[] {
		const children: ScalarPlanNode[] = [...this.args];
		if (this.filter) {
			children.push(this.filter);
		}
		if (this.orderBy) {
			children.push(...this.orderBy.map(item => item.expression));
		}
		return children;
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		const distinctStr = this.isDistinct ? 'DISTINCT ' : '';
		const argsStr = formatExpressionList(this.args);
		const filterStr = this.filter ? ` FILTER (WHERE ${this.filter.toString()})` : '';
		const orderByStr = this.orderBy?.length ? ` ORDER BY ${this.orderBy.map(item => `${item.expression.toString()} ${item.direction.toUpperCase()}`).join(', ')}` : '';
		return `${this.functionName}(${distinctStr}${argsStr})${filterStr}${orderByStr}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			function: this.functionName,
			arguments: this.args.map(arg => arg.toString()),
			resultType: formatScalarType(this.getType()),
			isDistinct: this.isDistinct
		};

		if (this.filter) {
			props.filter = this.filter.toString();
		}

		if (this.orderBy?.length) {
			props.orderBy = this.orderBy.map(item => ({
				expression: item.expression.toString(),
				direction: item.direction
			}));
		}

		return props;
	}
}
