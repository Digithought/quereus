import type { Compiler } from './compiler';
import type * as AST from '../parser/ast';
import type { ColumnSchema } from '../schema/column';
import type { P4SortKey } from '../vdbe/instruction';
import { createDefaultColumnSchema } from '../schema/column';
import { SqlDataType } from '../common/types';
import { expressionToString } from '../util/ddl-stringify';
import { SqliteError } from '../common/errors';
import { StatusCode } from '../common/constants';
import { getExpressionAffinity } from './utils'; // Assuming this helper exists or can be created

/** Information about the sorter used for window functions */
export interface WindowSorterInfo {
	/** Cursor index for the ephemeral sorter table */
	cursor: number;
	/** Schema of the ephemeral sorter table */
	// schema: TableSchema; // TODO: Define TableSchema properly for ephemeral tables
	schema: { name: string; type: 'ephemeral'; columns: ColumnSchema[] }; // Placeholder type
	/** P4 operand for ConfigureSorter */
	sortKeyP4: P4SortKey;
	/** Number of partition keys (the initial segment of sortKeyP4.keyIndices) */
	numPartitionKeys: number;
	/** Base register for data to be inserted into the sorter */
	dataBaseReg: number;
	/** Maps original expressions (as strings) to their index in the sorter schema */
	exprToSorterIndex: Map<string, number>;
	/** Maps window function AST nodes to the sorter index holding their result and the result register */
	windowResultPlaceholders: Map<AST.WindowFunctionExpr, { sorterIndex: number; resultReg: number }>;
	/** Maps sorter column index back to the original expression (for non-placeholder columns) */
	indexToExpression: Map<number, AST.Expression>;
}

/**
 * Analyzes window functions and SELECT list to set up an ephemeral sorter.
 * Determines required columns, allocates cursor/registers, and builds the sort key.
 */
export function setupWindowSorter(compiler: Compiler, stmt: AST.SelectStmt): WindowSorterInfo {
	// Extract window functions from the SELECT list
	const allWindowFunctions: AST.WindowFunctionExpr[] = [];
	stmt.columns.forEach(col => {
		if (col.type === 'column' && col.expr?.type === 'windowFunction') {
			allWindowFunctions.push(col.expr);
		}
	});

	if (allWindowFunctions.length === 0) {
		throw new SqliteError("Internal error: setupWindowSorter called with no window functions found in SELECT list.", StatusCode.INTERNAL);
	}

	// --- Check for RANGE offset requirements ---
	let requiresRangeOffsetCheck = false;
	let rangeFrameDef: AST.WindowFrame | undefined | null = undefined;
	for (const winExpr of allWindowFunctions) {
		const windowDef = winExpr.window;
		if (windowDef && windowDef.frame && windowDef.frame.type === 'range') {
			rangeFrameDef = windowDef.frame;
			if ((rangeFrameDef.start.type === 'preceding' || rangeFrameDef.start.type === 'following') && (rangeFrameDef.start as any).value) {
				requiresRangeOffsetCheck = true;
				break;
			}
			if (rangeFrameDef.end && (rangeFrameDef.end.type === 'preceding' || rangeFrameDef.end.type === 'following') && (rangeFrameDef.end as any).value) {
				requiresRangeOffsetCheck = true;
				break;
			}
		}
	}

	const firstWindowDef = allWindowFunctions[0].window;
	const orderByClause = firstWindowDef?.orderBy;

	if (requiresRangeOffsetCheck) {
		if (!orderByClause || orderByClause.length !== 1) {
			throw new SqliteError("RANGE with offset requires exactly one ORDER BY clause", StatusCode.ERROR);
		}
		const orderByExpr = orderByClause[0].expr;
		const affinity = getExpressionAffinity(compiler, orderByExpr);
		if (affinity !== SqlDataType.INTEGER && affinity !== SqlDataType.REAL && affinity !== SqlDataType.NUMERIC) {
			throw new SqliteError(`RANGE with offset requires ORDER BY clause with NUMERIC affinity (inferred: ${SqlDataType[affinity]})`, StatusCode.ERROR);
		}
	}
	// --- End check ---

	const exprToSorterIndex = new Map<string, number>();
	const windowResultPlaceholders = new Map<AST.WindowFunctionExpr, { sorterIndex: number; resultReg: number }>();
	const sorterColumns: ColumnSchema[] = [];
	const indexToExpression = new Map<number, AST.Expression>();
	const partitionKeyIndices: number[] = [];
	const orderKeyIndices: number[] = [];
	const orderKeyDirections: boolean[] = [];
	let sorterColIndex = 0;

	// Function to add an expression to the sorter schema if not already present
	const addExprToSorter = (expr: AST.Expression): number => {
		// Handle COUNT(*) and other special cases
		const key = expr.type === 'literal' && expr.value === '*' ? 'literal:*' : expressionToString(expr);
		if (!exprToSorterIndex.has(key)) {
			// Use base name from expression type, could be more specific
			const colName = `col_${sorterColIndex}_${expr.type}`;
			const colSchema = createDefaultColumnSchema(colName);
			// TODO: Attempt to infer affinity from expression?
			colSchema.affinity = SqlDataType.TEXT;
			sorterColumns.push(colSchema);
			exprToSorterIndex.set(key, sorterColIndex);
			indexToExpression.set(sorterColIndex, expr);
			sorterColIndex++;
		}
		return exprToSorterIndex.get(key)!;
	};

	// --- Step 1 & 2: Collect Partition and Order Keys --- //
	// Assumption: All window functions in a SELECT share the same PARTITION BY and ORDER BY clause.
	// We take the definition from the first window function.
	// TODO: Verify this assumption or handle variations if needed.
	if (firstWindowDef?.partitionBy) {
		firstWindowDef.partitionBy.forEach((expr: AST.Expression) => {
			const idx = addExprToSorter(expr);
			if (!partitionKeyIndices.includes(idx)) {
				partitionKeyIndices.push(idx);
			}
		});
	}

	if (firstWindowDef?.orderBy) {
		firstWindowDef.orderBy.forEach((clause: AST.OrderByClause) => {
			const idx = addExprToSorter(clause.expr);
			if (!orderKeyIndices.includes(idx)) {
				orderKeyIndices.push(idx);
				orderKeyDirections.push(clause.direction === 'desc');
			}
		});
	}

	// --- Step 3: Collect other needed values (Window Args, SELECT list items) --- //
	// Iterate through window function arguments
	allWindowFunctions.forEach((winExpr: AST.WindowFunctionExpr) => {
		if (winExpr.function.args) {
			winExpr.function.args.forEach((argExpr: AST.Expression) => {
				addExprToSorter(argExpr);
			});
		}
		// TODO: Handle FILTER clause expression if/when implemented
	});

	// Iterate through SELECT list columns
	stmt.columns.forEach(col => {
		if (col.type === 'column' && col.expr && col.expr.type !== 'windowFunction') {
			addExprToSorter(col.expr);
		}
		// Note: 'expr.*' columns are handled implicitly by the FROM clause processing
	});

	// --- Step 4: Add placeholders for window function results --- //
	allWindowFunctions.forEach((winExpr: AST.WindowFunctionExpr, i: number) => {
		// Result column name could be improved (e.g., use alias if available)
		const resultColName = `win_result_${winExpr.function.name}_${i}`;
		const resultColSchema = createDefaultColumnSchema(resultColName);
		// TODO: Infer result affinity based on the window function type?
		resultColSchema.affinity = SqlDataType.INTEGER;
		sorterColumns.push(resultColSchema);
		const resultReg = compiler.allocateMemoryCells(1);
		windowResultPlaceholders.set(winExpr, { sorterIndex: sorterColIndex, resultReg });
		sorterColIndex++;
	});

	// --- Step 5: Build P4SortKey --- //
	// Sort order: Partition keys first (always ASC for grouping), then Order keys
	const sortKeyP4: P4SortKey = {
		type: 'sortkey',
		keyIndices: [...partitionKeyIndices, ...orderKeyIndices],
		directions: [
			...partitionKeyIndices.map(() => false),
			...orderKeyDirections,
		],
	};

	// --- Step 6: Allocate cursor and registers --- //
	const cursor = compiler.allocateCursor();
	const dataBaseReg = compiler.allocateMemoryCells(sorterColumns.length);

	// --- Step 7: Construct final schema object --- //
	// Using placeholder type for now, ideally should conform to TableSchema
	const schema = {
		name: `window_sorter_${cursor}`,
		type: 'ephemeral' as const,
		columns: sorterColumns,
	};

	return {
		cursor,
		schema,
		sortKeyP4,
		numPartitionKeys: partitionKeyIndices.length,
		dataBaseReg,
		exprToSorterIndex,
		windowResultPlaceholders,
		indexToExpression,
	};
}
