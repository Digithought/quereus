import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';

/**
 * Physical pass-through that forks the runtime context on emit and pumps its
 * child sub-tree into a bounded ring buffer immediately, so the consumer's
 * first await finds rows already in flight.
 *
 * Rows, order, attribute IDs, keys, FDs, equivClasses, orderings, monotonicity
 * all pass through verbatim. The only effect is timing: the source starts
 * executing as soon as the parent emit reaches this node, ahead of the
 * consumer's first demand.
 *
 * computePhysical is not overridden — the default child-merge keeps
 * deterministic/idempotent/readonly from the source unchanged. No new
 * ordering/key/FD claims; no claims removed.
 */
export class EagerPrefetchNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.EagerPrefetch;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly bufferSize: number = 64,
		estimatedCostOverride?: number,
	) {
		super(scope, estimatedCostOverride);
	}

	getAttributes(): readonly Attribute[] {
		return this.source.getAttributes();
	}

	getType(): RelationType {
		return this.source.getType();
	}

	getChildren(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`EagerPrefetchNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource] = newChildren;

		if (!isRelationalNode(newSource)) {
			quereusError('EagerPrefetchNode: child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		if (newSource === this.source) {
			return this;
		}

		return new EagerPrefetchNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.bufferSize,
		);
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows;
	}

	override toString(): string {
		return `EAGER PREFETCH (buffer=${this.bufferSize})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			bufferSize: this.bufferSize,
			sourceNodeType: this.source.nodeType,
		};
	}
}
