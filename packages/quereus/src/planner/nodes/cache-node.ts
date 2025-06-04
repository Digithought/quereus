import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';

export type CacheStrategy = 'memory' | 'spill'; // Future: spill-to-disk

/**
 * CacheNode provides smart caching for any relational input.
 *
 * This node materializes its input on first iteration and serves
 * subsequent iterations from the cached result. It implements
 * smart threshold-based policies to avoid excessive memory usage.
 */
export class CacheNode extends PlanNode implements UnaryRelationalNode {
	readonly nodeType = PlanNodeType.Cache;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly strategy: CacheStrategy = 'memory',
		public readonly threshold: number = 10000,  // Rows before switching to pass-through
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);
	}

	// Cache preserves source attributes exactly
	getAttributes(): Attribute[] {
		return this.source.getAttributes();
	}

	getType(): RelationType {
		const sourceType = this.source.getType();
		// Cache preserves all properties of the source relation
		return {
			...sourceType,
			// Note: Caching doesn't change the logical properties
			// but may affect physical properties like ordering
		};
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows;
	}

	override toString(): string {
		return `CACHE (${this.strategy}, threshold=${this.threshold})`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			strategy: this.strategy,
			threshold: this.threshold,
			sourceNodeType: this.source.nodeType
		};
	}
}
