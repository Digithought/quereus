/**
 * Rule: Aggregate Streaming
 *
 * Transforms: AggregateNode → StreamAggregateNode (with Sort if needed)
 * Conditions: Logical aggregate node needs physical implementation
 * Benefits: Enables streaming aggregation with proper grouping order
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { StreamAggregateNode } from '../../nodes/stream-aggregate.js';
import { SortNode } from '../../nodes/sort.js';

const log = createLogger('optimizer:rule:aggregate-streaming');

export function ruleAggregateStreaming(node: PlanNode, _context: OptContext): PlanNode | null {
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

		// Create combined attributes: AggregateNode attributes + source attributes
		// This ensures both GROUP BY/aggregate AND source column attribute IDs are preserved
		const aggregateAttrs = node.getAttributes();
		const sourceAttrs = node.source.getAttributes();

		// Deduplicate by column NAME to avoid duplicate columns like 'id'
		// (The same logical column can have different attribute IDs between aggregate and source)
		const seenNames = new Set<string>();
		const combinedAttrs: typeof aggregateAttrs = [];

		// Add aggregate attributes first (GROUP BY + aggregates)
		for (const attr of aggregateAttrs) {
			combinedAttrs.push(attr);
			seenNames.add(attr.name);
		}

		// Add source attributes that aren't already present by name
		for (const attr of sourceAttrs) {
			if (!seenNames.has(attr.name)) {
				combinedAttrs.push(attr);
				seenNames.add(attr.name);
			}
		}

		// Final safety-pass: filter duplicates that may have slipped through
		const uniqueByName = new Set<string>();
		const deduped: typeof combinedAttrs = [];
		for (const attr of combinedAttrs) {
			if (!uniqueByName.has(attr.name)) {
				deduped.push(attr);
				uniqueByName.add(attr.name);
			}
		}

		const finalAttrs = deduped;

		const result = new StreamAggregateNode(
			node.scope,
			sortNode,
			node.groupBy,
			node.aggregates,
			undefined, // estimatedCostOverride
			finalAttrs // unique list
		);

		// Let framework set physical properties via markPhysical()
		// Both SortNode and StreamAggregateNode have getPhysical() methods

		log('Transformed AggregateNode to StreamAggregateNode with sort');
		return result;
	} else {
		// No GROUP BY - can stream aggregate without sorting
		// Create combined attributes: AggregateNode attributes + source attributes
		// This ensures both GROUP BY/aggregate AND source column attribute IDs are preserved
		const aggregateAttrs = node.getAttributes();
		const sourceAttrs = node.source.getAttributes();

		// Deduplicate by column NAME to avoid duplicate columns like 'id'
		// (The same logical column can have different attribute IDs between aggregate and source)
		const seenNames = new Set<string>();
		const combinedAttrs: typeof aggregateAttrs = [];

		// Add aggregate attributes first (GROUP BY + aggregates)
		for (const attr of aggregateAttrs) {
			combinedAttrs.push(attr);
			seenNames.add(attr.name);
		}

		// Add source attributes that aren't already present by name
		for (const attr of sourceAttrs) {
			if (!seenNames.has(attr.name)) {
				combinedAttrs.push(attr);
				seenNames.add(attr.name);
			}
		}

		// Final safety-pass: filter duplicates that may have slipped through
		const uniqueByName = new Set<string>();
		const deduped: typeof combinedAttrs = [];
		for (const attr of combinedAttrs) {
			if (!uniqueByName.has(attr.name)) {
				deduped.push(attr);
				uniqueByName.add(attr.name);
			}
		}

		const finalAttrs = deduped;

		const result = new StreamAggregateNode(
			node.scope,
			source,
			node.groupBy,
			node.aggregates,
			undefined, // estimatedCostOverride
			finalAttrs // unique list
		);

		// Let framework set physical properties via markPhysical()
		// StreamAggregateNode has getPhysical() method

		log('Transformed AggregateNode to StreamAggregateNode without sort');
		return result;
	}
}
