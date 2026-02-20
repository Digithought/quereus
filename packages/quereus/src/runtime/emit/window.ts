import type { WindowNode } from '../../planner/nodes/window-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { OutputValue, Row, SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { resolveWindowFunction, type WindowFunctionSchema } from '../../schema/window-function.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { createTypedComparator, createOrderByComparatorFast, resolveCollation } from '../../util/comparison.js';
import type { LogicalType } from '../../types/logical-type.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type * as AST from '../../parser/ast.js';
import { createRowSlot, type RowSlot } from '../context-helpers.js';

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

	// Pre-resolve ORDER BY comparators using actual expression types (not hardcoded BINARY)
	const orderByComparators = plan.orderByExpressions.map((exprPlan, i) => {
		const exprType = exprPlan.getType();
		const collationName = exprType.collationName || 'BINARY';
		const collationFunc = resolveCollation(collationName);
		const orderClause = plan.windowSpec.orderBy[i];
		return createOrderByComparatorFast(orderClause.direction, orderClause.nulls, collationFunc);
	});

	// Pre-resolve typed equality comparators for ORDER BY (used in ranking functions)
	const orderByEqualityComparators = plan.orderByExpressions.map(exprPlan => {
		const exprType = exprPlan.getType();
		const collationFunc = exprType.collationName ? resolveCollation(exprType.collationName) : undefined;
		return createTypedComparator(exprType.logicalType as LogicalType, collationFunc);
	});

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

		// Single source slot shared across all partition/sort/ranking/aggregate operations
		const sourceSlot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			if (plan.windowSpec.partitionBy.length === 0) {
				// No partitioning - process as single partition
				yield* processPartition(
					allRows, plan, functionSchemas, rctx,
					sourceRowDescriptor,
					partitionCallbackList, orderByCallbackList, funcArgCallbackList,
					sourceSlot, orderByComparators, orderByEqualityComparators
				);
			} else {
				// With partitioning - group by partition keys
				const partitions = await groupByPartitions(
					allRows, partitionCallbackList, rctx, sourceSlot
				);

				for (const partitionRows of partitions.values()) {
					yield* processPartition(
						partitionRows, plan, functionSchemas, rctx,
						sourceRowDescriptor,
						partitionCallbackList, orderByCallbackList, funcArgCallbackList,
						sourceSlot, orderByComparators, orderByEqualityComparators
					);
				}
			}
		} finally {
			sourceSlot.close();
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
	sourceSlot: RowSlot
): Promise<Map<string, Row[]>> {
	const partitions = new Map<string, Row[]>();

	for (const row of rows) {
		sourceSlot.set(row);
		const partitionValues = await Promise.all(partitionCallbacks.map(callback =>
			callback(rctx)
		));
		const partitionKey = JSON.stringify(partitionValues);

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
	functionSchemas: WindowFunctionSchema[],
	rctx: RuntimeContext,
	sourceRowDescriptor: RowDescriptor,
	partitionCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	orderByCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	funcArgCallbacks: Array<(ctx: RuntimeContext) => OutputValue | null>,
	sourceSlot: RowSlot,
	preResolvedOrderByComparators: Array<(a: SqlValue, b: SqlValue) => number>,
	preResolvedEqualityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): AsyncIterable<Row> {
	// Sort rows according to ORDER BY specification
	const sortedRows = await sortRows(
		partitionRows, plan.windowSpec.orderBy, orderByCallbacks,
		rctx, sourceSlot, preResolvedOrderByComparators
	);

	// Process each row in the sorted partition
	for (let currentIndex = 0; currentIndex < sortedRows.length; currentIndex++) {
		const currentRow = sortedRows[currentIndex];
		const outputRow = [...currentRow];

		// Set source context for current row
		sourceSlot.set(currentRow);

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
					orderByCallbacks, rctx, sourceSlot, preResolvedEqualityComparators
				);
			} else if (schema.kind === 'aggregate') {
				value = await computeAggregateFunction(
					schema, argCallback, sortedRows, currentIndex,
					plan.windowSpec.frame, plan.windowSpec.orderBy.length > 0,
					rctx, sourceSlot
				);
			} else {
				throw new QuereusError(
					`Window function type ${schema.kind} not yet implemented`,
					StatusCode.UNSUPPORTED
				);
			}

			// Restore current row context after helper may have changed it
			sourceSlot.set(currentRow);
			values.push(value);
		}

		// Add computed values to output row
		outputRow.push(...values);

		yield outputRow as Row;
	}
}

async function sortRows(
	rows: Row[],
	orderBy: AST.OrderByClause[],
	orderByCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot,
	preResolvedComparators: Array<(a: SqlValue, b: SqlValue) => number>
): Promise<Row[]> {
	if (orderBy.length === 0) {
		return rows; // No sorting needed
	}

	// Use pre-resolved comparators (with correct collations from expression types)
	const orderByComparators = preResolvedComparators;

	// Pre-evaluate ORDER BY values for all rows to avoid async in sort
	const rowsWithValues = await Promise.all(rows.map(async (row) => {
		sourceSlot.set(row);
		const values = await Promise.all(orderByCallbacks.map(async (callback) => {
			const result = callback(rctx);
			return await Promise.resolve(result);
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
	sourceSlot: RowSlot,
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
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
					prevRow, currentRow, orderByCallbacks, rctx, sourceSlot, equalityComparators
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
					prevRow, currentRow, orderByCallbacks, rctx, sourceSlot, equalityComparators
				))) {
					// Create a key for this distinct set of ORDER BY values
					const key = await getOrderByKey(prevRow, orderByCallbacks, rctx, sourceSlot);
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
	schema: WindowFunctionSchema,
	argCallback: ((ctx: RuntimeContext) => OutputValue) | null,
	sortedRows: Row[],
	currentIndex: number,
	frame: AST.WindowFrame | undefined,
	hasOrderBy: boolean,
	rctx: RuntimeContext,
	sourceSlot: RowSlot
): Promise<SqlValue> {
	const frameBounds = getFrameBounds(frame, sortedRows.length, currentIndex, hasOrderBy);

	let accumulator: SqlValue = null;
	let rowCount = 0;

	// Process rows within the frame
	for (let i = frameBounds.start; i <= frameBounds.end; i++) {
		const frameRow = sortedRows[i];
		sourceSlot.set(frameRow);

		let argValue: SqlValue = null;

		// Get argument value if callback exists
		if (argCallback) {
			argValue = await Promise.resolve(argCallback(rctx)) as SqlValue;
		}

		// Apply aggregate step function
		if (schema.step) {
			accumulator = schema.step(accumulator, argValue);
			rowCount++;
		}
	}

	// Apply final function
	return schema.final ? schema.final(accumulator, rowCount) : accumulator;
}

function getFrameBounds(
	frame: AST.WindowFrame | undefined,
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
		const offset = getFrameOffset(frame.start.value);
		start = Math.max(0, currentIndex - offset);
	} else if (frame.start.type === 'following') {
		const offset = getFrameOffset(frame.start.value);
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
		const offset = getFrameOffset(frame.end.value);
		end = Math.max(0, currentIndex - offset);
	} else if (frame.end.type === 'following') {
		const offset = getFrameOffset(frame.end.value);
		end = Math.min(totalRows - 1, currentIndex + offset);
	} else {
		end = currentIndex;
	}

	// Empty frame when bounds invert
	if (start > end) {
		return { start: currentIndex + 1, end: currentIndex };
	}

	return { start, end };
}

function getFrameOffset(expr: AST.Expression): number {
	// SQL grammar for frame offsets is typically an unsigned integer literal.
	// Quereus currently supports literal numeric offsets and unary +/- on literals.
	const value = tryExtractNumericLiteral(expr);
	if (value === undefined) {
		throw new QuereusError(
			'Window frame offsets must be constant numeric literals',
			StatusCode.UNSUPPORTED
		);
	}

	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new QuereusError(
			`Invalid window frame offset: ${value}. Must be a non-negative integer.`,
			StatusCode.ERROR
		);
	}

	return value;
}

function tryExtractNumericLiteral(expr: AST.Expression): number | undefined {
	if (expr.type === 'literal') {
		const v = expr.value;
		if (typeof v === 'number') return v;
		if (typeof v === 'bigint') return Number(v);
		return undefined;
	}

	if (expr.type === 'unary' && (expr.operator === '+' || expr.operator === '-')) {
		const inner = tryExtractNumericLiteral(expr.expr);
		if (inner === undefined) return undefined;
		return expr.operator === '-' ? -inner : inner;
	}

	return undefined;
}

async function areRowsEqualInOrderBy(
	rowA: Row,
	rowB: Row,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot,
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): Promise<boolean> {
	for (let i = 0; i < orderByCallbacks.length; i++) {
		const callback = orderByCallbacks[i];
		// Get value for row A
		sourceSlot.set(rowA);
		const valueA = await Promise.resolve(callback(rctx));

		// Get value for row B
		sourceSlot.set(rowB);
		const valueB = await Promise.resolve(callback(rctx));

		// If any ORDER BY expression differs, rows are not equal (using pre-resolved typed comparator)
		if (equalityComparators[i](valueA, valueB) !== 0) {
			return false;
		}
	}

	return true; // All ORDER BY expressions are equal
}

async function getOrderByKey(
	row: Row,
	orderByCallbacks: Array<(ctx: RuntimeContext) => any>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot
): Promise<string> {
	sourceSlot.set(row);
	const values = await Promise.all(orderByCallbacks.map(callback =>
		Promise.resolve(callback(rctx))
	));
	return values.map(val => val === null ? 'NULL' : String(val)).join('|');
}
