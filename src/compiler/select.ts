import { Opcode } from '../vdbe/opcodes';
import { StatusCode, SqlDataType } from '../common/types';
import { SqliteError } from '../common/errors';
import { type P4Vtab, type P4FuncDef, type P4SortKey } from '../vdbe/instruction';
import type { Compiler, ColumnResultInfo, HavingContext } from './compiler'; // Ensure HavingContext is imported
import type * as AST from '../parser/ast';
import { compileUnhandledWhereConditions } from './whereVerify';
import type { ArgumentMap } from './expression';
import { analyzeSubqueryCorrelation } from './correlation'; // Added import
import type { TableSchema } from '../schema/table'; // Import TableSchema only
import type { ColumnSchema } from '../schema/column'; // Import ColumnSchema from correct location
import type { SubqueryCorrelationResult } from './correlation';
import { setupWindowSorter, type WindowSorterInfo } from './window'; // Import window setup function
import { compileWindowFunctionsPass } from './window_pass'; // Import window functions pass
import { expressionToString } from '../util/ddl-stringify';

/**
 * Interface to hold consolidated state for each level in the join structure.
 * This replaces multiple parallel arrays indexed by loop level.
 */
interface JoinLevelInfo {
	cursor: number;                // The VDBE cursor ID for this level
	schema: TableSchema;           // Schema for the table at this level
	alias: string;                 // Alias used for this level (for lookups)
	joinType?: AST.JoinClause['joinType'] | 'cross'; // Type of join connecting this level to the previous one
	condition?: AST.Expression;    // ON condition expression for this join
	usingColumns?: string[];       // USING columns for this join
	// VDBE State (populated during compilation)
	loopStartAddr?: number;        // Address of loop start
	eofAddr?: number;              // Address to jump to when EOF reached
	joinFailAddr?: number;         // Address to jump to when join condition fails
	matchReg?: number;             // For LEFT JOINs: register containing match flag
}

/**
 * Preprocesses the FROM clause AST to gather information about each join level.
 * Returns an ordered array representing the flattened join structure.
 */
function preprocessJoinLevels(compiler: Compiler, sources: AST.FromClause[] | undefined): JoinLevelInfo[] {
	if (!sources || sources.length === 0) {
		return [];
	}

	const levels: JoinLevelInfo[] = [];

	function processNode(node: AST.FromClause, previousLevelAlias?: string): string /* returns alias of this node */ {
		if (node.type === 'table') {
			const cursor = compiler.tableAliases.get((node.alias || node.table.name).toLowerCase());
			if (cursor === undefined) {
				throw new SqliteError(`Table alias ${node.alias || node.table.name} not found in compiler's alias map`, StatusCode.INTERNAL);
			}
			const alias = (node.alias || node.table.name).toLowerCase();
			const schema = compiler.tableSchemas.get(cursor);
			if (!schema) {
				throw new SqliteError(`Schema not found for table ${alias}`, StatusCode.INTERNAL);
			}
			levels.push({ cursor, schema, alias });
			return alias;
		} else if (node.type === 'join') {
			const leftAlias = processNode(node.left, previousLevelAlias);
			const rightAlias = processNode(node.right, leftAlias);

			// The last level added corresponds to the right side of this join
			const rightLevelInfo = levels[levels.length - 1];
			rightLevelInfo.joinType = node.joinType;
			if (node.condition) {
				rightLevelInfo.condition = node.condition;
			} else if (node.columns) {
				rightLevelInfo.usingColumns = node.columns;
			} else if (node.joinType !== 'cross') {
				// Natural join or non-cross join without ON/USING - treat as CROSS for now
				// Note: The 'natural' keyword might be handled by the parser setting joinType='inner' and omitting condition/columns.
				// Proper natural join column matching isn't implemented here.
				if (node.joinType === 'inner' || node.joinType === 'left') {
					console.warn(`Join between ${leftAlias} and ${rightAlias} of type ${node.joinType} has no ON/USING clause.`);
					rightLevelInfo.joinType = 'cross';
				}
			}
			return rightAlias;
		} else if (node.type === 'subquerySource') { // Adjusted type check based on likely AST structure
			// Handle subquery sources
			const alias = node.alias.toLowerCase();
			const cursor = compiler.tableAliases.get(alias);
			if (cursor === undefined) {
				throw new SqliteError(`Subquery alias ${alias} not found in compiler's alias map`, StatusCode.INTERNAL);
			}
			const schema = compiler.tableSchemas.get(cursor);
			if (!schema) {
				throw new SqliteError(`Schema not found for subquery ${alias}`, StatusCode.INTERNAL);
			}
			levels.push({ cursor, schema, alias });
			return alias;
		} else {
			// Add checks for other valid FromClause types if necessary (e.g., FunctionSource)
			throw new SqliteError(`Unsupported FROM clause node type: ${(node as any).type}`, StatusCode.ERROR);
		}
	}

	if (sources.length > 1) {
		// Implicit cross joins between top-level sources
		let lastAlias: string | undefined = undefined;
		for (let i = 0; i < sources.length; i++) {
			const currentAlias = processNode(sources[i], lastAlias);
			if (i > 0) {
				// Mark this level as a cross join relative to the previous one
				const currentLevelInfo = levels[levels.length - 1];
				currentLevelInfo.joinType = 'cross';
			}
			lastAlias = currentAlias;
		}
	} else if (sources.length === 1) {
		processNode(sources[0]);
	}

	return levels;
}

/**
 * Compiles a subquery used as a source in the FROM clause.
 * Determines its schema, allocates a cursor, and registers it.
 */
function compileSubquerySource(compiler: Compiler, node: AST.SubquerySource): void {
	const alias = node.alias.toLowerCase();
	if (compiler.tableAliases.has(alias)) {
		throw new SqliteError(`Duplicate alias '${node.alias}'`, StatusCode.ERROR, undefined, node.loc?.start.line, node.loc?.start.column);
	}

	const outerResultColumns = compiler.resultColumns;
	const outerColumnAliases = compiler.columnAliases;
	compiler.resultColumns = [];
	compiler.columnAliases = [];

	// TODO: Pass proper outer cursor context for correlation analysis here.
	const subqueryResult = compiler.compileSelectCore(node.subquery, []);

	const tempColumns: ColumnSchema[] = [];
	const tempColumnIndexMap = new Map<string, number>();

	subqueryResult.columnMap.forEach((colInfo, index) => {
		let name = compiler.columnAliases[index];
		if (!name && colInfo.expr?.type === 'column' && !colInfo.expr.table && !colInfo.expr.schema) {
			name = colInfo.expr.name;
		}
		if (!name) {
			name = `col_${index}`;
		}

		if (tempColumnIndexMap.has(name.toLowerCase())) {
			console.warn(`Duplicate column name "${name}" in subquery ${alias}. Renaming to ${name}_${index}.`);
			name = `${name}_${index}`;
		}
		// Determine affinity - default to BLOB if unknown
		const affinity = SqlDataType.BLOB; // Default affinity
		// We could potentially try to infer affinity from colInfo.expr later

		// Ensure all mandatory fields for ColumnSchema are provided
		const schemaCol: ColumnSchema = {
			name,
			affinity: affinity,
			// Initialize other properties based on ColumnSchema definition
			notNull: false,
			primaryKey: false,
			pkOrder: 0,
			defaultValue: null,
			hidden: false,
			collation: 'BINARY',
			generated: false,
		};
		tempColumns.push(schemaCol);
		tempColumnIndexMap.set(name.toLowerCase(), index);
	});

	// Create the final schema object, including mandatory fields
	const subquerySchema: TableSchema = {
		name: alias,
		schemaName: 'main',
		columns: tempColumns,
		columnIndexMap: tempColumnIndexMap,
		primaryKeyDefinition: [],
		checkConstraints: [],
		isTemporary: true,
		isView: false,
		isVirtual: false,
		isStrict: false,
		isWithoutRowid: true,
		subqueryAST: node.subquery,
		// Initialize other mandatory TableSchema fields if necessary
	};

	compiler.resultColumns = outerResultColumns;
	compiler.columnAliases = outerColumnAliases;

	const cursor = compiler.allocateCursor();
	compiler.tableAliases.set(alias, cursor);
	compiler.tableSchemas.set(cursor, subquerySchema);

	console.log(`Compiled subquery source '${alias}' with cursor ${cursor} and ${subquerySchema.columns.length} columns.`);
}

/**
 * Compiles a table-valued function used as a source in the FROM clause.
 * Retrieves its schema, allocates a cursor, and registers it.
 * NOTE: Assumes schema is statically defined or retrievable via a handler.
 *       Actual execution logic needs integration into the main SELECT loop.
 */
function compileFunctionSource(compiler: Compiler, node: AST.FunctionSource): void {
	const functionName = node.name.name.toLowerCase(); // Assuming simple name for now
	const alias = node.alias ? node.alias.toLowerCase() : functionName;

	if (compiler.tableAliases.has(alias)) {
		throw new SqliteError(`Duplicate alias '${alias}'`, StatusCode.ERROR, undefined, node.loc?.start.line, node.loc?.start.column);
	}

	// --- Get Schema for the Table-Valued Function ---
	// TODO: Implement actual schema lookup for table-valued functions.
	// This requires a registry or mechanism on the Database/Compiler instance.
	// Example placeholder:
	// const functionSchema = compiler.db.findTableFunctionSchema(functionName, node.args);
	// if (!functionSchema) { ... throw error ... }
	console.warn(`Schema lookup for table function '${functionName}' not implemented. Using placeholder schema.`);

	// Create a placeholder schema for now
	const placeholderSchema: TableSchema = {
		name: alias,
		schemaName: 'main',
		columns: [{
			name: 'placeholder_col',
			affinity: SqlDataType.TEXT,
			notNull: false,
			primaryKey: false,
			pkOrder: 0,
			defaultValue: null,
			collation: 'BINARY',
			generated: false,
			hidden: false
		}],
		columnIndexMap: new Map([['placeholder_col', 0]]),
		primaryKeyDefinition: [],
		checkConstraints: [],
		isTemporary: true,
		isView: false,
		isVirtual: false, // Or true if it uses VTab mechanism?
		isStrict: false,
		isWithoutRowid: true,
	};
	const functionSchema = placeholderSchema; // Use placeholder

	// --- Allocate cursor and register ---
	const cursor = compiler.allocateCursor();
	compiler.tableAliases.set(alias, cursor);
	compiler.tableSchemas.set(cursor, functionSchema); // Use the looked-up or placeholder schema

	console.log(`Compiled function source '${functionName}' aliased as '${alias}' with cursor ${cursor}.`);
}

// --- SELECT Statement Compilation --- //

// Helper function to check if a result column is an aggregate function call
function isAggregateResultColumn(col: AST.ResultColumn): boolean {
	return col.type === 'column' && col.expr?.type === 'function' && col.expr.isAggregate === true;
}

// Helper function to check if a result column is a window function
function isWindowFunctionColumn(col: AST.ResultColumn): boolean {
	return col.type === 'column' && col.expr?.type === 'windowFunction';
}

// Helper function to get expressions from a GROUP BY clause
function getGroupKeyExpressions(stmt: AST.SelectStmt): AST.Expression[] {
	return stmt.groupBy || [];
}

export function compileSelectStatement(compiler: Compiler, stmt: AST.SelectStmt): void {
	if (!stmt.from || stmt.from.length === 0) {
		compileSelectNoFrom(compiler, stmt);
		return;
	}

	// --- BEGIN PRE-PASS ---
	// Pre-compile FROM clause subquery/function sources to register their schemas/cursors
	const pendingSubqueries: AST.SubquerySource[] = [];
	const pendingFunctionSources: AST.FunctionSource[] = []; // Added for FunctionSource

	// Renamed function to be more generic
	function preprocessFromSources(sources: AST.FromClause[] | undefined) {
		sources?.forEach(source => {
			if (source.type === 'subquerySource') {
				pendingSubqueries.push(source);
			} else if (source.type === 'functionSource') { // Added check
				pendingFunctionSources.push(source);
			} else if (source.type === 'join') {
				preprocessFromSources([source.left, source.right]); // Recurse into joins
			}
			// Base tables (source.type === 'table') don't need pre-compilation here
		});
	}
	preprocessFromSources(stmt.from);

	pendingSubqueries.forEach(subqueryNode => {
		// TODO: Pass the correct outer context for correlation analysis
		compileSubquerySource(compiler, subqueryNode);
	});

	// Compile Function Sources after subqueries
	pendingFunctionSources.forEach(funcSourceNode => {
		// TODO: Pass the correct outer context for correlation analysis if functions can be correlated
		compileFunctionSource(compiler, funcSourceNode);
	});
	// --- END PRE-PASS ---

	// Pre-process join levels to gather information about the structure
	const joinLevels = preprocessJoinLevels(compiler, stmt.from);
	const fromCursors = joinLevels.map(level => level.cursor);

	// Check for window functions
	const windowColumns = stmt.columns.filter(isWindowFunctionColumn) as {
		type: 'column';
		expr: AST.WindowFunctionExpr;
		alias?: string;
	}[];
	const hasWindowFunctions = windowColumns.length > 0;
	let windowSorterInfo: WindowSorterInfo | undefined;
	let sharedFrameDefinition: AST.WindowFrame | undefined; // To store the shared frame definition

	const hasGroupBy = !!stmt.groupBy && stmt.groupBy.length > 0;
	const aggregateColumns = stmt.columns.filter(isAggregateResultColumn) as ({ type: 'column', expr: AST.FunctionExpr, alias?: string })[];
	const hasAggregates = aggregateColumns.length > 0;
	const isSimpleAggregate = hasAggregates && !hasGroupBy; // e.g., SELECT COUNT(*) FROM t
	const needsAggProcessing = hasAggregates || hasGroupBy;

	// Store original result/alias state
	const savedResultColumns = compiler.resultColumns;
	const savedColumnAliases = compiler.columnAliases;
	compiler.resultColumns = [];
	compiler.columnAliases = [];

	// Plan table access early to determine if ORDER BY is consumed
	const allCursors = fromCursors;
	allCursors.forEach(cursor => {
		const schema = compiler.tableSchemas.get(cursor);
		if (schema) {
			compiler.planTableAccess(cursor, schema, stmt, new Set()); // Initial plan with no outer cursors active
		}
	});

	// Determine if ORDER BY is needed AFTER planning
	let needsExternalSort = false;
	let sortKeyInfo: P4SortKey | null = null;
	if (stmt.orderBy && stmt.orderBy.length > 0) {
		const orderByConsumed = allCursors.every(cursor => {
			const plan = compiler.cursorPlanningInfo.get(cursor);
			return plan?.orderByConsumed ?? false;
		});
		if (!orderByConsumed) {
			needsExternalSort = true;
		}
	}

	// Prepare for window functions if needed
	if (hasWindowFunctions) {
		// When window functions exist, we need a sorter cursor for the window function calculation
		// Create the window sorter setup with partition/order columns
		windowSorterInfo = setupWindowSorter(compiler, stmt);

		// Store the frame definition (assuming it's the same for all WFs in the query)
		if (windowColumns.length > 0 && windowColumns[0].expr.window?.frame) {
			sharedFrameDefinition = windowColumns[0].expr.window.frame;
		}

		// Open ephemeral table for window sorter
		const winSortCursor = windowSorterInfo.cursor;
		const winSortSchema = compiler.createEphemeralSchema(
			winSortCursor,
			windowSorterInfo.schema.columns.length,
			windowSorterInfo.sortKeyP4
		);

		compiler.emit(Opcode.OpenEphemeral, winSortCursor, windowSorterInfo.schema.columns.length, 0, winSortSchema, 0, "Open Window Function Sorter");
	}

	// Compile the core SELECT structure once to get the column map
	// This map is needed for aggregation, sorting key mapping, and LEFT JOIN padding.
	let coreResultBaseReg = 0;
	let coreNumCols = 0;
	let coreColumnMap: ColumnResultInfo[] = [];
	let finalResultBaseReg = 0; // Base reg for final output or sorter input
	let finalNumCols = 0;       // Num cols for final output or sorter input
	let finalColumnMap: ColumnResultInfo[] = []; // Map for final output or sorter input

	// Compile core once to get the structure
	const coreResult = compiler.compileSelectCore(stmt, fromCursors);
	coreResultBaseReg = coreResult.resultBaseReg; // Base of the raw row data
	coreNumCols = coreResult.numCols;
	coreColumnMap = coreResult.columnMap;

	if (hasWindowFunctions && windowSorterInfo) {
		// With window functions, use the window sorter for the final output structure
		// Map each SELECT column to either a sorter column or window function result
		finalColumnMap = [];
		stmt.columns.forEach((col, idx) => {
			if (col.type === 'column') {
				if (col.expr && col.expr.type === 'windowFunction') {
					// This is a window function column
					const winExpr = col.expr as AST.WindowFunctionExpr;
					const placeholderInfo = windowSorterInfo!.windowResultPlaceholders.get(winExpr);
					if (!placeholderInfo) {
						throw new SqliteError(`Internal error: Window function placeholder not found for ${winExpr.function.name}`, StatusCode.INTERNAL);
					}
					// Map to the register that will hold the window function result
					finalColumnMap.push({
						targetReg: placeholderInfo.resultReg,
						sourceCursor: -1, // Special value for window function result
						sourceColumnIndex: placeholderInfo.sorterIndex,
						expr: winExpr
					});
				} else if (col.expr) {
					// Regular expression column - find in sorter schema
					const exprStr = expressionToString(col.expr);
					const sorterColIdx = windowSorterInfo!.exprToSorterIndex.get(exprStr);
					if (sorterColIdx === undefined) {
						throw new SqliteError(`Internal error: SELECT expression ${exprStr} not found in window sorter schema`, StatusCode.INTERNAL);
					}
					finalColumnMap.push({
						targetReg: compiler.allocateMemoryCells(1),
						sourceCursor: windowSorterInfo!.cursor,
						sourceColumnIndex: sorterColIdx,
						expr: col.expr
					});
				}
			} else if (col.type === 'all') {
				// TODO: Handle SELECT * with window functions
				throw new SqliteError("SELECT * with window functions is not yet supported. Please specify columns explicitly.", StatusCode.ERROR);
			}
		});

		finalNumCols = finalColumnMap.length;

	} else if (needsAggProcessing) {
		// Aggregation determines the final structure
		// Estimate final base reg size (might need adjustment later)
		let estimatedFinalNumCols = (stmt.groupBy?.length ?? 0) + aggregateColumns.length;
		if (isSimpleAggregate && !hasGroupBy) estimatedFinalNumCols = aggregateColumns.length;
		if (estimatedFinalNumCols === 0 && hasGroupBy) estimatedFinalNumCols = stmt.groupBy!.length;
		if (estimatedFinalNumCols === 0) estimatedFinalNumCols = 1;
		finalResultBaseReg = compiler.allocateMemoryCells(estimatedFinalNumCols); // Allocate space for aggregated results
	} else {
		// No aggregation, core result is the final structure before sorting
		finalResultBaseReg = coreResultBaseReg;
		finalNumCols = coreNumCols;
		finalColumnMap = coreColumnMap;
	}

	// Calculate sorter info if needed, using the *final* structure map
	let ephSortCursor = -1;
	let ephSortSchema: TableSchema | undefined;
	if (needsExternalSort) {
		const sortTerms = stmt.orderBy!;
		const keyIndices: number[] = [];
		const directions: boolean[] = [];

		// Map ORDER BY expressions to the indices in the final result columns
		sortTerms.forEach(term => {
			const colIndex = finalColumnMap.findIndex(info => {
				// Attempt matching (similar logic to HAVING clause)
				const exprAlias = (info.expr as any)?.alias?.toLowerCase();
				const termAlias = (term.expr as any)?.alias?.toLowerCase();
				if (termAlias && exprAlias === termAlias) return true;
				if (term.expr.type === 'column' && info.expr?.type === 'column' && !termAlias && !(info.expr as any)?.alias) {
					// Match by name if both are unaliased columns
					return (term.expr as AST.ColumnExpr).name.toLowerCase() === (info.expr as AST.ColumnExpr).name.toLowerCase();
				}
				// Fallback to structural comparison (less reliable)
				return JSON.stringify(term.expr) === JSON.stringify(info.expr);
			});
			if (colIndex === -1) {
				throw new SqliteError(`ORDER BY term "${JSON.stringify(term.expr)}" not found in result columns`);
			}
			keyIndices.push(colIndex);
			directions.push(term.direction === 'desc');
		});

		sortKeyInfo = { keyIndices, directions, type: 'sortkey' };

		console.log(`Memory Sort: ${finalNumCols} cols, keys: ${keyIndices.join(',')}, dirs: ${directions.join(',')}`);
		ephSortCursor = compiler.allocateCursor();
		ephSortSchema = compiler.createEphemeralSchema(ephSortCursor, finalNumCols, sortKeyInfo);
		compiler.emit(Opcode.OpenEphemeral, ephSortCursor, finalNumCols, 0, ephSortSchema, 0, "Open Ephemeral Sorter");
	}

	// Reset aggregate context map before processing rows
	if (needsAggProcessing) {
		compiler.emit(Opcode.AggReset, 0, 0, 0, null, 0, "Reset Aggregation Context");
	}

	// --- Initialize Limit/Offset Counters (if needed) ---
	let regLimit = 0;
	let regOffset = 0;
	if (stmt.limit) {
		regLimit = compiler.allocateMemoryCells(1);
		compiler.compileExpression(stmt.limit, regLimit);
		if (stmt.offset) {
			regOffset = compiler.allocateMemoryCells(1);
			compiler.compileExpression(stmt.offset, regOffset);
		} else {
			regOffset = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Integer, 0, regOffset, 0, null, 0, "Default OFFSET 0");
		}
	} else if (stmt.offset) {
		throw new SqliteError("OFFSET requires a LIMIT clause", StatusCode.ERROR);
	}
	// ----------------------------------------------------

	// --- Generate Nested Loops for FROM sources --- //
	const activeOuterCursors = new Set<number>();
	let innermostVNextAddr = 0; // Will hold address of innermost loop's VNext
	let innermostProcessStartAddr = 0; // Start of WHERE/Aggregation/Output logic

	// Setup each join level with loops, filters, and join conditions
	joinLevels.forEach((level, index) => {
		// Allocate addresses and registers for this level
		level.loopStartAddr = compiler.allocateAddress();
		level.eofAddr = compiler.allocateAddress();
		level.joinFailAddr = compiler.allocateAddress();

		// For LEFT JOIN, allocate a match register
		if (level.joinType === 'left') {
			level.matchReg = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Integer, 0, level.matchReg, 0, null, 0, `Init LEFT JOIN Match Flag [${index}] = 0`);
		}

		const cursor = level.cursor;
		const schema = level.schema;

		// --- Integrate Subquery Execution/Materialization ---
		if (schema.subqueryAST) {
			// TODO: Implement subquery materialization/execution logic here
			// For now, emit a placeholder VFilter and warning.
			console.warn(`Execution logic for subquery source '${schema.name}' (cursor ${cursor}) is not yet implemented.`);
			// Placeholder VFilter: Assumes subquery is materialized and ready to scan.
			// A real implementation would likely involve compiling the subqueryAST
			// into an ephemeral table just before this loop or upon first access.
			compiler.emit(Opcode.VFilter, cursor, level.eofAddr, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, `Filter/Scan Subquery Cursor ${index} (IMPLEMENTATION NEEDED)`);
		} else {
			// Standard VFilter logic for base tables/vtabs
			const planningInfo = compiler.cursorPlanningInfo.get(cursor);
			let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
			let regArgsStart = 0;
			if (planningInfo && planningInfo.idxNum !== 0) {
				const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
				planningInfo.usage.forEach((usage, constraintIdx) => {
					if (usage.argvIndex > 0) {
						const expr = planningInfo.constraintExpressions?.get(constraintIdx);
						if (!expr) throw new SqliteError(`Internal error: Missing expression for constraint ${constraintIdx}`, StatusCode.INTERNAL);
						while (argsToCompile.length < usage.argvIndex) { argsToCompile.push(null as any); }
						argsToCompile[usage.argvIndex - 1] = { constraintIdx, expr };
					}
				});
				const finalArgsToCompile = argsToCompile.filter(a => a !== null);
				if (finalArgsToCompile.length > 0) {
					regArgsStart = compiler.allocateMemoryCells(finalArgsToCompile.length);
					finalArgsToCompile.forEach((argInfo, i) => {
						const correlation = analyzeSubqueryCorrelation(compiler, argInfo.expr, activeOuterCursors);
						compiler.compileExpression(argInfo.expr, regArgsStart + i, correlation);
					});
				}
				filterP4 = { idxNum: planningInfo.idxNum, idxStr: planningInfo.idxStr, nArgs: finalArgsToCompile.length };
			}
			compiler.emit(Opcode.VFilter, cursor, level.eofAddr, regArgsStart, filterP4, 0, `Filter/Scan Cursor ${index}`);
		}
		// --- End Subquery/Standard VFilter Logic ---

		compiler.resolveAddress(level.loopStartAddr!);
		compiler.verifyWhereConstraints(cursor, level.joinFailAddr!); // Verify constraints not omitted by plan

		// Compile explicit JOIN condition (ON/USING) if applicable
		if (index > 0) {
			if (level.joinType !== 'cross') {
				compileJoinCondition(compiler, level, joinLevels, index, level.joinFailAddr!);
			}
		}

		// If this row satisfies join conditions, set match flag for the *outer* row (if LEFT JOIN)
		if (index > 0) {
			const outerLevel = joinLevels[index - 1];
			if (outerLevel.joinType === 'left' && outerLevel.matchReg !== undefined) {
				compiler.emit(Opcode.Integer, 1, outerLevel.matchReg, 0, null, 0, `Set LEFT JOIN Match Flag [${index-1}] = 1`);
			}
		}
		activeOuterCursors.add(cursor);
	}); // End of FROM loop setup

	// --- Innermost Processing --- //
	innermostProcessStartAddr = compiler.getCurrentAddress();
	const innermostWhereFailTarget = compiler.allocateAddress(); // Target if WHERE fails

	// Compile remaining WHERE conditions not handled by plans/joins
	compileUnhandledWhereConditions(compiler, stmt.where, fromCursors, innermostWhereFailTarget);

	// Re-calculate core results inside the loop to have current row values
	const { resultBaseReg: currentRowResultBase, numCols: currentRowNumCols, columnMap: currentRowColumnMap } =
		compiler.compileSelectCore(stmt, fromCursors); // Re-compile expressions for current row
	if (currentRowNumCols !== coreNumCols) {
		throw new Error("Internal: Column count mismatch during loop recompilation");
	}

	if (hasWindowFunctions && windowSorterInfo) {
		// --- Step 1: Calculate the row values and store in the window sorter ---
		// Populate window sorter registers with the current row data
		const sorterDataReg = windowSorterInfo.dataBaseReg;
		windowSorterInfo.schema.columns.forEach((col, i) => {
			const sourceExpr = windowSorterInfo.indexToExpression.get(i);
			if (sourceExpr) {
				// This is a data column needed for partition/order/args
				// Find the expression's value in the current row
				const coreColInfo = currentRowColumnMap.find(info =>
					info.expr && expressionToString(info.expr) === expressionToString(sourceExpr));

				if (coreColInfo) {
					// Move value from core result register to sorter data register
					compiler.emit(Opcode.Move, coreColInfo.targetReg, sorterDataReg + i, 1, null, 0,
						`Move ${i}: ${expressionToString(sourceExpr).substring(0, 20)}`);
				} else {
					// Column not found in current row (shouldn't happen)
					compiler.emit(Opcode.Null, 0, sorterDataReg + i, 1, null, 0,
						`NULL for sorter col ${i} (expr not found in current row)`);
				}
			} else {
				// This is a placeholder for window function result (will be calculated in window pass)
				compiler.emit(Opcode.Null, 0, sorterDataReg + i, 1, null, 0,
					`NULL placeholder for window result col ${i}`);
			}
		});

		// Insert the data into the window sorter
		const recordReg = compiler.allocateMemoryCells(1);
		const rowidReg = compiler.allocateMemoryCells(1);
		compiler.emit(Opcode.Null, 0, rowidReg, 0, null, 0, "Window Sort: NULL Rowid");
		compiler.emit(Opcode.MakeRecord, sorterDataReg, windowSorterInfo.schema.columns.length, recordReg, null, 0,
			"Make Window Sort Record");
		// Use a combined data array that starts with rowid
		const insertDataReg = compiler.allocateMemoryCells(windowSorterInfo.schema.columns.length + 1);
		compiler.emit(Opcode.Move, rowidReg, insertDataReg, 1, null, 0, "Copy rowid for insert");
		compiler.emit(Opcode.Move, sorterDataReg, insertDataReg + 1, windowSorterInfo.schema.columns.length, null, 0, "Copy data for insert");
		compiler.emit(Opcode.VUpdate, windowSorterInfo.schema.columns.length + 1, insertDataReg, windowSorterInfo.cursor, { table: windowSorterInfo.schema }, 0,
			"Insert Row into Window Sorter");

	} else if (needsAggProcessing) {
		// --- Standard Aggregation Step ---
		// Calculate group key, call AggStep for each aggregate
		let regGroupKeyStart = 0;
		let numGroupKeys = 0;
		let regSerializedKey = 0;

		if (hasGroupBy) {
			numGroupKeys = stmt.groupBy!.length;
			regGroupKeyStart = compiler.allocateMemoryCells(numGroupKeys);
			stmt.groupBy!.forEach((expr, i) => {
				compiler.compileExpression(expr, regGroupKeyStart + i);
			});
			regSerializedKey = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.MakeRecord, regGroupKeyStart, numGroupKeys, regSerializedKey, null, 0, "Make GROUP BY Key");
		} else {
			// Simple aggregate (no GROUP BY) - use a constant key (e.g., 0)
			regSerializedKey = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Integer, 0, regSerializedKey, 0, null, 0, "Use constant key 0 for simple aggregate");
		}

		// Call AggStep for each aggregate function
		aggregateColumns.forEach(aggCol => {
			const funcExpr = aggCol.expr;
			const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length);
			if (!funcDef) throw new Error("Aggregate function definition disappeared?");

			const firstArgReg = compiler.allocateMemoryCells(funcExpr.args.length || 1); // Need at least 1 for COUNT(*)
			funcExpr.args.forEach((argExpr, i) => {
				compiler.compileExpression(argExpr, firstArgReg + i);
			});

			const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
			compiler.emit(Opcode.AggStep, regGroupKeyStart, firstArgReg, regSerializedKey, p4, numGroupKeys, `AggStep for ${funcExpr.name}`);
		});

	} else {
		// Not aggregating - process directly
		const addrSkipRow = compiler.allocateAddress(); // Jump target to skip output

		// Apply LIMIT/OFFSET *before* outputting or sorting
		if (regLimit > 0) {
			// Offset Check
			const addrPostOffset = compiler.allocateAddress();
			compiler.emit(Opcode.IfZero, regOffset, addrPostOffset, 0, null, 0, "Check Offset == 0");
			compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Decrement Offset");
			compiler.emit(Opcode.Goto, 0, addrSkipRow, 0, null, 0, "Skip Row (Offset)"); // Jump past output/sort
			compiler.resolveAddress(addrPostOffset);
		}

		// If sorting needed, store in ephemeral table, otherwise output
		if (needsExternalSort) {
			const insertDataReg = compiler.allocateMemoryCells(finalNumCols + 1);
			compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Sort: NULL Rowid for Eph Insert");
			compiler.emit(Opcode.Move, currentRowResultBase, insertDataReg + 1, finalNumCols, null, 0, "Sort: Copy result to Eph Insert Data");
			compiler.emit(Opcode.VUpdate, finalNumCols + 1, insertDataReg, ephSortCursor, { table: ephSortSchema }, 0, "Sort: Insert Row into Ephemeral");
		} else {
			// Output directly
			compiler.emit(Opcode.ResultRow, currentRowResultBase, finalNumCols, 0, null, 0, "Output result row");

			// --- Limit Check after outputting --- //
			if (regLimit > 0) {
				const addrLimitNotZero = compiler.allocateAddress();
				compiler.emit(Opcode.IfZero, regLimit, addrLimitNotZero, 0, null, 0, "Skip Limit Check if already 0"); // Skip decrement if 0
				compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Decrement Limit");
				// If limit becomes 0, jump to the end of the outermost loop
				compiler.emit(Opcode.IfZero, regLimit, joinLevels[0].eofAddr!, 0, null, 0, "Check Limit Reached");
				compiler.resolveAddress(addrLimitNotZero);
			}
			// ------------------------------------ //
		}

		compiler.resolveAddress(addrSkipRow); // Target for offset skip or end of non-agg path
	}

	// Jump to the VNext of the innermost loop
	const placeholderVNextAddr = compiler.allocateAddress();
	compiler.emit(Opcode.Goto, 0, placeholderVNextAddr, 0, null, 0, "Goto Innermost VNext");

	// Resolve the target for WHERE failure - jump to VNext
	compiler.resolveAddress(innermostWhereFailTarget);
	compiler.emit(Opcode.Goto, 0, placeholderVNextAddr, 0, null, 0, "WHERE Failed, Goto VNext");
	// --- End Innermost Processing --- //

	// --- Generate Loop Closing/VNext and LEFT JOIN NULL Padding --- //
	for (let i = joinLevels.length - 1; i >= 0; i--) {
		const level = joinLevels[i];

		// Resolve the target for join/where failure at this level
		compiler.resolveAddress(level.joinFailAddr!);

		// Resolve the target for the GOTO after innermost processing (points to VNext)
		const currentVNextAddr = compiler.getCurrentAddress(); // Address of this VNext
		if (i === joinLevels.length - 1) {
			// Resolve the placeholder VNext targets for the innermost level
			compiler.resolveAddress(placeholderVNextAddr);
		}

		compiler.emit(Opcode.VNext, level.cursor, level.eofAddr!, 0, null, 0, `VNext Cursor ${i}`);
		compiler.emit(Opcode.Goto, 0, level.loopStartAddr!, 0, null, 0, `Goto LoopStart ${i}`);
		compiler.resolveAddress(level.eofAddr!);

		// LEFT JOIN EOF NULL Padding
		if (level.joinType === 'left' && level.matchReg !== undefined) {
			emitLeftJoinNullPadding(compiler, level, joinLevels, i, coreColumnMap, innermostProcessStartAddr);
		}

		// Reset match flag for the next outer iteration
		if (level.matchReg !== undefined) {
			compiler.emit(Opcode.Integer, 0, level.matchReg, 0, null, 0, `Reset LEFT JOIN Match Flag [${i}] before outer VNext/EOF`);
		}
		activeOuterCursors.delete(level.cursor);
	} // --- End loop closing --- //

	// --- Window Function Processing (Post-looping phase) ---
	if (hasWindowFunctions && windowSorterInfo) {
		// Now that all rows are in the sorter, sort it
		compiler.emit(Opcode.Sort, windowSorterInfo.cursor, 0, 0, null, 0, "Sort Window Function Data");

		// We need a new set of registers for the final output row
		// since the window functions need to be calculated
		const outputBaseReg = compiler.allocateMemoryCells(finalColumnMap.length);

		// Set up the loop to iterate through the sorter and calculate window functions
		const addrWinLoopStart = compiler.allocateAddress();
		const addrWinLoopEnd = compiler.allocateAddress();

		// Run the window functions pass with the frame definition
		compileWindowFunctionsPass(compiler, windowSorterInfo, outputBaseReg, finalColumnMap.length, sharedFrameDefinition);

		// Now loop through the sorted data again and build final output
		compiler.emit(Opcode.Rewind, windowSorterInfo.cursor, addrWinLoopEnd, 0, null, 0, "Rewind Window Sorter for Output");
		compiler.resolveAddress(addrWinLoopStart);

		// For each output column, move data from either the sorter or the calculated function result
		finalColumnMap.forEach((colInfo, i) => {
			if (colInfo.expr?.type === 'windowFunction') {
				// Window function result is already in the placeholder register
				const placeholderInfo = windowSorterInfo!.windowResultPlaceholders.get(colInfo.expr);
				if (!placeholderInfo) {
					throw new SqliteError(`Internal error: Window placeholder not found for output column ${i}`, StatusCode.INTERNAL);
				}
				compiler.emit(Opcode.Move, placeholderInfo.resultReg, outputBaseReg + i, 1, null, 0,
					`Move window result to output ${i}`);
			} else {
				// Regular column - read from sorter
				const sorterColIdx = colInfo.sourceColumnIndex;
				compiler.emit(Opcode.VColumn, windowSorterInfo!.cursor, sorterColIdx, outputBaseReg + i, null, 0,
					`Read sorter col ${sorterColIdx} to output ${i}`);
			}
		});

		// Apply LIMIT/OFFSET if present
		const addrSkipWinRow = compiler.allocateAddress();
		if (regLimit > 0) {
			const addrPostWinOffset = compiler.allocateAddress();
			compiler.emit(Opcode.IfZero, regOffset, addrPostWinOffset, 0, null, 0, "Window: Check Offset == 0");
			compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Window: Decrement Offset");
			compiler.emit(Opcode.Goto, 0, addrSkipWinRow, 0, null, 0, "Window: Skip Row (Offset)");
			compiler.resolveAddress(addrPostWinOffset);
		}

		// Output the window function row
		compiler.emit(Opcode.ResultRow, outputBaseReg, finalColumnMap.length, 0, null, 0,
			"Output Window Function Row");

		// Apply LIMIT check
		if (regLimit > 0) {
			const addrWinLimitNotZero = compiler.allocateAddress();
			compiler.emit(Opcode.IfZero, regLimit, addrWinLimitNotZero, 0, null, 0, "Window: Skip Limit Check if 0");
			compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Window: Decrement Limit");
			compiler.emit(Opcode.IfZero, regLimit, addrWinLoopEnd, 0, null, 0, "Window: Check Limit Reached");
			compiler.resolveAddress(addrWinLimitNotZero);
		}

		compiler.resolveAddress(addrSkipWinRow);
		// Advance to next row in the sorted window data
		compiler.emit(Opcode.VNext, windowSorterInfo.cursor, addrWinLoopEnd, 0, null, 0, "Next Window Row");
		compiler.emit(Opcode.Goto, 0, addrWinLoopStart, 0, null, 0, "Window Loop");
		compiler.resolveAddress(addrWinLoopEnd);

		// Close window sorter cursor
		compiler.emit(Opcode.Close, windowSorterInfo.cursor, 0, 0, null, 0, "Close Window Sorter");
	}

	// --- Final Aggregation Result Output --- //
	if (needsAggProcessing && !hasWindowFunctions) {
		const addrAggLoopStart = compiler.allocateAddress();
		const addrAggLoopEnd = compiler.allocateAddress();
		const regMapIterator = compiler.allocateMemoryCells(1); // Conceptual iterator register
		const regGroupKey = compiler.allocateMemoryCells(1);
		const regAggContext = compiler.allocateMemoryCells(1);

		// Determine final column map *before* the loop
		finalColumnMap = [];
		let currentResultReg = finalResultBaseReg;

		// Add group key columns to map
		if (hasGroupBy) {
			stmt.groupBy!.forEach((expr, i) => {
				finalColumnMap.push({ targetReg: currentResultReg++, sourceCursor: -1, sourceColumnIndex: -1, expr: expr });
			});
		}
		// Add aggregate columns to map
		aggregateColumns.forEach(aggCol => {
			finalColumnMap.push({ targetReg: currentResultReg++, sourceCursor: -1, sourceColumnIndex: -1, expr: aggCol.expr });
		});
		finalNumCols = finalColumnMap.length;
		if (finalNumCols === 0 && !hasGroupBy) finalNumCols = 1; // Ensure at least one column for simple aggregate if no columns selected

		// Set column names based on the final structure
		compiler.columnAliases = finalColumnMap.map((info, idx) => {
			return (info.expr as any)?.alias
				?? (info.expr?.type === 'column' ? (info.expr as AST.ColumnExpr).name : `col${idx}`);
		});

		compiler.emit(Opcode.AggIterate, regMapIterator, 0, 0, null, 0, "Start Aggregate Result Iteration");
		compiler.resolveAddress(addrAggLoopStart);
		compiler.emit(Opcode.AggNext, regMapIterator, addrAggLoopEnd, 0, null, 0, "Next Aggregate Group");

		// Get Key and Context for the current group
		compiler.emit(Opcode.AggKey, regMapIterator, regGroupKey, 0, null, 0, "Get Group Key");
		compiler.emit(Opcode.AggContext, regMapIterator, regAggContext, 0, null, 0, "Get Aggregate Context");

		// Reconstruct Output Row (Group Keys + Aggregates) using finalColumnMap
		let groupKeyIndex = 0;
		finalColumnMap.forEach(info => {
			if (info.expr?.type === 'function' && info.expr.isAggregate) {
				// It's an aggregate result
				const funcExpr = info.expr as AST.FunctionExpr;
				const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length)!;
				const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
				compiler.emit(Opcode.AggFinal, regAggContext, 0, info.targetReg, p4, 0, `AggFinal for ${funcExpr.name}`);
			} else if (hasGroupBy) {
				// It's a group key result
				compiler.emit(Opcode.AggGroupValue, regMapIterator, groupKeyIndex, info.targetReg, null, 0, `Output Group Key ${groupKeyIndex}`);
				groupKeyIndex++;
			} else {
				// Should be simple aggregate with no group keys
				throw new Error("Internal: Unexpected column type in aggregate output loop");
			}
		});

		// --- Compile HAVING clause --- //
		const addrHavingFail = compiler.allocateAddress();
		if (stmt.having) {
			const havingReg = compiler.allocateMemoryCells(1);
			const havingContext: HavingContext = { finalColumnMap };
			compiler.compileExpression(stmt.having, havingReg, undefined, havingContext);
			compiler.emit(Opcode.IfFalse, havingReg, addrHavingFail, 0, null, 0, "Check HAVING Clause");
		}
		// --------------------------- //

		// Store in ephemeral sort table or output directly
		if (needsExternalSort) {
			const insertDataReg = compiler.allocateMemoryCells(finalNumCols + 1);
			compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Agg Sort: NULL Rowid");
			compiler.emit(Opcode.Move, finalResultBaseReg, insertDataReg + 1, finalNumCols, null, 0, "Agg Sort: Copy group result");
			compiler.emit(Opcode.VUpdate, finalNumCols + 1, insertDataReg, ephSortCursor, { table: ephSortSchema }, 0, "Agg Sort: Insert Group Row");
		} else {
			// Apply Limit/Offset for non-sorted aggregated results
			const addrSkipAggRow = compiler.allocateAddress();
			if (regLimit > 0) {
				const addrPostAggOffset = compiler.allocateAddress();
				compiler.emit(Opcode.IfZero, regOffset, addrPostAggOffset, 0, null, 0, "Agg Check Offset == 0");
				compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Agg Decrement Offset");
				compiler.emit(Opcode.Goto, 0, addrSkipAggRow, 0, null, 0, "Agg Skip Row (Offset)");
				compiler.resolveAddress(addrPostAggOffset);
			}

			compiler.emit(Opcode.ResultRow, finalResultBaseReg, finalNumCols, 0, null, 0, "Output Aggregate Group Row");

			if (regLimit > 0) {
				const addrAggLimitNotZero = compiler.allocateAddress();
				compiler.emit(Opcode.IfZero, regLimit, addrAggLimitNotZero, 0, null, 0, "Agg Skip Limit Check if 0");
				compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Agg Decrement Limit");
				compiler.emit(Opcode.IfZero, regLimit, addrAggLoopEnd, 0, null, 0, "Agg Check Limit Reached"); // Jump to end of agg loop
				compiler.resolveAddress(addrAggLimitNotZero);
			}
			compiler.resolveAddress(addrSkipAggRow); // Target if row skipped by offset
		}

		compiler.resolveAddress(addrHavingFail); // Jump here if HAVING is false
		compiler.emit(Opcode.Goto, 0, addrAggLoopStart, 0, null, 0, "Loop Aggregate Results");
		compiler.resolveAddress(addrAggLoopEnd);
	}

	// --- Output from Sorter --- //
	if (needsExternalSort && !hasWindowFunctions) {
		const addrSortLoopStart = compiler.allocateAddress();
		const addrSortLoopEnd = compiler.allocateAddress();
		const sortedResultBaseReg = compiler.allocateMemoryCells(finalNumCols); // Num cols from sorter matches final output

		compiler.emit(Opcode.Rewind, ephSortCursor, addrSortLoopEnd, 0, null, 0, "Rewind Sorter");
		compiler.resolveAddress(addrSortLoopStart);

		// Apply Limit/Offset during sorter output
		const addrSkipSortedRow = compiler.allocateAddress();
		if (regLimit > 0) {
			// Offset Check
			const addrPostSortOffsetCheck = compiler.allocateAddress();
			compiler.emit(Opcode.IfZero, regOffset, addrPostSortOffsetCheck, 0, null, 0, "Sort Check Offset == 0");
			compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Sort Decrement Offset");
			compiler.emit(Opcode.Goto, 0, addrSkipSortedRow, 0, null, 0, "Sort Skip Row (Offset)");
			compiler.resolveAddress(addrPostSortOffsetCheck);
		}

		// Read sorted row from ephemeral table
		for (let i = 0; i < finalNumCols; i++) {
			compiler.emit(Opcode.VColumn, ephSortCursor, i, sortedResultBaseReg + i, 0, 0, `Read Sorted Col ${i}`);
		}
		// Output the sorted row
		compiler.emit(Opcode.ResultRow, sortedResultBaseReg, finalNumCols, 0, null, 0, "Output sorted row");

		// Limit Check
		if (regLimit > 0) {
			const addrSortLimitNotZero = compiler.allocateAddress();
			compiler.emit(Opcode.IfZero, regLimit, addrSortLimitNotZero, 0, null, 0, "Sort Skip Limit Check if already 0");
			compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Sort Decrement Limit");
			compiler.emit(Opcode.IfZero, regLimit, addrSortLoopEnd, 0, null, 0, "Sort Check Limit Reached"); // Jump to end if limit hit
			compiler.resolveAddress(addrSortLimitNotZero);
		}

		// Advance sorter cursor
		compiler.resolveAddress(addrSkipSortedRow); // Target for offset GOTO
		compiler.emit(Opcode.VNext, ephSortCursor, addrSortLoopEnd, 0, null, 0, "VNext Sorter");
		compiler.emit(Opcode.Goto, 0, addrSortLoopStart, 0, null, 0, "Loop Sorter Results");

		compiler.resolveAddress(addrSortLoopEnd);
		// Close sorter cursor AND original cursors
		compiler.emit(Opcode.Close, ephSortCursor, 0, 0, null, 0, "Close Sorter");
	}
	// ------------------------ //

	// Close FROM cursors
	joinLevels.forEach(level => {
		compiler.emit(Opcode.Close, level.cursor, 0, 0, null, 0, `Close FROM Cursor ${level.cursor}`);
	});

	// Restore original result/alias state
	compiler.resultColumns = savedResultColumns;
	compiler.columnAliases = savedColumnAliases;
}

/** Handle SELECT without FROM - simpler case */
function compileSelectNoFrom(compiler: Compiler, stmt: AST.SelectStmt): void {
	// Compile expressions to get column names and result registers
	const { resultBaseReg, numCols, columnMap } = compiler.compileSelectCore(stmt, []);

	// Set final column aliases
	compiler.columnAliases = columnMap.map((info, idx) => {
		return (info.expr as any)?.alias
			?? (info.expr?.type === 'column' ? (info.expr as AST.ColumnExpr).name : `col${idx}`);
	});

	// --- Compile WHERE clause if present (rare for no FROM, but possible) --- //
	if (stmt.where) {
		const whereReg = compiler.allocateMemoryCells(1);
		const addrSkipResult = compiler.allocateAddress();
		compiler.compileExpression(stmt.where, whereReg);
		compiler.emit(Opcode.IfFalse, whereReg, addrSkipResult, 0, null, 0, "Check WHERE for constant SELECT");
		compiler.emit(Opcode.ResultRow, resultBaseReg, numCols, 0, null, 0, "Output constant result row");
		compiler.resolveAddress(addrSkipResult);
	} else {
		compiler.emit(Opcode.ResultRow, resultBaseReg, numCols, 0, null, 0, "Output constant result row");
	}
}

export function compileSelectCoreStatement(
	compiler: Compiler,
	stmt: AST.SelectStmt,
	outerCursors: number[],
	correlation?: SubqueryCorrelationResult, // Optional correlation info
	argumentMap?: ArgumentMap
): { resultBaseReg: number, numCols: number, columnMap: ColumnResultInfo[] } {
	const savedResultColumns = compiler.resultColumns;
	const savedColumnAliases = compiler.columnAliases;
	compiler.resultColumns = [];
	compiler.columnAliases = [];

	// Determine the set of cursors defined *within* this SELECT statement
	const currentLevelCursors = new Set<number>();
	stmt.from?.forEach(fromClause => {
		const findCursors = (fc: AST.FromClause) => {
			if (fc.type === 'table') {
				const alias = (fc.alias || fc.table.name).toLowerCase();
				const cursorId = compiler.tableAliases.get(alias);
				if (cursorId !== undefined) currentLevelCursors.add(cursorId);
			} else if (fc.type === 'join') {
				findCursors(fc.left);
				findCursors(fc.right);
			}
		};
		findCursors(fromClause);
	});

	// Combine outer cursors passed in with cursors from this level
	const combinedActiveCursors = new Set([...outerCursors, ...currentLevelCursors]);

	let estimatedNumCols = 0;
	const hasStar = stmt.columns.some(c => c.type === 'all');
	if (hasStar) {
		combinedActiveCursors.forEach(cursorIdx => {
			const schema = compiler.tableSchemas.get(cursorIdx);
			const alias = [...compiler.tableAliases.entries()].find(([, cIdx]) => cIdx === cursorIdx)?.[0];
			const colSpec = stmt.columns.find(c => c.type === 'all' && c.table && (c.table.toLowerCase() === schema?.name.toLowerCase() || c.table.toLowerCase() === alias?.toLowerCase())) as AST.ResultColumn & { type: 'all' } | undefined;
			if (schema && (!colSpec || colSpec.table)) { // Check if star matches this cursor
				estimatedNumCols += (schema?.columns.filter(c => !c.hidden).length || 0);
			}
		});
	}
	estimatedNumCols += stmt.columns.filter(c => c.type === 'column').length;
	if (estimatedNumCols === 0) { estimatedNumCols = 1; } // Ensure at least one cell

	const resultBase = compiler.allocateMemoryCells(estimatedNumCols);
	let actualNumCols = 0;
	const columnMap: ColumnResultInfo[] = [];

	let currentResultReg = resultBase;
	for (const column of stmt.columns) {
		if (column.type === 'all') {
			combinedActiveCursors.forEach(cursorIdx => {
				const tableSchema = compiler.tableSchemas.get(cursorIdx);
				const alias = [...compiler.tableAliases.entries()].find(([, cIdx]) => cIdx === cursorIdx)?.[0];
				// Check if this cursor matches the qualified star (e.g., t.*)
				if (tableSchema && (!column.table || column.table.toLowerCase() === alias?.toLowerCase() || column.table.toLowerCase() === tableSchema.name.toLowerCase())) {
					tableSchema.columns.forEach((colSchema) => {
						if (!colSchema.hidden) {
							const targetReg = currentResultReg++;
							const colIdx = tableSchema.columnIndexMap.get(colSchema.name.toLowerCase());
							if (colIdx === undefined && colSchema.name.toLowerCase() !== 'rowid') {
								compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Expand *: Col ${colSchema.name} Idx Error`);
								columnMap.push({ targetReg, sourceCursor: cursorIdx, sourceColumnIndex: -1 });
							} else {
								compiler.emit(Opcode.VColumn, cursorIdx, colIdx ?? -1, targetReg, 0, 0, `Expand *: ${alias || tableSchema.name}.${colSchema.name}`);
								const colExpr: AST.ColumnExpr = { type: 'column', name: colSchema.name, table: alias || tableSchema.name };
								columnMap.push({ targetReg, sourceCursor: cursorIdx, sourceColumnIndex: colIdx ?? -1, expr: colExpr });
							}
							const fullName = `${alias || tableSchema.name}.${colSchema.name}`;
							compiler.resultColumns.push({ name: fullName });
							compiler.columnAliases.push(fullName);
							actualNumCols++;
						}
					});
				}
			});
		} else if (column.expr) {
			const targetReg = currentResultReg++;
			// Pass correlation and argumentMap down to compileExpression
			compiler.compileExpression(column.expr, targetReg, correlation, undefined, argumentMap);

			let sourceCursor = -1;
			let sourceColumnIndex = -1;
			if (column.expr.type === 'column') {
				const colExpr = column.expr as AST.ColumnExpr;
				if (colExpr.table) {
					sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				} else {
					for (const cIdx of combinedActiveCursors) {
						const schema = compiler.tableSchemas.get(cIdx);
						if (schema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
							if (sourceCursor !== -1) {
								// Ambiguous - reset source info
								sourceCursor = -1;
								sourceColumnIndex = -1;
								break;
							};
							sourceCursor = cIdx;
						}
					}
				}
				if (sourceCursor !== -1) {
					sourceColumnIndex = compiler.tableSchemas.get(sourceCursor)?.columnIndexMap.get(colExpr.name.toLowerCase()) ?? -1;
				}
			}
			columnMap.push({ targetReg, sourceCursor, sourceColumnIndex, expr: column.expr });
			let colName = column.alias || (column.expr.type === 'column' ? (column.expr as AST.ColumnExpr).name : `col${actualNumCols + 1}`);
			compiler.columnAliases.push(colName);
			compiler.resultColumns.push({ name: colName, expr: column.expr });
			actualNumCols++;
		}
	}

	// WHERE, GROUP BY, HAVING, ORDER BY are handled by the caller (compileSelectStatement)

	compiler.resultColumns = savedResultColumns;
	compiler.columnAliases = savedColumnAliases;
	return { resultBaseReg: resultBase, numCols: actualNumCols, columnMap };
}

// --- Helper Functions Moved from statement.ts --- //

function findJoinNodeConnecting(
	sources: AST.FromClause[] | undefined,
	leftLevelIndex: number,
	rightLevelIndex: number,
	compiler: Compiler // Needs compiler to resolve aliases if necessary
): AST.JoinClause | undefined {
	if (!sources || sources.length !== 1 || sources[0].type !== 'join') return undefined;

	// Helper to traverse the join tree and track levels
	const findNode = (node: AST.FromClause, level: number): { node: AST.JoinClause | null, nextLevel: number } => {
		if (node.type === 'table') {
			return { node: null, nextLevel: level + 1 };
		} else if (node.type === 'join') {
			// Recursively find the levels of left and right children
			const leftResult = findNode(node.left, level);
			// Check if the target node was found in the left subtree
			if (leftResult.node) return leftResult;

			const rightResult = findNode(node.right, leftResult.nextLevel);
			// Check if the target node was found in the right subtree
			if (rightResult.node) return rightResult;

			// Check if the *current* join node connects the target levels
			// The level indices correspond to the order they appear in the flattened `fromCursors` array
			// leftResult.nextLevel - 1 is the index of the rightmost table in the left subtree
			// rightResult.nextLevel - 1 is the index of the rightmost table in the right subtree
			// We need to check if the leftLevelIndex is the max index of the left subtree,
			// and rightLevelIndex is the max index of the right subtree.
			if (leftResult.nextLevel - 1 === leftLevelIndex && rightResult.nextLevel - 1 === rightLevelIndex) {
				return { node: node, nextLevel: rightResult.nextLevel };
			}

			// If not this node, return the level reached by the right subtree
			return { node: null, nextLevel: rightResult.nextLevel };
		} else {
			throw new Error("Invalid node type in FROM clause during join node search");
		}
	}
	return findNode(sources[0], 0).node ?? undefined;
}

function getJoinTypeForLevel(
	sources: AST.FromClause[] | undefined,
	level: number // 0-based index in the flattened cursor list
): AST.JoinClause['joinType'] | 'cross' | undefined { // Include cross explicitly
	if (level === 0 || !sources || sources.length === 0) return undefined; // Base table or no sources

	// We need to map the level index back to the join node in the AST
	// This requires traversing the AST similarly to findJoinNodeConnecting
	const findJoinForLevel = (node: AST.FromClause, currentLevel: number): { joinNode: AST.JoinClause | null, nextLevel: number } => {
		if (node.type === 'table') {
			return { joinNode: null, nextLevel: currentLevel + 1 };
		} else if (node.type === 'join') {
			const leftResult = findJoinForLevel(node.left, currentLevel);
			if (leftResult.joinNode) return leftResult; // Found in left subtree

			const rightResult = findJoinForLevel(node.right, leftResult.nextLevel);
			if (rightResult.joinNode) return rightResult; // Found in right subtree

			// Check if the *right* side of *this* join corresponds to the target level
			if (rightResult.nextLevel - 1 === level) {
				return { joinNode: node, nextLevel: rightResult.nextLevel };
			}

			return { joinNode: null, nextLevel: rightResult.nextLevel };
		} else {
			throw new Error("Invalid node type in FROM clause during join type search");
		}
	}

	// Flatten sources if multiple top-level elements (e.g., implicit cross join)
	// For now, assume single root source or handle it earlier
	if (sources.length > 1) {
		// This implies an implicit cross join between top-level sources
		// A level > 0 means it's part of the second or later source, thus effectively cross join
		// Or it could be part of a sub-join within one of the sources.
		// This logic needs refinement for complex implicit joins.
		// Let's assume standard JOIN syntax for now.
		return 'cross'; // Simplified assumption
	}

	const result = findJoinForLevel(sources[0], 0);
	return result.joinNode?.joinType;
}

function compileJoinCondition(
	compiler: Compiler,
	level: JoinLevelInfo,     // Current level (right side of the join)
	allJoinLevels: JoinLevelInfo[], // All levels for context
	levelIndex: number,       // Index of the current level
	addrJoinFail: number      // Address to jump to if condition fails
): void {
	if (!level.joinType || level.joinType === 'cross') return; // No condition for CROSS

	const rightCursor = level.cursor;

	// Get the left cursor - the previous level in the join sequence
	if (levelIndex <= 0) {
		throw new SqliteError(`Internal error: compileJoinCondition called with invalid level index ${levelIndex}`, StatusCode.INTERNAL);
	}

	const leftLevel = allJoinLevels[levelIndex - 1];
	const leftCursor = leftLevel.cursor;
	const leftSchema = leftLevel.schema;
	const rightSchema = level.schema;

	if (level.condition) {
		// Compile the ON expression
		const regJoinCondition = compiler.allocateMemoryCells(1);
		compiler.compileExpression(level.condition, regJoinCondition);
		compiler.emit(Opcode.IfFalse, regJoinCondition, addrJoinFail, 0, null, 0, `JOIN: Check ON Condition`);
	} else if (level.usingColumns) {
		// Compile the USING condition
		const regLeftCol = compiler.allocateMemoryCells(1);
		const regRightCol = compiler.allocateMemoryCells(1);

		for (const colName of level.usingColumns) {
			const leftColIdx = leftSchema.columnIndexMap.get(colName.toLowerCase());
			const rightColIdx = rightSchema.columnIndexMap.get(colName.toLowerCase());
			if (leftColIdx === undefined || rightColIdx === undefined) {
				throw new SqliteError(`Column '${colName}' specified in USING clause not found in both tables.`, StatusCode.ERROR);
			}

			compiler.emit(Opcode.VColumn, leftCursor, leftColIdx, regLeftCol, 0, 0, `USING(${colName}) Left`);
			compiler.emit(Opcode.VColumn, rightCursor, rightColIdx, regRightCol, 0, 0, `USING(${colName}) Right`);

			// Handle NULLs: If either is NULL, comparison fails (result 0 for JOIN)
			compiler.emit(Opcode.IfNull, regLeftCol, addrJoinFail, 0, null, 0, `USING: Skip if left NULL`);
			compiler.emit(Opcode.IfNull, regRightCol, addrJoinFail, 0, null, 0, `USING: Skip if right NULL`);

			// Compare non-null values - Jump to fail if not equal
			compiler.emit(Opcode.Ne, regLeftCol, addrJoinFail, regRightCol, null, 0, `USING Compare ${colName}`);
			// If Ne doesn't jump, they are equal, continue to next column
		}
	}
	// Natural join would need to be implemented here
}

/**
 * Emits VDBE code to handle NULL padding for a LEFT JOIN when the EOF is reached
 * for the right-side cursor without finding any matches.
 */
function emitLeftJoinNullPadding(
	compiler: Compiler,
	level: JoinLevelInfo,          // The current level (right side of the finished LEFT JOIN)
	allJoinLevels: JoinLevelInfo[], // All levels for context
	levelIndex: number,             // Index of the current level
	coreColumnMap: ColumnResultInfo[], // Map of columns selected *before* agg/windowing
	innermostProcessStartAddr: number // Address to jump back to process the padded row
): void {
	if (level.joinType !== 'left' || !level.matchReg) {
		return; // Not a LEFT JOIN or matchReg not set
	}

	const addrSkipNullPadEof = compiler.allocateAddress();
	compiler.emit(Opcode.IfTrue, level.matchReg, addrSkipNullPadEof, 0, null, 0, `LEFT JOIN EOF: Skip NULL pad if match found [${levelIndex}]`);

	// Clarifying comment for coreColumnMap usage:
	// Using coreColumnMap here is crucial. It represents the original structure
	// of the SELECT clause *before* aggregation or window functions might alter
	// the final output structure. We need to null-pad the columns as they were
	// originally selected from the right side of this join.
	coreColumnMap.forEach(info => {
		if (info.sourceCursor === level.cursor) {
			compiler.emit(Opcode.Null, 0, info.targetReg, 0, null, 0, `LEFT JOIN EOF: NULL Pad Col ${info.sourceColumnIndex} from Cursor ${level.cursor}`);
		}
	});

	// If this NULL padding satisfies an outer LEFT JOIN, set its flag
	if (levelIndex > 0) {
		const outerLevel = allJoinLevels[levelIndex - 1];
		if (outerLevel.matchReg) { // Check if the outer level is also a LEFT JOIN
			compiler.emit(Opcode.Integer, 1, outerLevel.matchReg, 0, null, 0, `Set LEFT JOIN Match Flag [${levelIndex - 1}] = 1 (due to NULL pad EOF)`);
		}
	}

	// Jump back to process the NULL-padded row
	compiler.emit(Opcode.Goto, 0, innermostProcessStartAddr, 0, null, 0, `LEFT JOIN EOF: Process NULL-padded row [${levelIndex}]`);

	compiler.resolveAddress(addrSkipNullPadEof);
}
