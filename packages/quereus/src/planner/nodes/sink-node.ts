import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type ScalarPlanNode, type RelationalPlanNode, type Attribute } from './plan-node.js';
import type { ColumnDef, RelationType, ScalarType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { SqlDataType } from '../../common/types.js';

/**
 * A sink node that consumes an async iterable for side effects.
 * Returns the number of rows affected.
 */
export class SinkNode extends PlanNode {
	override readonly nodeType = PlanNodeType.Sink;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		/** Describes the operation for information purposes */
		public readonly operation: string,
	) {
		super(scope, source.getTotalCost() + 0.1); // Minimal cost for consuming
	}

	getType(): ScalarType {
		// Return a single-column relation with the row count
		return {
			typeClass: 'scalar',
			isReadOnly: true,
			affinity: SqlDataType.INTEGER,
			nullable: false
		};
	}

	getChildren(): readonly PlanNode[] {
		return [];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number {
		return 1;
	}

	override toString(): string {
		return `SINK (${this.operation})`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			sourceType: this.source.nodeType
		};
	}
}
