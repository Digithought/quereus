/**
 * Rule: Aggregate Streaming
 *
 * Required Characteristics:
 * - Node must support aggregation operations (AggregationCapable interface)
 * - Node must be relational (produces rows)
 * - Node must be read-only (no side effects for streaming)
 *
 * Applied When:
 * - Logical aggregate node needs physical streaming implementation
 * - Source data can be processed incrementally
 *
 * Benefits: Enables streaming aggregation with proper grouping order, memory efficient processing
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, Attribute } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { StreamAggregateNode } from '../../nodes/stream-aggregate.js';
import { SortNode } from '../../nodes/sort.js';
import {
	PlanNodeCharacteristics,
	CapabilityDetectors,
	type AggregationCapable
} from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:aggregate-streaming');

export function ruleAggregateStreaming(node: PlanNode, _context: OptContext): PlanNode | null {
	// Guard: node must support aggregation operations
	if (!CapabilityDetectors.isAggregating(node)) {
		return null;
	}

	log('Applying aggregate streaming rule to node %s', node.id);

	// Get aggregation characteristics
	const aggregateNode = node as AggregationCapable;
	const groupingKeys = aggregateNode.getGroupingKeys();
	const aggregateExpressions = aggregateNode.getAggregateExpressions();

	// Check if we can stream the aggregation over the source
	const source = aggregateNode.getSource();

	// Check if streaming aggregation is beneficial
	if (!aggregateNode.canStreamAggregate()) {
		log('Node cannot use streaming aggregation, skipping');
		return null;
	}

	if (groupingKeys.length > 0) {
		// Need to ensure ordering for streaming aggregate
		// Check if source already provides the required ordering
		const sourceOrdering = PlanNodeCharacteristics.getOrdering(source);
		const needsSort = !isOrderedForGrouping(sourceOrdering, groupingKeys);

		let sortedSource = source;
		if (needsSort) {
			// Insert sort to ensure proper grouping order
			const sortKeys = groupingKeys.map(expr => ({
				expression: expr,
				direction: 'asc' as const,
				nulls: undefined
			}));

			sortedSource = new SortNode(node.scope, source, sortKeys);
			log('Inserted sort for grouping keys');
		} else {
			log('Source already provides required ordering for streaming');
		}

		// Create combined attributes preserving attribute IDs
		const finalAttrs = combineAttributes(node.getAttributes(), source.getAttributes());

		// Convert aggregate expressions to match StreamAggregateNode interface
		const streamAggregates = aggregateExpressions.map(agg => ({
			expression: agg.expr,
			alias: agg.alias
		}));

		const result = new StreamAggregateNode(
			node.scope,
			sortedSource,
			groupingKeys,
			streamAggregates,
			undefined, // estimatedCostOverride
			finalAttrs
		);

		log('Transformed aggregation to StreamAggregateNode with %s', needsSort ? 'sort' : 'existing order');
		return result;
	} else {
		// No GROUP BY - can stream aggregate without sorting
		const finalAttrs = combineAttributes(node.getAttributes(), source.getAttributes());

		// Convert aggregate expressions to match StreamAggregateNode interface
		const streamAggregates = aggregateExpressions.map(agg => ({
			expression: agg.expr,
			alias: agg.alias
		}));

		const result = new StreamAggregateNode(
			node.scope,
			source,
			groupingKeys,
			streamAggregates,
			undefined, // estimatedCostOverride
			finalAttrs
		);

		log('Transformed aggregation to StreamAggregateNode without sort');
		return result;
	}
}

/**
 * Check if source ordering matches grouping requirements for streaming
 */
function isOrderedForGrouping(
	_ordering: { column: number; desc: boolean }[] | undefined,
	_groupingKeys: readonly ScalarPlanNode[]
): boolean {
	// TODO: Implement proper ordering analysis
	// For now, conservatively return false to always sort
	// This should check if the ordering covers all grouping keys in order
	return false;
}

/**
 * Combine attributes from aggregate and source, avoiding duplicates by name
 * This preserves attribute IDs while ensuring unique column names
 */
function combineAttributes(aggregateAttrs: readonly Attribute[], sourceAttrs: readonly Attribute[]): Attribute[] {
	const seenNames = new Set<string>();
	const combinedAttrs: Attribute[] = [];

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

	// Final deduplication pass
	const uniqueByName = new Set<string>();
	const deduped: any[] = [];
	for (const attr of combinedAttrs) {
		if (!uniqueByName.has(attr.name)) {
			deduped.push(attr);
			uniqueByName.add(attr.name);
		}
	}

	return deduped;
}
