import type { WindowNode } from '../../planner/nodes/window-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { OutputValue, Row, SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { resolveWindowFunction, type WindowFunctionSchema } from '../../schema/window-function.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { createTypedComparator, createOrderByComparatorFast } from '../../util/comparison.js';
import type { LogicalType } from '../../types/logical-type.js';
import { resolveKeyNormalizer, serializeKeyNullGrouping } from '../../util/key-serializer.js';
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

	// Emit callbacks for window function arguments (2D: per-function arrays)
	const functionArgCallbacks = plan.functionArguments.map(argPlans =>
		argPlans.map(argPlan => emitCallFromPlan(argPlan, ctx))
	);
	// Track per-function arg counts for callback reconstruction in run()
	const functionArgCounts = plan.functionArguments.map(args => args.length);

	// Create row descriptors
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());

	// Pre-resolve ORDER BY comparators using actual expression types (not hardcoded BINARY)
	const orderByComparators = plan.orderByExpressions.map((exprPlan, i) => {
		const exprType = exprPlan.getType();
		const collationName = exprType.collationName || 'BINARY';
		const collationFunc = ctx.resolveCollation(collationName);
		const orderClause = plan.windowSpec.orderBy[i];
		return createOrderByComparatorFast(orderClause.direction, orderClause.nulls, collationFunc);
	});

	// Pre-resolve typed equality comparators for ORDER BY (used in ranking functions)
	const orderByEqualityComparators = plan.orderByExpressions.map(exprPlan => {
		const exprType = exprPlan.getType();
		const collationFunc = exprType.collationName ? ctx.resolveCollation(exprType.collationName) : undefined;
		return createTypedComparator(exprType.logicalType as LogicalType, collationFunc);
	});

	// Pre-resolve collation normalizers for partition key serialization
	const partitionKeyNormalizers = plan.partitionExpressions.map(exprPlan =>
		resolveKeyNormalizer(exprPlan.getType().collationName)
	);

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
		// Reconstruct per-function arg callback arrays from flattened list
		const funcArgCallbackGroups: Array<(ctx: RuntimeContext) => OutputValue>[] = [];
		let argOffset = partitionCallbacks.length + orderByCallbacks.length;
		for (const count of functionArgCounts) {
			funcArgCallbackGroups.push(callbacks.slice(argOffset, argOffset + count));
			argOffset += count;
		}

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
					partitionCallbackList, orderByCallbackList, funcArgCallbackGroups,
					sourceSlot, orderByComparators, orderByEqualityComparators
				);
			} else {
				// With partitioning - group by partition keys
				const partitions = await groupByPartitions(
					allRows, partitionCallbackList, rctx, sourceSlot, partitionKeyNormalizers
				);

				for (const partitionRows of partitions.values()) {
					yield* processPartition(
						partitionRows, plan, functionSchemas, rctx,
						sourceRowDescriptor,
						partitionCallbackList, orderByCallbackList, funcArgCallbackGroups,
						sourceSlot, orderByComparators, orderByEqualityComparators
					);
				}
			}
		} finally {
			sourceSlot.close();
		}
	}

	// Collect all callbacks (flatten per-function arg arrays)
	const allCallbacks = [
		...partitionCallbacks,
		...orderByCallbacks,
		...functionArgCallbacks.flat()
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
	sourceSlot: RowSlot,
	keyNormalizers: readonly ((s: string) => string)[]
): Promise<Map<string, Row[]>> {
	const partitions = new Map<string, Row[]>();

	for (const row of rows) {
		sourceSlot.set(row);
		const partitionValues = await Promise.all(partitionCallbacks.map(callback =>
			callback(rctx)
		));
		const partitionKey = serializeKeyNullGrouping(partitionValues as SqlValue[], keyNormalizers);

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
	_sourceRowDescriptor: RowDescriptor,
	_partitionCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	orderByCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	funcArgCallbackGroups: Array<Array<(ctx: RuntimeContext) => OutputValue>>,
	sourceSlot: RowSlot,
	preResolvedOrderByComparators: Array<(a: SqlValue, b: SqlValue) => number>,
	preResolvedEqualityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): AsyncIterable<Row> {
	// Sort rows according to ORDER BY specification
	const sorted = await sortRows(
		partitionRows, plan.windowSpec.orderBy, orderByCallbacks,
		rctx, sourceSlot, preResolvedOrderByComparators
	);
	const sortedRows = sorted.rows;
	const orderByValues = sorted.orderByValues;

	const partitionSize = sortedRows.length;

	// Pre-compute ranking values in a single O(n) pass using cached orderByValues
	const rankings = precomputeRankings(partitionSize, orderByValues, preResolvedEqualityComparators);

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
			const argCallbacks = funcArgCallbackGroups[funcIndex];

			let value: SqlValue;

			if (schema.kind === 'ranking') {
				value = await computeRankingFunction(
					func.functionName, currentIndex, partitionSize,
					rankings, argCallbacks, rctx
				);
			} else if (schema.kind === 'aggregate') {
				value = await computeAggregateFunction(
					schema, argCallbacks[0] ?? null, sortedRows, currentIndex,
					plan.windowSpec.frame, plan.windowSpec.orderBy.length > 0,
					orderByValues, preResolvedEqualityComparators,
					rctx, sourceSlot
				);
			} else if (schema.kind === 'navigation') {
				value = await computeNavigationFunction(
					func.functionName, sortedRows, currentIndex,
					argCallbacks, rctx, sourceSlot
				);
			} else if (schema.kind === 'value') {
				value = await computeValueFunction(
					func.functionName, sortedRows, currentIndex,
					argCallbacks, plan.windowSpec.frame,
					plan.windowSpec.orderBy.length > 0,
					orderByValues, preResolvedEqualityComparators,
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

/** Result of sorting rows, including pre-evaluated ORDER BY values */
interface SortedPartition {
	rows: Row[];
	/** ORDER BY values for each row (one array of values per row). Empty if no ORDER BY. */
	orderByValues: SqlValue[][];
}

async function sortRows(
	rows: Row[],
	orderBy: AST.OrderByClause[],
	orderByCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot,
	preResolvedComparators: Array<(a: SqlValue, b: SqlValue) => number>
): Promise<SortedPartition> {
	if (orderBy.length === 0) {
		return { rows, orderByValues: rows.map(() => []) };
	}

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
			const comparator = preResolvedComparators[i];
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

	return {
		rows: rowsWithValues.map(item => item.row),
		orderByValues: rowsWithValues.map(item => item.values as SqlValue[])
	};
}

/** Pre-computed ranking values for all rows in a partition (O(n) single pass) */
interface PrecomputedRankings {
	rank: number[];
	denseRank: number[];
	percentRank: number[];
	cumeDist: number[];
}

/** Single O(n) pass over sorted rows to compute all ranking values */
function precomputeRankings(
	partitionSize: number,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): PrecomputedRankings {
	const rank = new Array<number>(partitionSize);
	const denseRank = new Array<number>(partitionSize);
	const percentRank = new Array<number>(partitionSize);
	const cumeDist = new Array<number>(partitionSize);

	let denseRankCounter = 0;
	let i = 0;

	while (i < partitionSize) {
		// Find the end of the current peer group
		let j = i;
		while (j + 1 < partitionSize && arePeerRows(orderByValues[j + 1], orderByValues[i], equalityComparators)) {
			j++;
		}

		denseRankCounter++;
		const rankValue = i + 1;
		const cumeDistValue = (j + 1) / partitionSize;
		const percentRankValue = partitionSize <= 1 ? 0 : (rankValue - 1) / (partitionSize - 1);

		for (let k = i; k <= j; k++) {
			rank[k] = rankValue;
			denseRank[k] = denseRankCounter;
			percentRank[k] = percentRankValue;
			cumeDist[k] = cumeDistValue;
		}

		i = j + 1;
	}

	return { rank, denseRank, percentRank, cumeDist };
}

async function computeRankingFunction(
	functionName: string,
	currentIndex: number,
	partitionSize: number,
	rankings: PrecomputedRankings,
	argCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext
): Promise<number> {
	switch (functionName.toLowerCase()) {
		case 'row_number':
			return currentIndex + 1;

		case 'rank':
			return rankings.rank[currentIndex];

		case 'dense_rank':
			return rankings.denseRank[currentIndex];

		case 'percent_rank':
			return rankings.percentRank[currentIndex];

		case 'cume_dist':
			return rankings.cumeDist[currentIndex];

		case 'ntile': {
			// Evaluate the bucket count argument
			const nValue = argCallbacks.length > 0
				? await Promise.resolve(argCallbacks[0](rctx)) as SqlValue
				: 1;
			const n = Number(nValue) || 1;
			if (n <= 0) return 1;

			// Divide partition into n roughly equal groups
			const q = Math.floor(partitionSize / n);
			const r = partitionSize % n;
			// First r groups have (q+1) rows, remaining have q rows
			if (currentIndex < r * (q + 1)) {
				return Math.floor(currentIndex / (q + 1)) + 1;
			} else {
				return r + Math.floor((currentIndex - r * (q + 1)) / q) + 1;
			}
		}

		default:
			throw new QuereusError(
				`Ranking function ${functionName} not implemented`,
				StatusCode.UNSUPPORTED
			);
	}
}

async function computeNavigationFunction(
	functionName: string,
	sortedRows: Row[],
	currentIndex: number,
	argCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot
): Promise<SqlValue> {
	const exprCallback = argCallbacks[0];
	if (!exprCallback) {
		throw new QuereusError(`${functionName} requires at least one argument`, StatusCode.ERROR);
	}

	// Evaluate offset (2nd arg, default 1)
	let offset = 1;
	if (argCallbacks.length >= 2) {
		const offsetValue = await Promise.resolve(argCallbacks[1](rctx));
		offset = Number(offsetValue) || 0;
	}

	// Evaluate default value (3rd arg, default null)
	let defaultValue: SqlValue = null;
	if (argCallbacks.length >= 3) {
		defaultValue = await Promise.resolve(argCallbacks[2](rctx)) as SqlValue;
	}

	const name = functionName.toLowerCase();
	const targetIndex = name === 'lag'
		? currentIndex - offset
		: currentIndex + offset; // 'lead'

	if (targetIndex < 0 || targetIndex >= sortedRows.length) {
		return defaultValue;
	}

	// Evaluate expression on the target row
	sourceSlot.set(sortedRows[targetIndex]);
	return await Promise.resolve(exprCallback(rctx)) as SqlValue;
}

async function computeValueFunction(
	functionName: string,
	sortedRows: Row[],
	currentIndex: number,
	argCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	frame: import('../../parser/ast.js').WindowFrame | undefined,
	hasOrderBy: boolean,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot
): Promise<SqlValue> {
	const exprCallback = argCallbacks[0];
	if (!exprCallback) {
		throw new QuereusError(`${functionName} requires one argument`, StatusCode.ERROR);
	}

	const frameBounds = getFrameBounds(frame, sortedRows.length, currentIndex, hasOrderBy, orderByValues, equalityComparators);
	const name = functionName.toLowerCase();

	let targetIndex: number;
	if (name === 'first_value') {
		targetIndex = frameBounds.start;
	} else {
		// last_value
		targetIndex = frameBounds.end;
	}

	// Handle empty frame
	if (targetIndex < 0 || targetIndex >= sortedRows.length || frameBounds.start > frameBounds.end) {
		return null;
	}

	sourceSlot.set(sortedRows[targetIndex]);
	return await Promise.resolve(exprCallback(rctx)) as SqlValue;
}

async function computeAggregateFunction(
	schema: WindowFunctionSchema,
	argCallback: ((ctx: RuntimeContext) => OutputValue) | null,
	sortedRows: Row[],
	currentIndex: number,
	frame: AST.WindowFrame | undefined,
	hasOrderBy: boolean,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot
): Promise<SqlValue> {
	const frameBounds = getFrameBounds(frame, sortedRows.length, currentIndex, hasOrderBy, orderByValues, equalityComparators);

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
	hasOrderBy: boolean = true,
	orderByValues: SqlValue[][] = [],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number> = []
): { start: number; end: number } {
	if (!frame) {
		if (!hasOrderBy) {
			// No ORDER BY: default frame is entire partition (all rows)
			return { start: 0, end: totalRows - 1 };
		} else {
			// With ORDER BY: default frame is RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			// In RANGE mode, CURRENT ROW means all peer rows (same ORDER BY values)
			const lastPeer = findLastPeer(currentIndex, totalRows, orderByValues, equalityComparators);
			return { start: 0, end: lastPeer };
		}
	}

	const isRange = frame.type === 'range';

	let start: number;
	let end: number;

	// Calculate start bound
	if (frame.start.type === 'unboundedPreceding') {
		start = 0;
	} else if (frame.start.type === 'currentRow') {
		start = isRange
			? findFirstPeer(currentIndex, totalRows, orderByValues, equalityComparators)
			: currentIndex;
	} else if (frame.start.type === 'preceding') {
		const offset = getFrameOffset(frame.start.value);
		if (isRange) {
			start = findRangeOffsetStart(currentIndex, totalRows, orderByValues, -offset);
		} else {
			start = currentIndex - offset;
		}
	} else if (frame.start.type === 'following') {
		const offset = getFrameOffset(frame.start.value);
		if (isRange) {
			start = findRangeOffsetStart(currentIndex, totalRows, orderByValues, offset);
		} else {
			start = currentIndex + offset;
		}
	} else {
		start = 0;
	}

	// Calculate end bound
	if (frame.end === null) {
		// Single bound frame - end is current row
		end = isRange
			? findLastPeer(currentIndex, totalRows, orderByValues, equalityComparators)
			: currentIndex;
	} else if (frame.end.type === 'unboundedFollowing') {
		end = totalRows - 1;
	} else if (frame.end.type === 'currentRow') {
		end = isRange
			? findLastPeer(currentIndex, totalRows, orderByValues, equalityComparators)
			: currentIndex;
	} else if (frame.end.type === 'preceding') {
		const offset = getFrameOffset(frame.end.value);
		if (isRange) {
			end = findRangeOffsetEnd(currentIndex, totalRows, orderByValues, -offset);
		} else {
			end = currentIndex - offset;
		}
	} else if (frame.end.type === 'following') {
		const offset = getFrameOffset(frame.end.value);
		if (isRange) {
			end = findRangeOffsetEnd(currentIndex, totalRows, orderByValues, offset);
		} else {
			end = currentIndex + offset;
		}
	} else {
		end = currentIndex;
	}

	// For ROWS mode, clamp to valid row indices after computing logical bounds.
	// Clamping must happen after both bounds are computed so that frames
	// entirely outside [0, totalRows-1] are detected as empty by the check below.
	if (!isRange) {
		start = Math.max(0, start);
		end = Math.min(totalRows - 1, end);
	}

	// Empty frame when bounds invert
	if (start > end) {
		return { start: currentIndex + 1, end: currentIndex };
	}

	return { start, end };
}

/** Find the first row in the peer group (rows with same ORDER BY values) */
function findFirstPeer(
	currentIndex: number,
	_totalRows: number,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): number {
	const currentVals = orderByValues[currentIndex];
	let first = currentIndex;
	while (first > 0 && arePeerRows(orderByValues[first - 1], currentVals, equalityComparators)) {
		first--;
	}
	return first;
}

/** Find the last row in the peer group */
function findLastPeer(
	currentIndex: number,
	totalRows: number,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): number {
	const currentVals = orderByValues[currentIndex];
	let last = currentIndex;
	while (last < totalRows - 1 && arePeerRows(orderByValues[last + 1], currentVals, equalityComparators)) {
		last++;
	}
	return last;
}

/** Check if two rows have equal ORDER BY values */
function arePeerRows(
	valsA: SqlValue[],
	valsB: SqlValue[],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): boolean {
	for (let i = 0; i < equalityComparators.length; i++) {
		if (equalityComparators[i](valsA[i], valsB[i]) !== 0) return false;
	}
	return true;
}

/**
 * For RANGE N PRECEDING/FOLLOWING: find the first row whose ORDER BY value
 * is >= (currentValue + offset). Uses the first ORDER BY expression only
 * (SQL standard requires single ORDER BY for numeric RANGE offsets).
 */
function findRangeOffsetStart(
	currentIndex: number,
	totalRows: number,
	orderByValues: SqlValue[][],
	offset: number // negative for PRECEDING, positive for FOLLOWING
): number {
	const currentVal = Number(orderByValues[currentIndex][0]);
	if (!Number.isFinite(currentVal)) return currentIndex;
	const targetVal = currentVal + offset;

	// Scan from beginning to find first row >= targetVal
	for (let i = 0; i < totalRows; i++) {
		const rowVal = Number(orderByValues[i][0]);
		if (Number.isFinite(rowVal) && rowVal >= targetVal) {
			return i;
		}
	}
	return totalRows; // No matching row (empty frame start)
}

/**
 * For RANGE N PRECEDING/FOLLOWING: find the last row whose ORDER BY value
 * is <= (currentValue + offset).
 */
function findRangeOffsetEnd(
	currentIndex: number,
	totalRows: number,
	orderByValues: SqlValue[][],
	offset: number
): number {
	const currentVal = Number(orderByValues[currentIndex][0]);
	if (!Number.isFinite(currentVal)) return currentIndex;
	const targetVal = currentVal + offset;

	// Scan from end to find last row <= targetVal
	for (let i = totalRows - 1; i >= 0; i--) {
		const rowVal = Number(orderByValues[i][0]);
		if (Number.isFinite(rowVal) && rowVal <= targetVal) {
			return i;
		}
	}
	return -1; // No matching row (empty frame end)
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

