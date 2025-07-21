import type { StreamAggregateNode } from '../../planner/nodes/stream-aggregate.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row, type MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { FunctionSchema } from '../../schema/function.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import { AggregateFunctionCallNode } from '../../planner/nodes/aggregate-function.js';
import type { PlanNode, RowDescriptor } from '../../planner/nodes/plan-node.js';
import { isRelationalNode } from '../../planner/nodes/plan-node.js';
import { compareSqlValues } from '../../util/comparison.js';
import { BTree } from 'inheritree';
import { createLogger } from '../../common/logger.js';
import { logContextPush, logContextPop } from '../utils.js';
import { coerceForAggregate } from '../../util/coercion.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { AggValue } from '../../func/registration.js';

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
 * Find the source relation node that column references should use as their context key.
 * This traverses up the tree to find the original table scan or similar node.
 */
function findSourceRelation(node: PlanNode): PlanNode {
	// Keep going up until we find a values node
	let current = node;
	while (current) {
		if (current.nodeType === 'Values' || current.nodeType === 'SingleRow') {
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

	// Create separate descriptors for group yielding to avoid conflicts with source row processing
	const groupSourceRowDescriptor = buildRowDescriptor(sourceAttributes);
	const groupSourceRelationRowDescriptor = sourceRelation !== plan.source
		? buildRowDescriptor(isRelationalNode(sourceRelation) ? sourceRelation.getAttributes() : sourceAttributes)
		: groupSourceRowDescriptor;

	ctxLog('StreamAggregate setup: source=%s, sourceRelation=%s', plan.source.nodeType, sourceRelation.nodeType);
	ctxLog('Source attributes: %O', sourceAttributes.map(attr => `${attr.name}(#${attr.id})`));
	if (sourceRelation !== plan.source) {
		const sourceRelationAttributes = isRelationalNode(sourceRelation) ? sourceRelation.getAttributes() : sourceAttributes;
		ctxLog('Source relation attributes: %O', sourceRelationAttributes.map((attr) => `${attr.name}(#${attr.id})`));
	}

	// Create output row descriptor for the StreamAggregate's output
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Create scan row descriptor for source relation attributes (for Filter evaluation)
	const scanRowDescriptor = buildRowDescriptor(sourceAttributes);

	// CRITICAL FIX: Create a combined descriptor that includes BOTH output and source attributes
	// This allows correlated subqueries to access original table attributes
	const combinedRowDescriptor: RowDescriptor = {...outputRowDescriptor};
	sourceAttributes.forEach((attr, index) => {
		// Only add if not already present in output (avoid conflicts)
		if (combinedRowDescriptor[attr.id] === undefined) {
			combinedRowDescriptor[attr.id] = Object.keys(outputRowDescriptor).length + index;
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
			const accumulators: SqlValue[] = aggregateSchemas.map(schema => {
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

			// Track the last source row for representative row in combined descriptor
			let lastSourceRow: Row | null = null;

			// Process all rows
			for await (const row of sourceRows) {
				lastSourceRow = row;

				// Set the current row in the runtime context for Filter and aggregate evaluation
				ctx.context.set(scanRowDescriptor, () => row);
				logContextPush(scanRowDescriptor, 'scan-row', sourceAttributes);

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
					// Clean up scan context for this row
					logContextPop(scanRowDescriptor, 'scan-row');
					ctx.context.delete(scanRowDescriptor);
				}
			}

			// Finalize and yield the result
			const aggregateRow: SqlValue[] = [];
			for (let i = 0; i < plan.aggregates.length; i++) {
				const schema = aggregateSchemas[i];

				let finalValue: SqlValue;
				if (isAggregateFunctionSchema(schema)) {
					finalValue = schema.finalizeFunction(accumulators[i]);
				} else {
					finalValue = accumulators[i];
				}

				aggregateRow.push(finalValue);
			}

			// Build combined row with aggregate results + representative source row
			const fullRow = lastSourceRow ? [...aggregateRow, ...lastSourceRow] : aggregateRow;

			// Set up combined context for the result row (includes both output and source attributes)
			if (lastSourceRow) {
				ctx.context.set(scanRowDescriptor, () => lastSourceRow);
				logContextPush(scanRowDescriptor, 'aggregate-rep-row');
			}
			ctx.context.set(combinedRowDescriptor, () => fullRow);
			logContextPush(combinedRowDescriptor, 'aggregate-full-row');
			try {
				yield aggregateRow;
			} finally {
				logContextPop(combinedRowDescriptor, 'aggregate-full-row');
				ctx.context.delete(combinedRowDescriptor);
				if (lastSourceRow) {
					logContextPop(scanRowDescriptor, 'aggregate-rep-row');
					ctx.context.delete(scanRowDescriptor);
				}
			}
		} else {
			// Handle GROUP BY case with streaming aggregation
			// Since input is ordered by grouping columns, we can process groups sequentially

			let currentGroupKey: SqlValue[] | null = null;
			let currentGroupValues: SqlValue[] = [];
			let currentSourceRow: Row | null = null; // Track the current group's representative row
			let currentAccumulators: AggValue[] = [];
			let currentDistinctTrees: BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>[] = [];
			let cleanupPreviousGroupContext: (() => void) | null = null;

			// Process all rows
			for await (const row of sourceRows) {
				if (cleanupPreviousGroupContext) {
					cleanupPreviousGroupContext();
					cleanupPreviousGroupContext = null;
				}

				// Set the current row in the runtime context for Filter and GROUP BY evaluation
				ctx.context.set(scanRowDescriptor, () => row);
				logContextPush(scanRowDescriptor, 'scan-row', sourceAttributes);

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
						// CRITICAL: Save the previous group's representative row before yielding
						const previousGroupSourceRow = currentSourceRow;

						// Yield the previous group's results
						const aggregateRow: SqlValue[] = [];

						// First, add the GROUP BY values
						aggregateRow.push(...currentGroupValues);

						// Then, add the finalized aggregate values
						for (let i = 0; i < plan.aggregates.length; i++) {
							const schema = aggregateSchemas[i];

							let finalValue: SqlValue;
							if (isAggregateFunctionSchema(schema)) {
								finalValue = schema.finalizeFunction(currentAccumulators[i]);
							} else {
								finalValue = currentAccumulators[i];
							}

							aggregateRow.push(finalValue);
						}

						// Build combined row with aggregate results + representative source row
						const fullRow = previousGroupSourceRow ? [...aggregateRow, ...previousGroupSourceRow] : aggregateRow;

						// Set up context with the PREVIOUS group's representative row (not the current row)
						if (previousGroupSourceRow) {
							ctx.context.set(scanRowDescriptor, () => previousGroupSourceRow);
							logContextPush(scanRowDescriptor, 'group-rep-row');
						}
						ctx.context.set(combinedRowDescriptor, () => fullRow);
						logContextPush(combinedRowDescriptor, 'output-row-groupby');
						if (previousGroupSourceRow) {
							// Use the previous group's representative row for HAVING evaluation
							// Use separate descriptors to avoid conflicts with source row processing
							ctx.context.set(groupSourceRowDescriptor, () => previousGroupSourceRow!);
							logContextPush(groupSourceRowDescriptor, 'source-row-groupby', sourceAttributes);
							if (sourceRelation !== plan.source) {
								ctx.context.set(groupSourceRelationRowDescriptor, () => previousGroupSourceRow!);
								logContextPush(groupSourceRelationRowDescriptor, 'source-relation-row-groupby');
							}
						}

						// Defer context cleanup
						cleanupPreviousGroupContext = () => {
							logContextPop(combinedRowDescriptor, 'output-row-groupby');
							ctx.context.delete(combinedRowDescriptor);
							if (previousGroupSourceRow) {
								logContextPop(scanRowDescriptor, 'group-rep-row');
								ctx.context.delete(scanRowDescriptor);
							}
							if (previousGroupSourceRow) {
								logContextPop(groupSourceRowDescriptor, 'source-row-groupby');
								ctx.context.delete(groupSourceRowDescriptor);
								if (sourceRelation !== plan.source) {
									logContextPop(groupSourceRelationRowDescriptor, 'source-relation-row-groupby');
									ctx.context.delete(groupSourceRelationRowDescriptor);
								}
							}
						};

						yield aggregateRow;

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
						// Set representative row for the new group (which is the current row)
						currentSourceRow = row;
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
						// Set representative row for the first group
						currentSourceRow = row;
					}

					// Update current group
					currentGroupKey = groupValues;
					currentGroupValues = groupValues;

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
					// Clean up scan context for this row
					logContextPop(scanRowDescriptor, 'scan-row');
					ctx.context.delete(scanRowDescriptor);
				}
			}

			if (cleanupPreviousGroupContext) {
				cleanupPreviousGroupContext();
				cleanupPreviousGroupContext = null;
			}

			// Yield the final group if any rows were processed
			if (currentGroupKey !== null) {
				const aggregateRow: SqlValue[] = [];

				// First, add the GROUP BY values
				aggregateRow.push(...currentGroupValues);

				// Then, add the finalized aggregate values
				for (let i = 0; i < plan.aggregates.length; i++) {
					const schema = aggregateSchemas[i];

					let finalValue: SqlValue;
					if (isAggregateFunctionSchema(schema)) {
						finalValue = schema.finalizeFunction(currentAccumulators[i]);
					} else {
						finalValue = currentAccumulators[i];
					}

					aggregateRow.push(finalValue);
				}

				// Build combined row with aggregate results + representative source row
				const fullRow = currentSourceRow ? [...aggregateRow, ...currentSourceRow] : aggregateRow;

				// Set up context for final group with correct source row
				if (currentSourceRow) {
					ctx.context.set(scanRowDescriptor, () => currentSourceRow);
					logContextPush(scanRowDescriptor, 'final-group-rep-row');
				}
				ctx.context.set(combinedRowDescriptor, () => fullRow);
				logContextPush(combinedRowDescriptor, 'final-output-row');
				if (currentSourceRow) {
					// Use the final group's representative row for HAVING evaluation
					// Use separate descriptors to avoid conflicts with source row processing
					ctx.context.set(groupSourceRowDescriptor, () => currentSourceRow!);
					logContextPush(groupSourceRowDescriptor, 'final-source-row', sourceAttributes);
					if (sourceRelation !== plan.source) {
						ctx.context.set(groupSourceRelationRowDescriptor, () => currentSourceRow!);
						logContextPush(groupSourceRelationRowDescriptor, 'final-source-relation-row');
					}
				}

				try {
					yield aggregateRow;
				} finally {
					logContextPop(combinedRowDescriptor, 'final-output-row');
					ctx.context.delete(combinedRowDescriptor);
					if (currentSourceRow) {
						logContextPop(scanRowDescriptor, 'final-group-rep-row');
						ctx.context.delete(scanRowDescriptor);
					}
					if (currentSourceRow) {
						logContextPop(groupSourceRowDescriptor, 'final-source-row');
						ctx.context.delete(groupSourceRowDescriptor);
						if (sourceRelation !== plan.source) {
							logContextPop(groupSourceRelationRowDescriptor, 'final-source-relation-row');
							ctx.context.delete(groupSourceRelationRowDescriptor);
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
		run: run as InstructionRun,
		note: `stream_aggregate(${plan.groupBy.length > 0 ? `GROUP BY ${plan.groupBy.length}` : 'no grouping'}, ${plan.aggregates.length} aggs)`
	};
}
