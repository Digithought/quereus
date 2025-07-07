import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type ZeroAryScalarNode } from './plan-node.js';
import type { ScalarType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { WindowFunctionExpr } from '../../parser/ast.js';
import { Cached } from '../../util/cached.js';
import { SqlDataType } from '../../common/types.js';
import { formatScalarType } from '../../util/plan-formatter.js';

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
		public readonly alias?: string,
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

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			throw new Error(`WindowFunctionCallNode expects 0 children, got ${newChildren.length}`);
		}
		return this; // No children, so no change
	}

	override toString(): string {
		const distinctStr = this.isDistinct ? 'DISTINCT ' : '';
		const aliasStr = this.alias ? ` AS ${this.alias}` : '';
		return `${this.functionName}(${distinctStr})${aliasStr}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			function: this.functionName,
			isDistinct: this.isDistinct,
			alias: this.alias,
			resultType: formatScalarType(this.getType())
		};
	}
}
