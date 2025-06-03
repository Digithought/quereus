import type { DistinctNode } from '../../planner/nodes/distinct-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { compareSqlValues } from '../../util/comparison.js';
import { BTree } from 'inheritree';

/**
 * Compares two rows for SQL DISTINCT semantics.
 * Returns -1, 0, or 1 for BTree ordering.
 */
function compareRows(a: Row, b: Row): number {
	// Let's assume correct rows
	// if (a.length !== b.length) {
	// 	return a.length - b.length;
	// }

	// Compare each value using SQL semantics
	for (let i = 0; i < a.length; i++) {
		const comparison = compareSqlValues(a[i], b[i]);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return 0;
}

export function emitDistinct(plan: DistinctNode, ctx: EmissionContext): Instruction {
	async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>): AsyncIterable<Row> {
		// Create BTree to efficiently track distinct rows
		const distinctTree = new BTree<Row, Row>(
			(row: Row) => row, // Identity function - use row as its own key
			compareRows
		);

		for await (const sourceRow of source) {
			// Check if we've seen this row before using BTree lookup
			const newPath = distinctTree.insert(sourceRow);

			if (newPath.on) {
				// This is a new distinct row - add it to our tracking and yield it
				yield sourceRow;
			}
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as any,
		note: 'distinct (btree-optimized)'
	};
}
