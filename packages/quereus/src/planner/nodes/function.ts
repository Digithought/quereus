import type { ScalarType } from '../../common/datatype.js';
import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type NaryScalarNode, type ScalarPlanNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { formatExpressionList, formatScalarType } from '../../util/plan-formatter.js';
import type { FunctionSchema } from '../../schema/function.js';
import { FunctionFlags } from '../../common/constants.js';

export class ScalarFunctionCallNode extends PlanNode implements NaryScalarNode {
	override readonly nodeType = PlanNodeType.ScalarFunctionCall;
	private readonly _inferredType?: ScalarType;

	constructor(
		scope: Scope,
		public readonly expression: AST.FunctionExpr,
		public readonly functionSchema: FunctionSchema,
		public readonly operands: ScalarPlanNode[],
		inferredType?: ScalarType
	) {
		super(scope);
		this._inferredType = inferredType;
	}

	getType(): ScalarType {
		// Use inferred type if available, otherwise use schema's return type
		return this._inferredType ?? (this.functionSchema.returnType as ScalarType);
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
			this.functionSchema,
			newChildren as ScalarPlanNode[],
			this._inferredType
		);
	}

	override toString(): string {
		return `${this.expression.name}(${formatExpressionList(this.operands)})`;
	}

	override computePhysical(_childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		// Function calls derive properties from their arguments and the function itself
		const result: Partial<PhysicalProperties> = {};

		// Use function schema to determine deterministic and readonly properties
		const functionIsDeterministic = (this.functionSchema.flags & FunctionFlags.DETERMINISTIC) !== 0;
		const functionIsReadonly = (this.functionSchema.returnType as ScalarType).isReadOnly ?? true;

		// Function is deterministic only if both function and all arguments are deterministic
		if (!functionIsDeterministic) {
			result.deterministic = false;
		}

		// Function is readonly only if both function and all arguments are readonly
		if (!functionIsReadonly) {
			result.readonly = false;
		}

		return result;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			function: this.expression.name,
			arguments: this.operands.map(op => op.toString()),
			resultType: formatScalarType(this.functionSchema.returnType as ScalarType)
		};
	}
}
