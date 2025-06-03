import type { DistinctNode } from '../../planner/nodes/distinct-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { compareSqlValues } from '../../util/comparison.js';

export function emitDistinct(plan: DistinctNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for source attributes
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>): AsyncIterable<Row> {
		const seenRows: Row[] = [];

		// Helper function to compare two rows for equality using SQL semantics
		function rowsAreEqual(row1: Row, row2: Row): boolean {
			if (row1.length !== row2.length) return false;

			for (let i = 0; i < row1.length; i++) {
				if (compareSqlValues(row1[i], row2[i]) !== 0) {
					return false;
				}
			}
			return true;
		}

		for await (const sourceRow of source) {
			// Set up context for this row using row descriptor
			ctx.context.set(sourceRowDescriptor, () => sourceRow);

			try {
				// Check if we've seen this row before using SQL comparison semantics
				const isDuplicate = seenRows.some(seenRow => rowsAreEqual(sourceRow, seenRow));

				if (!isDuplicate) {
					seenRows.push([...sourceRow]); // Store a copy to avoid mutation issues
					yield sourceRow;
				}
			} finally {
				// Clean up context for this row
				ctx.context.delete(sourceRowDescriptor);
			}
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as any,
		note: 'distinct'
	};
}
