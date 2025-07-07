import type { DistinctNode } from '../../planner/nodes/distinct-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { compareRows } from '../../util/comparison.js';
import { BTree } from 'inheritree';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { withRowContext } from '../context-helpers.js';

export function emitDistinct(plan: DistinctNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for output attributes (same as source since DISTINCT preserves attributes)
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

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
				// This is a new distinct row - set up context and yield it
				yield await withRowContext(ctx, outputRowDescriptor, () => sourceRow, () => sourceRow);
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
