import type { StreamAggregateNode } from '../../planner/nodes/stream-aggregate.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row, type MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { FunctionSchema } from '../../schema/function.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import { AggregateFunctionCallNode } from '../../planner/nodes/aggregate-function.js';
import type { PlanNode, RowDescriptor } from '../../planner/nodes/plan-node.js';
import { compareSqlValues } from '../../util/comparison.js';
import { BTree } from 'inheritree';
import { createLogger } from '../../common/logger.js';
import { logContextPush, logContextPop } from '../utils.js';
import { coerceForAggregate } from '../../util/coercion.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';

export const ctxLog = createLogger('runtime:context');

/**
 * Compare two arrays of SQL values for equality
 */
function compareGroupKeys(a: SqlValue[], b: SqlValue[]): number {
	if (a.length !== b.length) {
		return a.length - b.length;
	}

	for (let i = 0; i < a.length; i++) {
		const comparison = compareSqlValues(a[i], b[i]);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return 0;
}

/**
 * Compare SQL values for DISTINCT tracking (single value or array)
 */
function compareDistinctValues(a: SqlValue | SqlValue[], b: SqlValue | SqlValue[]): number {
	// Handle arrays (for multi-argument aggregates)
	if (Array.isArray(a) && Array.isArray(b)) {
		return compareGroupKeys(a, b);
	}
	// Handle single values
	if (!Array.isArray(a) && !Array.isArray(b)) {
		return compareSqlValues(a, b);
	}
	// Mixed types shouldn't happen, but handle gracefully
	return Array.isArray(a) ? 1 : -1;
}

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
	const sourceAttributes = plan.source.getAttributes();
	const sourceRowDescriptor = buildRowDescriptor(sourceAttributes);

	const sourceRelationRowDescriptor = sourceRelation !== plan.source
		? buildRowDescriptor((sourceRelation as any).getAttributes?.() || sourceAttributes)
		: sourceRowDescriptor;

	ctxLog('StreamAggregate setup: source=%s, sourceRelation=%s', plan.source.nodeType, sourceRelation.nodeType);
	ctxLog('Source attributes: %O', sourceAttributes.map(attr => `${attr.name}(#${attr.id})`));
	if (sourceRelation !== plan.source) {
		const sourceRelationAttributes = (sourceRelation as any).getAttributes?.() || sourceAttributes;
		ctxLog('Source relation attributes: %O', sourceRelationAttributes.map((attr: any) => `${attr.name}(#${attr.id})`));
	}

	// Create output row descriptor for the StreamAggregate's output
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

	// CRITICAL FIX: Create a combined descriptor that includes BOTH output and source attributes
	// This allows correlated subqueries to access original table attributes
	const combinedRowDescriptor: RowDescriptor = [...outputRowDescriptor];
	sourceAttributes.forEach((attr, index) => {
		// Only add if not already present in output (avoid conflicts)
		if (combinedRowDescriptor[attr.id] === undefined) {
			combinedRowDescriptor[attr.id] = index;
		}
	});

	async function* run(
		ctx: RuntimeContext,
		sourceRows: AsyncIterable<Row>,
		...groupByAndAggregateArgs: Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>
	): AsyncIterable<Row> {

		// Split the arguments: first N are GROUP BY expressions, rest are aggregate args
		const numGroupBy = plan.groupBy.length;
		const groupByFunctions = groupByAndAggregateArgs.slice(0, numGroupBy);

		// For aggregate arguments, we need to properly index them based on each aggregate's argument count
		let aggregateArgOffset = numGroupBy;
		const aggregateArgFunctions: Array<Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>> = [];

		for (const agg of plan.aggregates) {
			const funcNode = agg.expression;
			if (!(funcNode instanceof AggregateFunctionCallNode)) {
				quereusError(
					`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`,
					StatusCode.INTERNAL
				);
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
				quereusError(
					`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`,
					StatusCode.INTERNAL
				);
			}

			const funcSchema = funcNode.functionSchema;
			if (!isAggregateFunctionSchema(funcSchema)) {
				quereusError(
					`Function ${funcNode.functionName || 'unknown'} is not an aggregate function`,
					StatusCode.INTERNAL
				);
			}

			aggregateSchemas.push(funcSchema);
			aggregateDistinctFlags.push(funcNode.isDistinct);
		}

		// Handle the case with no GROUP BY - aggregate everything into a single group
		if (plan.groupBy.length === 0) {
			// Initialize accumulators for each aggregate
			const accumulators: any[] = aggregateSchemas.map(schema => {
				// Get fresh initial value - if it's a function, call it; if it's an object/array, copy it
				const initialValue = isAggregateFunctionSchema(schema) ? schema.initialValue : undefined;
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

			// For DISTINCT aggregates, track unique values using BTree for proper SQL comparison
			const distinctTrees: BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>[] = aggregateDistinctFlags.map(isDistinct =>
				isDistinct ? new BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>(
					(val: SqlValue | SqlValue[]) => val,
					compareDistinctValues
				) : new BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>((val: SqlValue | SqlValue[]) => val, compareDistinctValues) // Empty tree for non-distinct
			);

			// Process all rows
			for await (const row of sourceRows) {
				// Set the current row in the runtime context for evaluation using row descriptors
				ctx.context.set(sourceRowDescriptor, () => row);
				logContextPush(sourceRowDescriptor, 'source-row', sourceAttributes);
				if (sourceRelation !== plan.source) {
					ctx.context.set(sourceRelationRowDescriptor, () => row);
					logContextPush(sourceRelationRowDescriptor, 'source-relation-row');
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
							quereusError(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`, StatusCode.INTERNAL);
						}
						const args = funcNode.args || [];
						const argFunctions = aggregateArgFunctions[i] || []; // Add defensive check

						for (let j = 0; j < args.length; j++) {
							if (j < argFunctions.length) {
								const rawValue = await argFunctions[j](ctx);
								// Apply coercion based on the function type
								const coercedValue = coerceForAggregate(rawValue, funcNode.functionName || 'unknown');
								argValues.push(coercedValue);
							} else {
								argValues.push(null);
							}
						}

						// Handle DISTINCT logic using BTree for proper SQL value comparison
						if (isDistinct) {
							const distinctValue = argValues.length === 1 ? argValues[0] : argValues;
							const existingPath = distinctTrees[i].insert(distinctValue);
							if (!existingPath.on) {
								// Value already exists, skip this occurrence
								continue;
							}
						}

						// Call the step function
						if (isAggregateFunctionSchema(schema)) {
							accumulators[i] = schema.stepFunction(accumulators[i], ...argValues);
						}
					}
				} finally {
					// Clean up context for this row
					logContextPop(sourceRowDescriptor, 'source-row');
					ctx.context.delete(sourceRowDescriptor);
					if (sourceRelation !== plan.source) {
						logContextPop(sourceRelationRowDescriptor, 'source-relation-row');
						ctx.context.delete(sourceRelationRowDescriptor);
					}
				}
			}

			// Finalize and yield the result
			const resultRow: SqlValue[] = [];
			for (let i = 0; i < plan.aggregates.length; i++) {
				const schema = aggregateSchemas[i];

				let finalValue: SqlValue;
				if (isAggregateFunctionSchema(schema)) {
					finalValue = schema.finalizeFunction(accumulators[i]);
				} else {
					finalValue = accumulators[i];
				}

				resultRow.push(finalValue);
			}

			// Set up combined context for the result row (includes both output and source attributes)
			const lastSourceRow = sourceRows[Symbol.asyncIterator] ? undefined : undefined; // We need to track this
			ctx.context.set(outputRowDescriptor, () => resultRow);
			logContextPush(outputRowDescriptor, 'output-row');
			// Note: For no GROUP BY case, we can't preserve source row context since we processed multiple rows
			try {
				yield resultRow;
			} finally {
				logContextPop(outputRowDescriptor, 'output-row');
				ctx.context.delete(outputRowDescriptor);
			}
		} else {
			// Handle GROUP BY case with streaming aggregation
			// Since input is ordered by grouping columns, we can process groups sequentially

			let currentGroupKey: SqlValue[] | null = null;
			let currentGroupValues: SqlValue[] = [];
			let currentSourceRow: Row | null = null; // Track the current group's representative row
			let currentAccumulators: any[] = [];
			let currentDistinctTrees: BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>[] = [];

			// Process all rows
			for await (const row of sourceRows) {
				// Set the current row in the runtime context for evaluation using row descriptors
				ctx.context.set(sourceRowDescriptor, () => row);
				logContextPush(sourceRowDescriptor, 'source-row', sourceAttributes);
				if (sourceRelation !== plan.source) {
					ctx.context.set(sourceRelationRowDescriptor, () => row);
					logContextPush(sourceRelationRowDescriptor, 'source-relation-row');
				}

				try {
					// Evaluate GROUP BY expressions to determine the group
					const groupValues: SqlValue[] = [];
					for (const groupByFunc of groupByFunctions) {
						groupValues.push(await groupByFunc(ctx));
					}

					// Evaluate aggregate function arguments BEFORE checking for group changes
					// This ensures we have the values we need even if we're about to yield the previous group
					const currentRowArgValues: SqlValue[][] = [];
					for (let i = 0; i < plan.aggregates.length; i++) {
						const funcNode = plan.aggregates[i].expression;
						if (!(funcNode instanceof AggregateFunctionCallNode)) {
							quereusError(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`, StatusCode.INTERNAL);
						}
						const args = funcNode.args || [];
						const argFunctions = aggregateArgFunctions[i] || [];

						const argValues: SqlValue[] = [];
						for (let j = 0; j < args.length; j++) {
							if (j < argFunctions.length) {
								const rawValue = await argFunctions[j](ctx);
								// Apply coercion based on the function type
								const coercedValue = coerceForAggregate(rawValue, funcNode.functionName || 'unknown');
								argValues.push(coercedValue);
							} else {
								argValues.push(null);
							}
						}
						currentRowArgValues.push(argValues);
					}

					// Check if we've moved to a new group using proper SQL value comparison
					if (currentGroupKey !== null && compareGroupKeys(currentGroupKey, groupValues) !== 0) {
						// Yield the previous group's results
						const resultRow: SqlValue[] = [];

						// First, add the GROUP BY values
						resultRow.push(...currentGroupValues);

						// Then, add the finalized aggregate values
						for (let i = 0; i < plan.aggregates.length; i++) {
							const schema = aggregateSchemas[i];

							let finalValue: SqlValue;
							if (isAggregateFunctionSchema(schema)) {
								finalValue = schema.finalizeFunction(currentAccumulators[i]);
							} else {
								finalValue = currentAccumulators[i];
							}

							resultRow.push(finalValue);
						}

						// Set up combined context that allows access to both
						// the aggregated result AND the original source row attributes
						ctx.context.set(outputRowDescriptor, () => resultRow);
						logContextPush(outputRowDescriptor, 'output-row-groupby');
						if (currentSourceRow) {
							// Also provide access to a representative source row for this group
							// This enables correlated subqueries to access original table attributes
							ctx.context.set(sourceRowDescriptor, () => currentSourceRow!);
							logContextPush(sourceRowDescriptor, 'source-row-groupby', sourceAttributes);
							if (sourceRelation !== plan.source) {
								ctx.context.set(sourceRelationRowDescriptor, () => currentSourceRow!);
								logContextPush(sourceRelationRowDescriptor, 'source-relation-row-groupby');
							}
						}
						try {
							yield resultRow;
						} finally {
							logContextPop(outputRowDescriptor, 'output-row-groupby');
							ctx.context.delete(outputRowDescriptor);
							if (currentSourceRow) {
								logContextPop(sourceRowDescriptor, 'source-row-groupby');
								ctx.context.delete(sourceRowDescriptor);
								if (sourceRelation !== plan.source) {
									logContextPop(sourceRelationRowDescriptor, 'source-relation-row-groupby');
									ctx.context.delete(sourceRelationRowDescriptor);
								}
							}
						}

						// Reset for new group
						currentAccumulators = aggregateSchemas.map(schema => {
							// Get fresh initial value - if it's a function, call it; if it's an object/array, copy it
							const initialValue = isAggregateFunctionSchema(schema) ? schema.initialValue : undefined;
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
						currentDistinctTrees = aggregateDistinctFlags.map(isDistinct =>
							isDistinct ? new BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>(
								(val: SqlValue | SqlValue[]) => val,
								compareDistinctValues
							) : new BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>((val: SqlValue | SqlValue[]) => val, compareDistinctValues)
						);
					}

					// Initialize if first group
					if (currentGroupKey === null) {
						currentAccumulators = aggregateSchemas.map(schema => {
							// Get fresh initial value - if it's a function, call it; if it's an object/array, copy it
							const initialValue = isAggregateFunctionSchema(schema) ? schema.initialValue : undefined;
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
						currentDistinctTrees = aggregateDistinctFlags.map(isDistinct =>
							isDistinct ? new BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>(
								(val: SqlValue | SqlValue[]) => val,
								compareDistinctValues
							) : new BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>((val: SqlValue | SqlValue[]) => val, compareDistinctValues)
						);
					}

					// Update current group
					currentGroupKey = groupValues;
					currentGroupValues = groupValues;
					currentSourceRow = row; // Keep a representative row for this group

					// For each aggregate, call its step function using the pre-evaluated arguments
					for (let i = 0; i < plan.aggregates.length; i++) {
						const schema = aggregateSchemas[i];
						const isDistinct = aggregateDistinctFlags[i];
						const argValues = currentRowArgValues[i];

						// Handle DISTINCT logic using BTree for proper SQL value comparison
						if (isDistinct) {
							const distinctValue = argValues.length === 1 ? argValues[0] : argValues;
							const existingPath = currentDistinctTrees[i].insert(distinctValue);
							if (!existingPath.on) {
								// Value already exists, skip this occurrence
								continue;
							}
						}

						// Call the step function
						if (isAggregateFunctionSchema(schema)) {
							currentAccumulators[i] = schema.stepFunction(currentAccumulators[i], ...argValues);
						}
					}
				} finally {
					// Clean up context for this row
					logContextPop(sourceRowDescriptor, 'source-row');
					ctx.context.delete(sourceRowDescriptor);
					if (sourceRelation !== plan.source) {
						logContextPop(sourceRelationRowDescriptor, 'source-relation-row');
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
					if (isAggregateFunctionSchema(schema)) {
						finalValue = schema.finalizeFunction(currentAccumulators[i]);
					} else {
						finalValue = currentAccumulators[i];
					}

					resultRow.push(finalValue);
				}

				// CRITICAL FIX: Set up combined context for final group
				ctx.context.set(outputRowDescriptor, () => resultRow);
				logContextPush(outputRowDescriptor, 'final-output-row');
				if (currentSourceRow) {
					ctx.context.set(sourceRowDescriptor, () => currentSourceRow);
					logContextPush(sourceRowDescriptor, 'final-source-row', sourceAttributes);
					if (sourceRelation !== plan.source) {
						ctx.context.set(sourceRelationRowDescriptor, () => currentSourceRow);
						logContextPush(sourceRelationRowDescriptor, 'final-source-relation-row');
					}
				}
				try {
					yield resultRow;
				} finally {
					logContextPop(outputRowDescriptor, 'final-output-row');
					ctx.context.delete(outputRowDescriptor);
					if (currentSourceRow) {
						logContextPop(sourceRowDescriptor, 'final-source-row');
						ctx.context.delete(sourceRowDescriptor);
						if (sourceRelation !== plan.source) {
							logContextPop(sourceRelationRowDescriptor, 'final-source-relation-row');
							ctx.context.delete(sourceRelationRowDescriptor);
						}
					}
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
			quereusError(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`, StatusCode.INTERNAL);
		}
		const args = funcNode.args || [];
		for (const arg of args) {
			if (!arg) {
				quereusError(`Aggregate argument is undefined for function ${funcNode.functionName}`, StatusCode.INTERNAL);
			}
			aggregateArgInstructions.push(emitCallFromPlan(arg, ctx));
		}
	}

	return {
		params: [sourceInstruction, ...groupByInstructions, ...aggregateArgInstructions],
		run: run as any,
		note: `stream_aggregate(${plan.groupBy.length > 0 ? `GROUP BY ${plan.groupBy.length}` : 'no grouping'}, ${plan.aggregates.length} aggs)`
	};
}
