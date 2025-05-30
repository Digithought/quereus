import type { StreamAggregateNode } from '../../planner/nodes/stream-aggregate.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { FunctionSchema } from '../../schema/function.js';
import { AggregateFunctionCallNode } from '../../planner/nodes/aggregate-function.js';
import { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import type { PlanNode } from '../../planner/nodes/plan-node.js';

/**
 * Creates a group key from an array of values that can be used as a Map key
 */
function createGroupKey(values: SqlValue[]): string {
	// Use JSON.stringify to create a stable key from the group values
	// This handles nulls, numbers, strings, etc. properly
	return JSON.stringify(values);
}

/**
 * Find the source relation node that column references should use as their context key.
 * This traverses up the tree to find the original table scan or similar node.
 */
function findSourceRelation(node: PlanNode): PlanNode {
	// Keep going up until we find a table scan or values node
	let current = node;
	while (current) {
		if (current.nodeType === 'TableScan' || current.nodeType === 'Values' || current.nodeType === 'SingleRow') {
			return current;
		}
		// Get the first relational source
		const relations = current.getRelations();
		if (relations.length > 0) {
			current = relations[0];
		} else {
			break;
		}
	}
	return node; // Fallback to the original node
}

export function emitStreamAggregate(plan: StreamAggregateNode, ctx: EmissionContext): Instruction {
	// Find the actual source relation for column references
	const sourceRelation = findSourceRelation(plan.source);

	// Create row descriptors for context
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	const sourceRelationRowDescriptor: RowDescriptor = [];
	if (sourceRelation !== plan.source) {
		const sourceRelationAttributes = (sourceRelation as any).getAttributes?.() || sourceAttributes;
		sourceRelationAttributes.forEach((attr: any, index: number) => {
			sourceRelationRowDescriptor[attr.id] = index;
		});
	}

	// Create output row descriptor for the StreamAggregate's output
	const outputRowDescriptor: RowDescriptor = [];
	const outputAttributes = plan.getAttributes();
	outputAttributes.forEach((attr, index) => {
		outputRowDescriptor[attr.id] = index;
	});

	async function* run(
		ctx: RuntimeContext,
		sourceRows: AsyncIterable<Row>,
		...groupByAndAggregateArgs: Array<(ctx: RuntimeContext) => SqlValue | Promise<SqlValue>>
	): AsyncIterable<Row> {

		// Split the arguments: first N are GROUP BY expressions, rest are aggregate args
		const numGroupBy = plan.groupBy.length;
		const groupByFunctions = groupByAndAggregateArgs.slice(0, numGroupBy);

		// For aggregate arguments, we need to properly index them based on each aggregate's argument count
		let aggregateArgOffset = numGroupBy;
		const aggregateArgFunctions: Array<Array<(ctx: RuntimeContext) => SqlValue | Promise<SqlValue>>> = [];

		for (const agg of plan.aggregates) {
			const funcNode = agg.expression;
			if (!(funcNode instanceof AggregateFunctionCallNode)) {
				throw new Error(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`);
			}
			const args = funcNode.args || [];
			const aggregateArgs = groupByAndAggregateArgs.slice(aggregateArgOffset, aggregateArgOffset + args.length);
			aggregateArgFunctions.push(aggregateArgs);
			aggregateArgOffset += args.length;
		}

		// Get the function schemas for each aggregate
		const aggregateSchemas: FunctionSchema[] = [];
		const aggregateDistinctFlags: boolean[] = [];
		for (const agg of plan.aggregates) {
			const funcNode = agg.expression;
			if (!(funcNode instanceof AggregateFunctionCallNode)) {
				throw new Error(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`);
			}

			const funcSchema = funcNode.functionSchema;
			if (!funcSchema || funcSchema.type !== 'aggregate') {
				throw new Error(`Function ${funcNode.functionName || 'unknown'} is not an aggregate function`);
			}

			aggregateSchemas.push(funcSchema);
			aggregateDistinctFlags.push(funcNode.isDistinct);
		}

		// Handle the case with no GROUP BY - aggregate everything into a single group
		if (plan.groupBy.length === 0) {
			// Initialize accumulators for each aggregate
			const accumulators: any[] = aggregateSchemas.map(schema => {
				// Get fresh initial value - if it's a function, call it; if it's an object/array, copy it
				const initialValue = schema.initialValue;
				if (typeof initialValue === 'function') {
					return initialValue();
				} else if (Array.isArray(initialValue)) {
					return [...initialValue];
				} else if (initialValue && typeof initialValue === 'object') {
					return { ...initialValue };
				} else {
					return initialValue;
				}
			});

			// For DISTINCT aggregates, track unique values
			const distinctSets: Set<string>[] = aggregateDistinctFlags.map(isDistinct =>
				isDistinct ? new Set<string>() : new Set() // Empty set for non-distinct
			);

			// Process all rows
			for await (const row of sourceRows) {
				// Set the current row in the runtime context for evaluation using row descriptors
				ctx.context.set(sourceRowDescriptor, () => row);
				if (sourceRelation !== plan.source) {
					ctx.context.set(sourceRelationRowDescriptor, () => row);
				}

				try {
					// For each aggregate, call its step function
					for (let i = 0; i < plan.aggregates.length; i++) {
						const schema = aggregateSchemas[i];
						const isDistinct = aggregateDistinctFlags[i];

						// Evaluate the aggregate arguments in the context of the current row
						const argValues: SqlValue[] = [];
						const funcNode = plan.aggregates[i].expression;
						if (!(funcNode instanceof AggregateFunctionCallNode)) {
							throw new Error(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`);
						}
						const args = funcNode.args || [];
						const argFunctions = aggregateArgFunctions[i];

						for (let j = 0; j < args.length; j++) {
							if (j < argFunctions.length) {
								argValues.push(await argFunctions[j](ctx));
							} else {
								argValues.push(null);
							}
						}

						// Handle DISTINCT logic
						if (isDistinct) {
							// Create a key from the argument values for uniqueness check
							const distinctKey = JSON.stringify(argValues);
							if (distinctSets[i].has(distinctKey)) {
								// Skip this value as it's already been processed
								continue;
							}
							distinctSets[i].add(distinctKey);
						}

						// Call the step function
						if (schema.aggregateStepImpl) {
							accumulators[i] = schema.aggregateStepImpl(accumulators[i], ...argValues);
						}
					}
				} finally {
					// Clean up context for this row
					ctx.context.delete(sourceRowDescriptor);
					if (sourceRelation !== plan.source) {
						ctx.context.delete(sourceRelationRowDescriptor);
					}
				}
			}

			// Finalize and yield the result
			const resultRow: SqlValue[] = [];
			for (let i = 0; i < plan.aggregates.length; i++) {
				const schema = aggregateSchemas[i];

				let finalValue: SqlValue;
				if (schema.aggregateFinalizerImpl) {
					finalValue = schema.aggregateFinalizerImpl(accumulators[i]);
				} else {
					finalValue = accumulators[i];
				}

				resultRow.push(finalValue);
			}

			// Set up output context for the result row
			ctx.context.set(outputRowDescriptor, () => resultRow);
			try {
				yield resultRow;
			} finally {
				ctx.context.delete(outputRowDescriptor);
			}
		} else {
			// Handle GROUP BY case with streaming aggregation
			// Since input is ordered by grouping columns, we can process groups sequentially

			let currentGroupKey: string | null = null;
			let currentGroupValues: SqlValue[] = [];
			let currentAccumulators: any[] = [];
			let currentDistinctSets: Set<string>[] = [];

			// Process all rows
			for await (const row of sourceRows) {
				// Set the current row in the runtime context for evaluation using row descriptors
				ctx.context.set(sourceRowDescriptor, () => row);
				if (sourceRelation !== plan.source) {
					ctx.context.set(sourceRelationRowDescriptor, () => row);
				}

				try {
					// Evaluate GROUP BY expressions to determine the group
					const groupValues: SqlValue[] = [];
					for (const groupByFunc of groupByFunctions) {
						groupValues.push(await groupByFunc(ctx));
					}

					const groupKey = createGroupKey(groupValues);

					// Check if we've moved to a new group
					if (currentGroupKey !== null && currentGroupKey !== groupKey) {
						// Yield the previous group's results
						const resultRow: SqlValue[] = [];

						// First, add the GROUP BY values
						resultRow.push(...currentGroupValues);

						// Then, add the finalized aggregate values
						for (let i = 0; i < plan.aggregates.length; i++) {
							const schema = aggregateSchemas[i];

							let finalValue: SqlValue;
							if (schema.aggregateFinalizerImpl) {
								finalValue = schema.aggregateFinalizerImpl(currentAccumulators[i]);
							} else {
								finalValue = currentAccumulators[i];
							}

							resultRow.push(finalValue);
						}

						// Set up output context for the result row
						ctx.context.set(outputRowDescriptor, () => resultRow);
						try {
							yield resultRow;
						} finally {
							ctx.context.delete(outputRowDescriptor);
						}

						// Reset for new group
						currentAccumulators = aggregateSchemas.map(schema => {
							// Get fresh initial value - if it's a function, call it; if it's an object/array, copy it
							const initialValue = schema.initialValue;
							if (typeof initialValue === 'function') {
								return initialValue();
							} else if (Array.isArray(initialValue)) {
								return [...initialValue];
							} else if (initialValue && typeof initialValue === 'object') {
								return { ...initialValue };
							} else {
								return initialValue;
							}
						});
						currentDistinctSets = aggregateDistinctFlags.map(isDistinct =>
							isDistinct ? new Set<string>() : new Set()
						);
					}

					// Initialize if first group
					if (currentGroupKey === null) {
						currentAccumulators = aggregateSchemas.map(schema => {
							// Get fresh initial value - if it's a function, call it; if it's an object/array, copy it
							const initialValue = schema.initialValue;
							if (typeof initialValue === 'function') {
								return initialValue();
							} else if (Array.isArray(initialValue)) {
								return [...initialValue];
							} else if (initialValue && typeof initialValue === 'object') {
								return { ...initialValue };
							} else {
								return initialValue;
							}
						});
						currentDistinctSets = aggregateDistinctFlags.map(isDistinct =>
							isDistinct ? new Set<string>() : new Set()
						);
					}

					// Update current group
					currentGroupKey = groupKey;
					currentGroupValues = groupValues;

					// For each aggregate, call its step function
					for (let i = 0; i < plan.aggregates.length; i++) {
						const schema = aggregateSchemas[i];
						const isDistinct = aggregateDistinctFlags[i];

						// Evaluate the aggregate arguments in the context of the current row
						const argValues: SqlValue[] = [];
						const funcNode = plan.aggregates[i].expression;
						if (!(funcNode instanceof AggregateFunctionCallNode)) {
							throw new Error(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`);
						}
						const args = funcNode.args || [];
						const argFunctions = aggregateArgFunctions[i];

						for (let j = 0; j < args.length; j++) {
							if (j < argFunctions.length) {
								argValues.push(await argFunctions[j](ctx));
							} else {
								argValues.push(null);
							}
						}

						// Handle DISTINCT logic
						if (isDistinct) {
							// Create a key from the argument values for uniqueness check
							const distinctKey = JSON.stringify(argValues);
							if (currentDistinctSets[i].has(distinctKey)) {
								// Skip this value as it's already been processed
								continue;
							}
							currentDistinctSets[i].add(distinctKey);
						}

						// Call the step function
						if (schema.aggregateStepImpl) {
							currentAccumulators[i] = schema.aggregateStepImpl(currentAccumulators[i], ...argValues);
						}
					}
				} finally {
					// Clean up context for this row
					ctx.context.delete(sourceRowDescriptor);
					if (sourceRelation !== plan.source) {
						ctx.context.delete(sourceRelationRowDescriptor);
					}
				}
			}

			// Yield the final group if any rows were processed
			if (currentGroupKey !== null) {
				const resultRow: SqlValue[] = [];

				// First, add the GROUP BY values
				resultRow.push(...currentGroupValues);

				// Then, add the finalized aggregate values
				for (let i = 0; i < plan.aggregates.length; i++) {
					const schema = aggregateSchemas[i];

					let finalValue: SqlValue;
					if (schema.aggregateFinalizerImpl) {
						finalValue = schema.aggregateFinalizerImpl(currentAccumulators[i]);
					} else {
						finalValue = currentAccumulators[i];
					}

					resultRow.push(finalValue);
				}

				// Set up output context for the result row
				ctx.context.set(outputRowDescriptor, () => resultRow);
				try {
					yield resultRow;
				} finally {
					ctx.context.delete(outputRowDescriptor);
				}
			}
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Emit GROUP BY expressions
	const groupByInstructions = plan.groupBy.map(expr => emitCallFromPlan(expr, ctx));

	// Emit aggregate argument expressions
	const aggregateArgInstructions: Instruction[] = [];
	for (const agg of plan.aggregates) {
		const funcNode = agg.expression;
		if (!(funcNode instanceof AggregateFunctionCallNode)) {
			throw new Error(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`);
		}
		const args = funcNode.args || [];
		for (const arg of args) {
			aggregateArgInstructions.push(emitCallFromPlan(arg, ctx));
		}
	}

	return {
		params: [sourceInstruction, ...groupByInstructions, ...aggregateArgInstructions],
		run: run as any,
		note: `stream_aggregate(${plan.groupBy.length > 0 ? `GROUP BY ${plan.groupBy.length}` : 'no grouping'}, ${plan.aggregates.length} aggs)`
	};
}
