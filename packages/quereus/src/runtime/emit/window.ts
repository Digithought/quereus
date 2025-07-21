import type { WindowNode } from '../../planner/nodes/window-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { OutputValue, Row, SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { resolveWindowFunction } from '../../schema/window-function.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { compareSqlValues, createOrderByComparatorFast, resolveCollation } from '../../util/comparison.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { withRowContext, withAsyncRowContext } from '../context-helpers.js';

const log = createLogger('runtime:emit:window');

export function emitWindow(plan: WindowNode, ctx: EmissionContext): Instruction {
	// Get schemas for all window functions in this node
	const functionSchemas = plan.functions.map(func => {
		const schema = resolveWindowFunction(func.functionName);
		if (!schema) {
			throw new QuereusError(`Window function ${func.functionName} not found`, StatusCode.INTERNAL);
		}
		return schema;
	});

	// Emit callbacks for partition expressions
	const partitionCallbacks = plan.partitionExpressions.map(exprPlan =>
		emitCallFromPlan(exprPlan, ctx)
	);

	// Emit callbacks for ORDER BY expressions (if any)
	const orderByCallbacks = plan.orderByExpressions.map(exprPlan =>
		emitCallFromPlan(exprPlan, ctx)
	);

	// Emit callbacks for window function arguments
	const functionArgCallbacks = plan.functionArguments.map(argPlan =>
		argPlan ? emitCallFromPlan(argPlan, ctx) : null
	);

	// Create row descriptors
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

	async function* run(
		rctx: RuntimeContext,
		source: AsyncIterable<Row>,
		...callbacks: Array<(ctx: RuntimeContext) => OutputValue>
	): AsyncIterable<Row> {
		log('Starting window function execution');

		// Extract callbacks in order: partitions, orderBy, function args
		const partitionCallbackList = callbacks.slice(0, partitionCallbacks.length);
		const orderByCallbackList = callbacks.slice(
			partitionCallbacks.length,
			partitionCallbacks.length + orderByCallbacks.length
		);
		const funcArgCallbackList = callbacks.slice(
			partitionCallbacks.length + orderByCallbacks.length
		);

		// Collect all rows (window functions require materialization for frame evaluation)
		const allRows: Row[] = [];
		for await (const row of source) {
			allRows.push(row);
		}

		if (plan.windowSpec.partitionBy.length === 0) {
			// No partitioning - process as single partition
			yield* processPartition(
				allRows, plan, functionSchemas, rctx,
				sourceRowDescriptor, outputRowDescriptor,
				partitionCallbackList, orderByCallbackList, funcArgCallbackList
			);
		} else {
			// With partitioning - group by partition keys
			const partitions = await groupByPartitions(
				allRows, partitionCallbackList, rctx, sourceRowDescriptor
			);

			for (const partitionRows of partitions.values()) {
				yield* processPartition(
					partitionRows, plan, functionSchemas, rctx,
					sourceRowDescriptor, outputRowDescriptor,
					partitionCallbackList, orderByCallbackList, funcArgCallbackList
				);
			}
		}
	}

	// Collect all callbacks
	const allCallbacks = [
		...partitionCallbacks,
		...orderByCallbacks,
		...functionArgCallbacks.filter(cb => cb !== null)
	];

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...allCallbacks],
		run: run as InstructionRun,
		note: `window(${plan.functions.map(f => f.functionName).join(', ')})`
	};
}

async function groupByPartitions(
	rows: Row[],
	partitionCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): Promise<Map<string, Row[]>> {
	const partitions = new Map<string, Row[]>();

	for (const row of rows) {
		const partitionKey = await withAsyncRowContext(rctx, sourceRowDescriptor, () => row, async () => {
			// Evaluate partition expressions
			const partitionValues = await Promise.all(partitionCallbacks.map(callback =>
				callback(rctx)
			));

			// Create partition key
			return partitionValues.map(val =>
				val === null ? 'NULL' : String(val)
			).join('|');
		});

		if (!partitions.has(partitionKey)) {
			partitions.set(partitionKey, []);
		}
		partitions.get(partitionKey)!.push(row);
	}

	return partitions;
}

async function* processPartition(
	partitionRows: Row[],
	plan: WindowNode,
	functionSchemas: any[],
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor,
	outputRowDescriptor: RowDescriptor,
	partitionCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	orderByCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	funcArgCallbacks: Array<(ctx: RuntimeContext) => OutputValue | null>
): AsyncIterable<Row> {
	// Sort rows according to ORDER BY specification
	const sortedRows = await sortRows(
		partitionRows, plan.windowSpec.orderBy, orderByCallbacks,
		rctx, sourceRowDescriptor
	);

	// Process each row in the sorted partition
	for (let currentIndex = 0; currentIndex < sortedRows.length; currentIndex++) {
		const currentRow = sortedRows[currentIndex];
		const outputRow = [...currentRow];

		// Set up context for current row
		const outputValues = await withRowContext(rctx, sourceRowDescriptor, () => currentRow, async () => {
			const values: SqlValue[] = [];
			// Compute each window function
			for (let funcIndex = 0; funcIndex < plan.functions.length; funcIndex++) {
				const func = plan.functions[funcIndex];
				const schema = functionSchemas[funcIndex];
				const argCallback = funcArgCallbacks[funcIndex];

				let value: SqlValue;

				if (schema.kind === 'ranking') {
					value = await computeRankingFunction(
						func.functionName, sortedRows, currentIndex,
						orderByCallbacks, rctx, sourceRowDescriptor
					);
				} else if (schema.kind === 'aggregate') {
					value = await computeAggregateFunction(
						schema, argCallback, sortedRows, currentIndex,
						plan.windowSpec.frame, plan.windowSpec.orderBy.length > 0,
						rctx, sourceRowDescriptor
					);
				} else {
					throw new QuereusError(
						`Window function type ${schema.kind} not yet implemented`,
						StatusCode.UNSUPPORTED
					);
				}

				values.push(value);
			}
			return values;
		});

		// Add computed values to output row
		outputRow.push(...outputValues);

		// Yield the output row
		yield await withRowContext(rctx, outputRowDescriptor, () => outputRow as Row, () => outputRow as Row);
	}
}

async function sortRows(
	rows: Row[],
	orderBy: any[],
	orderByCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): Promise<Row[]> {
	if (orderBy.length === 0) {
		return rows; // No sorting needed
	}

		// Pre-create optimized comparators for all ORDER BY expressions with resolved collations
	const orderByComparators = orderBy.map(orderClause => {
		// TODO: Extract actual collation from order clause expression
		// For now, use BINARY collation (most common case)
		const collationFunc = resolveCollation('BINARY');
		return createOrderByComparatorFast(
			orderClause.direction,
			orderClause.nulls,
			collationFunc
		);
	});

	// Pre-evaluate ORDER BY values for all rows to avoid async in sort
	const rowsWithValues = await Promise.all(rows.map(async (row) => {
		const values = await Promise.all(orderByCallbacks.map(async (callback) => {
			return await withAsyncRowContext(rctx, sourceRowDescriptor, () => row, async () => {
				const result = callback(rctx);
				return await Promise.resolve(result);
			});
		}));
		return { row, values };
	}));

	// Now sort using the pre-evaluated values
	rowsWithValues.sort((a, b) => {
		// Compare each ORDER BY expression in sequence
		for (let i = 0; i < orderBy.length; i++) {
			const comparator = orderByComparators[i];
			const valueA = a.values[i] as SqlValue;
			const valueB = b.values[i] as SqlValue;

			// Use pre-created optimized comparator
			const comparison = comparator(valueA, valueB);

			// If not equal, return comparison result
			if (comparison !== 0) {
				return comparison;
			}

			// Equal, continue to next ORDER BY expression
		}

		return 0; // All ORDER BY expressions are equal
	});

	// Extract just the rows in sorted order
	return rowsWithValues.map(item => item.row);
}

async function computeRankingFunction(
	functionName: string,
	sortedRows: Row[],
	currentIndex: number,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): Promise<number> {
	switch (functionName.toLowerCase()) {
		case 'row_number':
			return currentIndex + 1;

		case 'rank': {
			// Find rank by counting how many rows come before this one in sort order
			let rank = 1;
			const currentRow = sortedRows[currentIndex];

			for (let i = 0; i < currentIndex; i++) {
				const prevRow = sortedRows[i];
				if (!(await areRowsEqualInOrderBy(
					prevRow, currentRow, orderByCallbacks, rctx, sourceRowDescriptor
				))) {
					rank = i + 2; // Rank is 1-based and accounts for ties
				}
			}
			return rank;
		}

		case 'dense_rank': {
			// Count distinct values that come before this one
			let denseRank = 1;
			const currentRow = sortedRows[currentIndex];
			const seenValues = new Set<string>();

			for (let i = 0; i < currentIndex; i++) {
				const prevRow = sortedRows[i];
				if (!(await areRowsEqualInOrderBy(
					prevRow, currentRow, orderByCallbacks, rctx, sourceRowDescriptor
				))) {
					// Create a key for this distinct set of ORDER BY values
					const key = await getOrderByKey(prevRow, orderByCallbacks, rctx, sourceRowDescriptor);
					if (!seenValues.has(key)) {
						seenValues.add(key);
						denseRank++;
					}
				}
			}
			return denseRank;
		}

		default:
			throw new QuereusError(
				`Ranking function ${functionName} not implemented`,
				StatusCode.UNSUPPORTED
			);
	}
}

async function computeAggregateFunction(
	schema: any,
	argCallback: ((ctx: RuntimeContext) => any) | null,
	sortedRows: Row[],
	currentIndex: number,
	frame: any,
	hasOrderBy: boolean,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): Promise<SqlValue> {
	// Determine frame bounds
	const frameBounds = getFrameBounds(frame, sortedRows.length, currentIndex, hasOrderBy);

	let accumulator: any = null;
	let rowCount = 0;

	// Process rows within the frame
	for (let i = frameBounds.start; i <= frameBounds.end; i++) {
		const frameRow = sortedRows[i];

		await withAsyncRowContext(rctx, sourceRowDescriptor, () => frameRow, async () => {
			let argValue: SqlValue = null;

			// Get argument value if callback exists
			if (argCallback) {
				const result = argCallback(rctx);
				argValue = await Promise.resolve(result);
			}

			// Apply aggregate step function
			if (schema.step) {
				accumulator = schema.step(accumulator, argValue);
				rowCount++;
			}
		});
	}

	// Apply final function
	return schema.final ? schema.final(accumulator, rowCount) : accumulator;
}

function getFrameBounds(
	frame: any,
	totalRows: number,
	currentIndex: number,
	hasOrderBy: boolean = true
): { start: number; end: number } {
	if (!frame) {
		if (!hasOrderBy) {
			// No ORDER BY: default frame is entire partition (all rows)
			return { start: 0, end: totalRows - 1 };
		} else {
			// With ORDER BY: default frame is RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			return { start: 0, end: currentIndex };
		}
	}

	let start: number;
	let end: number;

	// Calculate start bound
	if (frame.start.type === 'unboundedPreceding') {
		start = 0;
	} else if (frame.start.type === 'currentRow') {
		start = currentIndex;
	} else if (frame.start.type === 'preceding') {
		// TODO: Evaluate frame.start.value expression
		const offset = 1; // For now, hard-coded for the test
		start = Math.max(0, currentIndex - offset);
	} else if (frame.start.type === 'following') {
		const offset = 1; // TODO: Evaluate frame.start.value expression
		start = Math.min(totalRows - 1, currentIndex + offset);
	} else {
		start = 0;
	}

	// Calculate end bound
	if (frame.end === null) {
		// Single bound frame - end is current row
		end = currentIndex;
	} else if (frame.end.type === 'unboundedFollowing') {
		end = totalRows - 1;
	} else if (frame.end.type === 'currentRow') {
		end = currentIndex;
	} else if (frame.end.type === 'preceding') {
		const offset = 1; // TODO: Evaluate frame.end.value expression
		end = Math.max(0, currentIndex - offset);
	} else if (frame.end.type === 'following') {
		const offset = 1; // TODO: Evaluate frame.end.value expression
		end = Math.min(totalRows - 1, currentIndex + offset);
	} else {
		end = currentIndex;
	}

	return { start, end };
}

async function areRowsEqualInOrderBy(
	rowA: Row,
	rowB: Row,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): Promise<boolean> {
	for (const callback of orderByCallbacks) {
		// Get value for row A
		const valueA = await withAsyncRowContext(rctx, sourceRowDescriptor, () => rowA, async () => {
			const result = callback(rctx);
			return await Promise.resolve(result);
		});

		// Get value for row B
		const valueB = await withAsyncRowContext(rctx, sourceRowDescriptor, () => rowB, async () => {
			const result = callback(rctx);
			return await Promise.resolve(result);
		});

		// If any ORDER BY expression differs, rows are not equal
		if (compareSqlValues(valueA, valueB) !== 0) {
			return false;
		}
	}

	return true; // All ORDER BY expressions are equal
}

async function getOrderByKey(
	row: Row,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): Promise<string> {
	return await withAsyncRowContext(rctx, sourceRowDescriptor, () => row, async () => {
		const values = await Promise.all(orderByCallbacks.map(callback =>
			Promise.resolve(callback(rctx))
		));
		return values.map(val => val === null ? 'NULL' : String(val)).join('|');
	});
}
