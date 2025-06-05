import type { Row } from '../common/types.js';
import type { RuntimeContext } from '../runtime/types.js';
import type { RowDescriptor } from '../planner/nodes/plan-node.js';

/**
 * A reusable async iterable for working table data that can be iterated multiple times.
 * Similar to CachedIterable but for runtime-generated working table data.
 * Used primarily in recursive CTE execution where the working table needs to be
 * accessed multiple times during recursive iterations.
 */
export class WorkingTableIterable implements AsyncIterable<Row> {
	constructor(
		private rows: Row[],
		private rctx: RuntimeContext,
		private rowDescriptor: RowDescriptor
	) {}

	async *[Symbol.asyncIterator](): AsyncIterator<Row> {
		for (const row of this.rows) {
			// Set up context for this row using the CTE row descriptor
			this.rctx.context.set(this.rowDescriptor, () => row);
			try {
				yield row;
			} finally {
				// Clean up context
				this.rctx.context.delete(this.rowDescriptor);
			}
		}
	}
}
