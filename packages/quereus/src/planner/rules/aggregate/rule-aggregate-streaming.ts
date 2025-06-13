/**
 * Rule: Aggregate Streaming
 *
 * Transforms: AggregateNode → StreamAggregateNode (with Sort if needed)
 * Conditions: Logical aggregate node needs physical implementation
 * Benefits: Enables streaming aggregation with proper grouping order
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { StreamAggregateNode } from '../../nodes/stream-aggregate.js';
import { SortNode } from '../../nodes/sort.js';
import { PlanNode as BasePlanNode } from '../../nodes/plan-node.js';

const log = createLogger('optimizer:rule:aggregate-streaming');

export function ruleAggregateStreaming(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: only apply to AggregateNode
	if (!(node instanceof AggregateNode)) {
		return null;
	}

	log('Applying aggregate streaming rule to node %s', node.id);

	// Source is already optimized by framework
	const source = node.source;

	// For now, always use StreamAggregate
	// TODO: Check if source is ordered on groupBy columns
	// TODO: Consider HashAggregate for unordered inputs

	if (node.groupBy.length > 0) {
		// Need to ensure ordering for streaming aggregate
		// For now, always insert a sort
		// TODO: Check if source already provides the required ordering
		const sortKeys = node.groupBy.map(expr => ({
			expression: expr,
			direction: 'asc' as const,
			nulls: undefined
		}));

		const sortNode = new SortNode(node.scope, source, sortKeys);

		const result = new StreamAggregateNode(
			node.scope,
			sortNode,
			node.groupBy,
			node.aggregates,
			undefined, // estimatedCostOverride
			node.getAttributes() // **CRITICAL**: Preserve original attribute IDs
		);

		// Let framework set physical properties via markPhysical()
		// Both SortNode and StreamAggregateNode have getPhysical() methods

		log('Transformed AggregateNode to StreamAggregateNode with sort');
		return result;
	} else {
		// No GROUP BY - can stream aggregate without sorting
		const result = new StreamAggregateNode(
			node.scope,
			source,
			node.groupBy,
			node.aggregates,
			undefined, // estimatedCostOverride
			node.getAttributes() // **CRITICAL**: Preserve original attribute IDs
		);

		// Let framework set physical properties via markPhysical()
		// StreamAggregateNode has getPhysical() method

		log('Transformed AggregateNode to StreamAggregateNode without sort');
		return result;
	}
}

function meetsPreConditions(node: AggregateNode): boolean {
	// All aggregate nodes need physical implementation
	return true;
}
