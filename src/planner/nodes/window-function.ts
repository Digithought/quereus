import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type ScalarPlanNode, type ZeroAryScalarNode } from './plan-node.js';
import type { ScalarType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { WindowFunctionExpr } from '../../parser/ast.js';
import { Cached } from '../../util/cached.js';
import { SqlDataType } from '../../common/types.js';

/**
 * Represents a window function call in the query plan.
 * Window functions are computed during window operation execution.
 */
export class WindowFunctionCallNode extends PlanNode implements ZeroAryScalarNode {
	override readonly nodeType = PlanNodeType.WindowFunctionCall;

	private outputTypeCache: Cached<ScalarType>;

	constructor(
		scope: Scope,
		public readonly expression: WindowFunctionExpr,
		public readonly functionName: string,
		public readonly isDistinct: boolean = false,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);

		this.outputTypeCache = new Cached(() => {
			// Most window functions return numeric types
			// row_number() specifically returns an integer
			if (this.functionName === 'row_number') {
				return { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false } as ScalarType;
			}
			// Other window functions would have their own type inference
			return { typeClass: 'scalar', affinity: SqlDataType.NUMERIC, nullable: false } as ScalarType;
		});
	}

	getType(): ScalarType {
		return this.outputTypeCache.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	override toString(): string {
		return `${this.functionName}()`;
	}
}
