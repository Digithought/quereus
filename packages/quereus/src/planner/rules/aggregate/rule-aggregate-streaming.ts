/**
 * Rule: Aggregate Streaming
 *
 * Transforms: AggregateNode → StreamAggregateNode (with Sort if needed)
 * Conditions: Logical aggregate node needs physical implementation
 * Benefits: Enables streaming aggregation with proper grouping order
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { Optimizer } from '../../optimizer.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { StreamAggregateNode } from '../../nodes/stream-aggregate.js';
import { SortNode } from '../../nodes/sort.js';
import { PlanNode as BasePlanNode } from '../../nodes/plan-node.js';

const log = createLogger('optimizer:rule:aggregate-streaming');

export function ruleAggregateStreaming(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	// Guard: only apply to AggregateNode
	if (!(node instanceof AggregateNode)) {
		return null;
	}

	log('Applying aggregate streaming rule to node %s', node.id);

	// Optimize the source first
	const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

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

		const sortNode = new SortNode(node.scope, optimizedSource, sortKeys);

		// Set physical properties for sort
		BasePlanNode.setDefaultPhysical(sortNode, {
			ordering: node.groupBy.map((_, idx) => ({ column: idx, desc: false })),
			estimatedRows: optimizedSource.estimatedRows,
			deterministic: true,
			readonly: true
		});

		const result = new StreamAggregateNode(
			node.scope,
			sortNode,
			node.groupBy,
			node.aggregates,
			undefined, // estimatedCostOverride
			node.getAttributes() // **CRITICAL**: Preserve original attribute IDs
		);

		// Set physical properties for stream aggregate
		BasePlanNode.setDefaultPhysical(result, {
			estimatedRows: optimizedSource.estimatedRows ? Math.ceil(optimizedSource.estimatedRows / 10) : undefined,
			deterministic: true,
			readonly: true
		});

		log('Transformed AggregateNode to StreamAggregateNode with sort');
		return result;
	} else {
		// No GROUP BY - can stream aggregate without sorting
		const result = new StreamAggregateNode(
			node.scope,
			optimizedSource,
			node.groupBy,
			node.aggregates,
			undefined, // estimatedCostOverride
			node.getAttributes() // **CRITICAL**: Preserve original attribute IDs
		);

		// Set physical properties
		BasePlanNode.setDefaultPhysical(result, {
			estimatedRows: 1, // No GROUP BY means single row result
			deterministic: true,
			readonly: true
		});

		log('Transformed AggregateNode to StreamAggregateNode without sort');
		return result;
	}
}

function meetsPreConditions(node: AggregateNode): boolean {
	// All aggregate nodes need physical implementation
	return true;
}
