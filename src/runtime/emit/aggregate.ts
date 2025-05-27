import type { AggregateNode } from '../../planner/nodes/aggregate-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { FunctionSchema } from '../../schema/function.js';

export function emitAggregate(plan: AggregateNode, ctx: EmissionContext): Instruction {
	async function* run(
		ctx: RuntimeContext,
		sourceRows: AsyncIterable<Row>
	): AsyncIterable<Row> {
		// For now, implement a simple case: no GROUP BY, just aggregates
		// This handles cases like SELECT count(*) FROM table

		if (plan.groupBy && plan.groupBy.length > 0) {
			throw new Error('GROUP BY not yet implemented in aggregate emitter');
		}

		// Initialize accumulators for each aggregate
		const accumulators: any[] = [];
		const aggregateSchemas: FunctionSchema[] = [];

		// Get the function schemas for each aggregate
		for (const agg of plan.aggregates) {
			// Extract function name and args from the aggregate expression
			// For now, assume it's a ScalarFunctionCallNode
			const funcNode = agg.expression as any;
			if (funcNode.nodeType !== 'ScalarFunctionCall') {
				throw new Error(`Unsupported aggregate expression type: ${funcNode.nodeType}`);
			}

			const funcSchema = funcNode.functionSchema;
			if (!funcSchema || funcSchema.type !== 'aggregate') {
				throw new Error(`Function ${funcNode.functionName || 'unknown'} is not an aggregate function`);
			}

			aggregateSchemas.push(funcSchema);
			accumulators.push(funcSchema.initialValue);
		}

		// Process all rows
		for await (const row of sourceRows) {
			// Set the current row in the runtime context for argument evaluation
			const rowContext = { ...ctx, currentRow: row };

			// For each aggregate, call its step function
			for (let i = 0; i < plan.aggregates.length; i++) {
				const agg = plan.aggregates[i];
				const schema = aggregateSchemas[i];

				// Evaluate the aggregate arguments in the context of the current row
				const argValues: SqlValue[] = [];
				const funcNode = agg.expression as any;

				// For count(*), there are no arguments
				const args = funcNode.args || [];
				if (args.length > 0) {
					for (const argNode of args) {
						// TODO: Properly evaluate arguments in row context
						// For now, skip argument evaluation
						argValues.push(null);
					}
				}

				// Call the step function
				if (schema.aggregateStepImpl) {
					accumulators[i] = schema.aggregateStepImpl(accumulators[i], ...argValues);
				}
			}
		}

		// Finalize and yield the result
		const resultRow: SqlValue[] = [];
		for (let i = 0; i < plan.aggregates.length; i++) {
			const agg = plan.aggregates[i];
			const schema = aggregateSchemas[i];

			let finalValue: SqlValue;
			if (schema.aggregateFinalizerImpl) {
				finalValue = schema.aggregateFinalizerImpl(accumulators[i]);
			} else {
				finalValue = accumulators[i];
			}

			resultRow.push(finalValue);
		}

		yield resultRow;
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Don't emit aggregate function instructions - they're handled internally
	// The aggregate expressions contain the function schemas we need

	return {
		params: [sourceInstruction],
		run: run as any,
		note: `aggregate`
	};
}
