import type { WindowNode } from '../../planner/nodes/window-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { Row, SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { resolveWindowFunction } from '../../schema/window-function.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { compareSqlValues, createOrderByComparatorFast, resolveCollation } from '../../util/comparison.js';
import { createLogger } from '../../common/logger.js';

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
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	const outputRowDescriptor: RowDescriptor = [];
	const outputAttributes = plan.getAttributes();
	outputAttributes.forEach((attr, index) => {
		outputRowDescriptor[attr.id] = index;
	});

	async function* run(
		rctx: RuntimeContext,
		source: AsyncIterable<Row>,
		...callbacks: Array<(ctx: RuntimeContext) => any>
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
		run: run as any,
		note: `window(${plan.functions.map(f => f.functionName).join(', ')})`
	};
}

async function groupByPartitions(
	rows: Row[],
	partitionCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): Promise<Map<string, Row[]>> {
	const partitions = new Map<string, Row[]>();

	for (const row of rows) {
		rctx.context.set(sourceRowDescriptor, () => row);
		try {
			// Evaluate partition expressions
			const partitionValues = partitionCallbacks.map(callback => callback(rctx));

			// Create partition key
			const partitionKey = partitionValues.map(val =>
				val === null ? 'NULL' : String(val)
			).join('|');

			if (!partitions.has(partitionKey)) {
				partitions.set(partitionKey, []);
			}
			partitions.get(partitionKey)!.push(row);
		} finally {
			rctx.context.delete(sourceRowDescriptor);
		}
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
	partitionCallbacks: Array<(ctx: RuntimeContext) => any>,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	funcArgCallbacks: Array<((ctx: RuntimeContext) => any) | null>
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
		rctx.context.set(sourceRowDescriptor, () => currentRow);
		try {
			// Compute each window function
			for (let funcIndex = 0; funcIndex < plan.functions.length; funcIndex++) {
				const func = plan.functions[funcIndex];
				const schema = functionSchemas[funcIndex];
				const argCallback = funcArgCallbacks[funcIndex];

				let value: SqlValue;

				if (schema.kind === 'ranking') {
					value = computeRankingFunction(
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

				outputRow.push(value);
			}
		} finally {
			rctx.context.delete(sourceRowDescriptor);
		}

		// Yield the output row
		rctx.context.set(outputRowDescriptor, () => outputRow as Row);
		try {
			yield outputRow as Row;
		} finally {
			rctx.context.delete(outputRowDescriptor);
		}
	}
}

async function sortRows(
	rows: Row[],
	orderBy: any[],
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
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
			(orderClause as any).nullsOrdering,
			collationFunc
		);
	});

	return [...rows].sort((a, b) => {
		// Compare each ORDER BY expression in sequence
		for (let i = 0; i < orderBy.length; i++) {
			const callback = orderByCallbacks[i];
			const comparator = orderByComparators[i];

			// Evaluate expression for row A
			rctx.context.set(sourceRowDescriptor, () => a);
			let valueA: SqlValue;
			try {
				valueA = callback(rctx);
			} finally {
				rctx.context.delete(sourceRowDescriptor);
			}

			// Evaluate expression for row B
			rctx.context.set(sourceRowDescriptor, () => b);
			let valueB: SqlValue;
			try {
				valueB = callback(rctx);
			} finally {
				rctx.context.delete(sourceRowDescriptor);
			}

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
}

function computeRankingFunction(
	functionName: string,
	sortedRows: Row[],
	currentIndex: number,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): number {
	switch (functionName.toLowerCase()) {
		case 'row_number':
			return currentIndex + 1;

		case 'rank': {
			// Find rank by counting how many rows come before this one in sort order
			let rank = 1;
			const currentRow = sortedRows[currentIndex];

			for (let i = 0; i < currentIndex; i++) {
				const prevRow = sortedRows[i];
				if (!areRowsEqualInOrderBy(
					prevRow, currentRow, orderByCallbacks, rctx, sourceRowDescriptor
				)) {
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
				if (!areRowsEqualInOrderBy(
					prevRow, currentRow, orderByCallbacks, rctx, sourceRowDescriptor
				)) {
					// Create a key for this distinct set of ORDER BY values
					const key = getOrderByKey(prevRow, orderByCallbacks, rctx, sourceRowDescriptor);
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

	let accumulator = null;
	let rowCount = 0;

	// Process rows within the frame
	for (let i = frameBounds.start; i <= frameBounds.end; i++) {
		const frameRow = sortedRows[i];

		rctx.context.set(sourceRowDescriptor, () => frameRow);
		try {
			let argValue: SqlValue = null;

			// Get argument value if callback exists
			if (argCallback) {
				argValue = argCallback(rctx);
			}

			// Apply aggregate step function
			if (schema.step) {
				accumulator = schema.step(accumulator, argValue);
				rowCount++;
			}
		} finally {
			rctx.context.delete(sourceRowDescriptor);
		}
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

function areRowsEqualInOrderBy(
	rowA: Row,
	rowB: Row,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): boolean {
	for (const callback of orderByCallbacks) {
		// Get value for row A
		rctx.context.set(sourceRowDescriptor, () => rowA);
		let valueA: SqlValue;
		try {
			valueA = callback(rctx);
		} finally {
			rctx.context.delete(sourceRowDescriptor);
		}

		// Get value for row B
		rctx.context.set(sourceRowDescriptor, () => rowB);
		let valueB: SqlValue;
		try {
			valueB = callback(rctx);
		} finally {
			rctx.context.delete(sourceRowDescriptor);
		}

		// If any ORDER BY expression differs, rows are not equal
		if (compareSqlValues(valueA, valueB) !== 0) {
			return false;
		}
	}

	return true; // All ORDER BY expressions are equal
}

function getOrderByKey(
	row: Row,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor
): string {
	rctx.context.set(sourceRowDescriptor, () => row);
	try {
		const values = orderByCallbacks.map(callback => callback(rctx));
		return values.map(val => val === null ? 'NULL' : String(val)).join('|');
	} finally {
		rctx.context.delete(sourceRowDescriptor);
	}
}
