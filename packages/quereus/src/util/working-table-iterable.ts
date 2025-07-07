import type { Row } from '../common/types.js';
import type { RuntimeContext } from '../runtime/types.js';
import type { RowDescriptor } from '../planner/nodes/plan-node.js';
import { withRowContextGenerator } from '../runtime/context-helpers.js';

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
		// Convert rows array to async iterable
		async function* rowsIterable(rows: Row[]): AsyncIterable<Row> {
			for (const row of rows) {
				yield row;
			}
		}

		// Use the helper to manage context
		yield* withRowContextGenerator(
			this.rctx,
			this.rowDescriptor,
			rowsIterable(this.rows),
			async function* (row) {
				yield row;
			}
		);
	}
}

