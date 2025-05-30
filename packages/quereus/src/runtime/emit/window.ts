import type { WindowNode } from '../../planner/nodes/window-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row } from '../../common/types.js';
import { type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitWindow(plan: WindowNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const windowFuncs = plan.windowSpecs.map(spec => {
		// For now, handle row_number() specially
		if (spec.func.functionName === 'row_number') {
			// Return a function that will be called for each row
			return {
				name: spec.func.functionName,
				alias: spec.alias,
				// This is a placeholder - the actual row number will be computed during execution
				instruction: null as any
			};
		}
		// Other window functions would be handled here
		return {
			name: spec.func.functionName,
			alias: spec.alias,
			instruction: emitCallFromPlan(spec.func, ctx)
		};
	});

	// Create row descriptor for source attributes
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>): AsyncIterable<Row> {
		// For row_number(), we need to process all rows sequentially
		// Other window functions might need to buffer all rows first

		let rowNumber = 1;

		for await (const sourceRow of source) {
			// Set up context for this row using row descriptor
			ctx.context.set(sourceRowDescriptor, () => sourceRow);

			try {
				// Compute window function values for this row
				const windowValues: OutputValue[] = [];

				for (const func of windowFuncs) {
					if (func.name === 'row_number') {
						// row_number() is simple - just increment for each row
						windowValues.push(rowNumber++);
					} else {
						// Other window functions would be evaluated here
						const value = await (func.instruction as any).run(ctx);
						windowValues.push(value);
					}
				}

				// Create output row by appending window function results to source row
				const resolvedWindowValues = await Promise.all(windowValues);
				yield [...sourceRow, ...resolvedWindowValues] as Row;
			} finally {
				// Clean up context for this row
				ctx.context.delete(sourceRowDescriptor);
			}
		}
	}

	return {
		params: [sourceInstruction],
		run: run as any,
		note: `window(${plan.windowSpecs.map(s => s.alias).join(', ')})`
	};
}
