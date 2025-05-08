import { Opcode } from '../vdbe/opcodes.js';
import { StatusCode, SqlDataType } from '../common/types.js';
import { SqliteError } from '../common/errors.js';
import { type P4FuncDef, type P4SortKey } from '../vdbe/instruction.js';
import type { Compiler } from './compiler.js'; // Ensure HavingContext is imported
import type { ColumnResultInfo, HavingContext } from './structs.js';
import type * as AST from '../parser/ast.js';
import type { ArgumentMap } from './handlers.js';
import type { TableSchema } from '../schema/table.js'; // Import TableSchema only
import type { ColumnSchema } from '../schema/column.js'; // Import ColumnSchema from correct location
import type { SubqueryCorrelationResult } from './correlation.js';
import { setupWindowSorter, type WindowSorterInfo } from './window.js'; // Import window setup function
import { expressionToString } from '../util/ddl-stringify.js';
import { MemoryTableModule } from '../vtab/memory/module.js';
// --- NEW IMPORTS for Refactoring ---
import { type ProcessRowCallback } from './select-loop.js';
import { processRowAggregate, compileAggregateOutput } from './select-aggregate.js';
import { processRowDirect, compileSortOutput } from './select-output.js';
import { processRowWindow, compileWindowOutput } from './select-window.js';
import { getExpressionCollation } from './utils.js'; // Import needed utility
import { planQueryExecution } from './planner/query-planner.js';
import type { PlannedStep } from './planner/types.js';
import { compilePlannedStepsLoop } from './select-loop.js';
import { createLogger } from '../common/logger.js';
import type { RowProcessingContext } from './select-loop.js'; // Add import for RowProcessingContext

const log = createLogger('compiler:select');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log.extend('debug');

/**
 * Interface to hold consolidated state for each level in the join structure.
 * This replaces multiple parallel arrays indexed by loop level.
 */
export interface JoinLevelInfo {
	cursor: number;                // The VDBE cursor ID for this level
	schema: TableSchema;           // Schema for the table at this level
	alias: string;                 // Alias used for this level (for lookups)
	joinType?: AST.JoinClause['joinType'] | 'cross'; // Type of join connecting this level to the previous one
	condition?: AST.Expression;    // ON condition expression for this join
	usingColumns?: string[];       // USING columns for this join
	// VDBE State (populated during compilation)
	loopStartAddr?: number;        // Address of loop start
	eofAddr?: number;              // Address to jump to when EOF reached (for VNext)
	joinFailAddr?: number;         // Address to jump to when join condition fails
	matchReg?: number;             // For LEFT JOINs: register containing match flag
	vFilterEofPlaceholder?: number; // Dedicated placeholder for VFilter jump
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
	const subqueryResult = compiler.getSelectCoreStructure(node.subquery, []);

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
			warnLog(`Duplicate column name "%s" in subquery %s. Renaming to %s_%d.`, name, alias, name, index);
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

	// Instantiate the MemoryTableModule for this subquery source
	const subqueryMemoryModule = new MemoryTableModule();

	// Create the final schema object, including mandatory fields
	const subquerySchema: TableSchema = {
		name: alias,
		schemaName: 'main', // Or should this be temp? Subqueries are transient. Let's use 'main' for lookup consistency.
		columns: tempColumns,
		columnIndexMap: tempColumnIndexMap,
		primaryKeyDefinition: [], // Subqueries generally don't have a defined PK unless explicit
		checkConstraints: [],
		vtabModule: subqueryMemoryModule, // Assign module
		vtabModuleName: 'memory', // Indicate it uses memory internally
		isTemporary: true, // Mark as temporary
		isView: false,
		isStrict: false,
		isWithoutRowid: true, // Subquery results don't have inherent rowids
		subqueryAST: node.subquery,
		// Initialize other mandatory TableSchema fields if necessary
	};

	compiler.resultColumns = outerResultColumns;
	compiler.columnAliases = outerColumnAliases;

	const cursor = compiler.allocateCursor();
	compiler.tableAliases.set(alias, cursor);
	compiler.tableSchemas.set(cursor, subquerySchema);

	log(`Compiled subquery source '%s' with cursor %d and %d columns.`, alias, cursor, subquerySchema.columns.length);
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
	warnLog(`Schema lookup for table function '%s' not implemented. Using placeholder schema.`, functionName);

	// Find the actual module to assign to vtabModule
	const moduleInfo = compiler.db._getVtabModule(functionName);
	if (!moduleInfo) {
		// This should have been caught earlier, but double-check
		throw new SqliteError(`Module not found for TVF ${functionName}`, StatusCode.INTERNAL);
	}

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
		vtabModule: moduleInfo.module, // Assign the actual looked-up module
		vtabModuleName: functionName,   // Store the name it was registered with
		isTemporary: true, // TVF results are typically transient
		isView: false,
		isStrict: false,
		isWithoutRowid: true, // TVF results likely don't have inherent rowids
	};
	const functionSchema = placeholderSchema; // Use placeholder for now

	// --- Allocate cursor and register ---
	const cursor = compiler.allocateCursor();
	compiler.tableAliases.set(alias, cursor);
	compiler.tableSchemas.set(cursor, functionSchema); // Use the looked-up or placeholder schema

	log(`Compiled function source '%s' aliased as '%s' with cursor %d.`, functionName, alias, cursor);
}

// --- SELECT Statement Compilation --- //

// Helper function to check if a result column is an aggregate function call
function isAggregateResultColumn(compiler: Compiler, col: AST.ResultColumn): boolean {
	if (col.type !== 'column' || col.expr?.type !== 'function') {
		return false;
	}
	const funcExpr = col.expr as AST.FunctionExpr;
	// Look up function definition in the schema
	const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length);
	// It's an aggregate if xStep or xFinal is defined
	return !!(funcDef && (funcDef.xStep || funcDef.xFinal));
}

// Helper function to check if a result column is a window function
function isWindowFunctionColumn(col: AST.ResultColumn): boolean {
	return col.type === 'column' && col.expr?.type === 'windowFunction';
}

// Helper function to get expressions from a GROUP BY clause
export function getGroupKeyExpressions(stmt: AST.SelectStmt): AST.Expression[] {
	return stmt.groupBy || [];
}

export function compileSelectStatement(compiler: Compiler, stmt: AST.SelectStmt): void {
	if (!stmt.from || stmt.from.length === 0) {
		compileSelectNoFrom(compiler, stmt);
		return;
	}

	// --- BEGIN PRE-PASS for Subqueries/Functions in FROM --- //
	// Pre-compile FROM clause subquery/function sources to register their schemas/cursors
	const pendingSubqueries: AST.SubquerySource[] = [];
	const pendingFunctionSources: AST.FunctionSource[] = []; // Added for FunctionSource

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

	// --- Call compileFromCoreHelper EARLY to populate alias map --- //
	const fromCursors = compiler.compileFromCore(stmt.from);
	if (fromCursors.length === 0 && stmt.from && stmt.from.length > 0) {
		// This might happen if FROM contains only CTEs that aren't materialized yet
		// Revisit if this scenario causes issues.
		warnLog("compileFromCore returned no cursors for a non-empty FROM clause. Check CTE handling.");
	}
	// --- === NEW: Call Query Planner === --- //
	log("--- Starting Query Planning --- ");
	const plannedSteps = planQueryExecution(compiler, stmt);
	compiler._currentPlannedSteps = plannedSteps; // Store for EXPLAIN
	log("--- Finished Query Planning --- ");
	// --- ============================== --- //

	// Check if the plan satisfies the ORDER BY clause
	let isOrderConsumedByPlan = false;
	if (stmt.orderBy && stmt.orderBy.length > 0 && plannedSteps.length > 0) {
		let currentStep: PlannedStep | undefined = plannedSteps[plannedSteps.length - 1];
		while (currentStep) {
			if (currentStep.type === 'Scan') {
				isOrderConsumedByPlan = currentStep.orderByConsumed;
				break; // Found the originating scan
			} else if (currentStep.type === 'Join') {
				if (!currentStep.preservesOuterOrder) {
					isOrderConsumedByPlan = false; // Order broken by this join
					break;
				}
				// Move to the outer step that provided the order
				currentStep = currentStep.outerStep;
			} else {
				// Unknown step type, assume order is not consumed
				isOrderConsumedByPlan = false;
				break;
			}
		}
	}

	// Check for window functions, aggregates etc. (as before, but may need adjustment based on plannedSteps)
	const windowColumns = stmt.columns.filter(isWindowFunctionColumn) as {
		type: 'column';
		expr: AST.WindowFunctionExpr;
		alias?: string;
	}[];
	const hasWindowFunctions = windowColumns.length > 0;
	const hasGroupBy = !!stmt.groupBy && stmt.groupBy.length > 0;
	const aggregateColumns = stmt.columns.filter(col => isAggregateResultColumn(compiler, col)) as ({ type: 'column', expr: AST.FunctionExpr, alias?: string })[];
	const hasAggregates = aggregateColumns.length > 0;
	const needsAggProcessing = hasAggregates || hasGroupBy;

	compiler.resultColumns = [];
	compiler.columnAliases = [];

	// Determine if ORDER BY is needed (logic might need adjustment)
	// The original check relied on cursorPlanningInfo, which is populated *by* the new planner.
	// We need to check the *final* plan's capability to produce the order.
	let needsExternalSort = false;
	let sortKeyInfo: P4SortKey | null = null;
	if (stmt.orderBy && stmt.orderBy.length > 0) {
		// TODO: Determine orderByConsumed based on the final step in plannedSteps
		// This requires the planner to potentially propagate orderByConsumed property.
		// For now, assume external sort is needed if ORDER BY exists.
		// warnLog("OrderByConsumed check based on new planner output not implemented. Assuming external sort.");
		// needsExternalSort = true;
		// --- NEW Logic --- >
		if (!isOrderConsumedByPlan) {
			log("Plan does not consume ORDER BY, external sort needed.");
			needsExternalSort = true;
		} else {
			log("Plan consumes ORDER BY, skipping external sort.");
			needsExternalSort = false;
		}
		// < --- END NEW Logic ---
	}

	// ... (Window sorter setup, core compilation, final column mapping etc. as before) ...
	// NOTE: compileSelectCore might need adjustment if it relies heavily on the old join structure/planning
	let windowSorterInfo: WindowSorterInfo | undefined;
	let sharedFrameDefinition: AST.WindowFrame | undefined;
	let ephSortCursor = -1;
	let ephSortSchema: TableSchema | undefined;
	let regLimit = 0;
	let regOffset = 0;
	let finalResultBaseReg = 0;
	let finalNumCols = 0;
	let finalColumnMap: ColumnResultInfo[] = [];
	// Aggregate specific registers
	let regAggKey: number = 0;
	let regAggArgs: number = 0;
	let regAggSerializedKey: number = 0;
	// Placeholder for innermost loop jump target
	let placeholderVNextAddr: number = 0;

	// Prepare for window functions if needed
	if (hasWindowFunctions) {
		windowSorterInfo = setupWindowSorter(compiler, stmt);
		if (windowColumns.length > 0 && windowColumns[0].expr.window?.frame) {
			sharedFrameDefinition = windowColumns[0].expr.window.frame;
		}
		const winSortCursor = windowSorterInfo.cursor;
		const winSortSchema = compiler.createEphemeralSchema(
			winSortCursor,
			windowSorterInfo.schema.columns.length,
			windowSorterInfo.sortKeyP4
		);
		compiler.emit(Opcode.OpenEphemeral, winSortCursor, windowSorterInfo.schema.columns.length, 0, winSortSchema, 0, "Open Window Function Sorter");
	}

	// Compile core once to get the structure (needed for all paths)
	const coreResult = compiler.getSelectCoreStructure(stmt, fromCursors);
	const coreResultBaseReg = coreResult.resultBaseReg; // Base of the raw row data
	const coreNumCols = coreResult.numCols;
	const coreColumnMap = coreResult.columnMap;

	// --- Determine Final Column Structure and Aliases (logic as before) --- //
	if (hasWindowFunctions && windowSorterInfo) {
		// ... (Window function column mapping logic - assume exists) ...
		finalColumnMap = []; // Placeholder - restore actual logic if needed
		stmt.columns.forEach((col, idx) => {
			if (col.type === 'column') {
				if (col.expr && col.expr.type === 'windowFunction') {
					const winExpr = col.expr as AST.WindowFunctionExpr;
					const placeholderInfo = windowSorterInfo!.windowResultPlaceholders.get(winExpr);
					if (!placeholderInfo) {
						throw new SqliteError(`Internal error: Window function placeholder not found for ${winExpr.function.name}`, StatusCode.INTERNAL);
					}
					finalColumnMap.push({
						targetReg: placeholderInfo.resultReg,
						sourceCursor: -1,
						sourceColumnIndex: placeholderInfo.sorterIndex,
						expr: winExpr
					});
				} else if (col.expr) {
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
		// Set window function aliases (assuming logic is similar, might need specific handling)
		compiler.columnAliases = finalColumnMap.map((info: ColumnResultInfo, idx: number) => {
			const alias = (info.expr as any)?.alias;
			if (alias) return alias;
			if (info.expr?.type === 'windowFunction') return `win_func_${idx}`;
			if (info.expr && info.expr.loc) { // Check if loc exists
				// Use original SQL source substring for default name
				const startOffset = info.expr.loc.start.offset;
				const endOffset = info.expr.loc.end.offset;
				// Use compiler.sql
				if (compiler.sql && startOffset !== undefined && endOffset !== undefined && startOffset < endOffset) {
					const originalExprText = compiler.sql.substring(startOffset, endOffset);
					// Trim potentially leading/trailing whitespace from the raw substring
					const trimmedExprText = originalExprText.trim();
					if (trimmedExprText.length > 0) return trimmedExprText;
				}
				// Fallback if source/offsets are invalid or result is empty
			}
			return `col${idx}`;
		});

	} else if (needsAggProcessing) {
		// ... (Determine finalColumnMap, finalResultBaseReg, finalNumCols for Aggregation) ...
		finalColumnMap = [];
		let currentResultReg = compiler.allocateMemoryCells(1);
		finalResultBaseReg = currentResultReg;
		if (hasGroupBy) {
			stmt.groupBy!.forEach((expr, i) => {
				finalColumnMap.push({ targetReg: currentResultReg++, sourceCursor: -1, sourceColumnIndex: -1, expr: expr });
			});
		}
		aggregateColumns.forEach(aggCol => {
			finalColumnMap.push({ targetReg: currentResultReg++, sourceCursor: -1, sourceColumnIndex: -1, expr: aggCol.expr });
		});
		finalNumCols = finalColumnMap.length;
		if (finalNumCols === 0 && !hasGroupBy) {
			finalNumCols = 1;
			if (finalResultBaseReg === 0) {
				finalResultBaseReg = compiler.allocateMemoryCells(1);
			}
		}

		// Set aggregate aliases (restore previous logic)
		compiler.columnAliases = finalColumnMap.map((info: ColumnResultInfo, idx: number) => {
			const alias = (info.expr as any)?.alias;
			if (alias) return alias;
			if (info.expr?.type === 'column') {
				return (info.expr as AST.ColumnExpr).name;
			}
			if (info.expr?.type === 'function') {
				const funcExpr = info.expr as AST.FunctionExpr;
				if (funcExpr.name.toLowerCase() === 'count' && funcExpr.args.length === 0) {
					const funcDef = compiler.db._findFunction(funcExpr.name, 0);
					if (funcDef?.name.toLowerCase() === 'count' && funcDef.numArgs === 0) {
						return 'count(*)';
					}
				}
			}
			if (info.expr && info.expr.loc) { // Check if loc exists
				// Use original SQL source substring for default name
				const startOffset = info.expr.loc.start.offset;
				const endOffset = info.expr.loc.end.offset;
				// Use compiler.sql
				if (compiler.sql && startOffset !== undefined && endOffset !== undefined && startOffset < endOffset) {
					const originalExprText = compiler.sql.substring(startOffset, endOffset);
					// Trim potentially leading/trailing whitespace from the raw substring
					const trimmedExprText = originalExprText.trim();
					if (trimmedExprText.length > 0) return trimmedExprText;
				}
				// Fallback if source/offsets are invalid or result is empty
			}
			return `col${idx}`;
		});

		// Allocate aggregate registers
		let allocatedAggKeyReg: number;
		let allocatedAggArgsReg: number;
		let allocatedAggSerKeyReg: number;
		if (hasGroupBy) {
			const groupKeyExprCount = getGroupKeyExpressions(stmt).length;
			allocatedAggKeyReg = compiler.allocateMemoryCells(groupKeyExprCount);
		} else {
			allocatedAggKeyReg = compiler.allocateMemoryCells(1);
		}
		const maxAggArgs = aggregateColumns.reduce((max, col) => Math.max(max, col.expr.args.length), 0);
		allocatedAggArgsReg = compiler.allocateMemoryCells(Math.max(1, maxAggArgs));
		allocatedAggSerKeyReg = compiler.allocateMemoryCells(1);
		debugLog(`DEBUG: Allocated agg regs: Key=${allocatedAggKeyReg}, Args=${allocatedAggArgsReg}, SerKey=${allocatedAggSerKeyReg}`);

	} else {
		// Direct output uses core structure
		finalResultBaseReg = coreResultBaseReg;
		finalColumnMap = coreColumnMap;
		finalNumCols = coreNumCols;
		// Set direct output aliases (restore previous logic)
		compiler.columnAliases = coreColumnMap.map((info: ColumnResultInfo, idx: number) => {
			const alias = (info.expr as any)?.alias;
			if (alias) return alias;
			if (info.expr?.type === 'column') {
				if (info.sourceCursor >= 0 && info.sourceColumnIndex >= 0) {
					const schema = compiler.tableSchemas.get(info.sourceCursor);
					if (schema) {
						const colSchema = schema.columns[info.sourceColumnIndex];
						if (colSchema) return colSchema.name;
					}
				}
				return (info.expr as AST.ColumnExpr).name;
			}
			if (info.expr && info.expr.loc) { // Check if loc exists
				// Use original SQL source substring for default name
				const startOffset = info.expr.loc.start.offset;
				const endOffset = info.expr.loc.end.offset;
				// Use compiler.sql
				if (compiler.sql && startOffset !== undefined && endOffset !== undefined && startOffset < endOffset) {
					const originalExprText = compiler.sql.substring(startOffset, endOffset);
					// Trim potentially leading/trailing whitespace from the raw substring
					const trimmedExprText = originalExprText.trim();
					if (trimmedExprText.length > 0) return trimmedExprText;
				}
				// Fallback if source/offsets are invalid or result is empty
			}
			return `col${idx}`;
		});
	}

	// --- Build Sort Key Info and Prepare External Sorter (AFTER final structure known) --- //
	if (needsExternalSort && !hasWindowFunctions) {
		// ... (build sortKeyInfo as before, using finalColumnMap or coreColumnMap)
		const columnMapForSort = needsAggProcessing ? finalColumnMap : coreColumnMap;
		const keyIndices: number[] = [];
		const collations: string[] = [];
		const directions: boolean[] = [];

		stmt.orderBy!.forEach(orderTerm => {
			let found = false;
			const exprStr = expressionToString(orderTerm.expr);
			for (let i = 0; i < columnMapForSort.length; i++) {
				const colInfo = columnMapForSort[i];
				if (colInfo.expr && expressionToString(colInfo.expr) === exprStr) {
					keyIndices.push(i);
					const collation = getExpressionCollation(compiler, orderTerm.expr).toUpperCase() || 'BINARY';
					collations.push(collation);
					directions.push(orderTerm.direction?.toUpperCase() === 'DESC');
					found = true;
					break;
				}
			}
			if (!found) {
				throw new SqliteError(`ORDER BY expression '${exprStr}' not found in result columns...`, StatusCode.ERROR);
			}
		});

		if (keyIndices.length > 0) {
			sortKeyInfo = { type: 'sortkey', keyIndices, collations, directions };
		}

		ephSortCursor = compiler.allocateCursor();
		ephSortSchema = compiler.createEphemeralSchema(ephSortCursor, finalNumCols, sortKeyInfo ?? undefined);
		compiler.emit(Opcode.OpenEphemeral, ephSortCursor, finalNumCols, 0, ephSortSchema, 0, "Open ORDER BY Sorter");
	}

	// --- Define Row Processing Callback variable (as before) --- //
	let processRowCallback: ProcessRowCallback = (
		_compiler: Compiler,
		_stmt: AST.SelectStmt | null,
		_plannedSteps: PlannedStep[],
		_activeOuterCursors: ReadonlySet<number>,
		_context: RowProcessingContext // Changed to context object
	) => processRowDirect(
		compiler, stmt, _plannedSteps, _activeOuterCursors, _context,
		needsExternalSort, ephSortCursor, ephSortSchema, regLimit, regOffset
	);
	// --- Determine and Assign Specific Row Processing Callback (as before) --- //
	if (hasWindowFunctions && windowSorterInfo) {
		processRowCallback = (
			_compiler: Compiler,
			_stmt: AST.SelectStmt | null,
			_plannedSteps: PlannedStep[],
			_activeOuterCursors: ReadonlySet<number>,
			_context: RowProcessingContext // Changed to context object
		) => processRowWindow(compiler, stmt, coreColumnMap, windowSorterInfo!, _context); // Add context
	} else if (needsAggProcessing) {
		// ... (allocate agg regs) ...
		const allocatedAggKeyReg = finalColumnMap.find(info => info.expr?.type !== 'function') ? compiler.allocateMemoryCells(getGroupKeyExpressions(stmt).length) : compiler.allocateMemoryCells(1);
		const maxAggArgs = aggregateColumns.reduce((max, col) => Math.max(max, col.expr.args.length), 0);
		const allocatedAggArgsReg = compiler.allocateMemoryCells(Math.max(1, maxAggArgs));
		const allocatedAggSerKeyReg = compiler.allocateMemoryCells(1);
		log(`DEBUG: Values passed to callback: Key=${allocatedAggKeyReg}, Args=${allocatedAggArgsReg}, SerKey=${allocatedAggSerKeyReg}`);
		processRowCallback = (
			_compiler: Compiler,
			_stmt: AST.SelectStmt | null,
			_plannedSteps: PlannedStep[],
			_activeOuterCursors: ReadonlySet<number>,
			_context: RowProcessingContext // Changed to context object
		) => processRowAggregate(
			compiler, stmt, aggregateColumns,
			allocatedAggKeyReg, allocatedAggArgsReg, allocatedAggSerKeyReg,
			hasGroupBy,
			_context // Add context parameter
		);
	}

	// --- Compile Main Loop using the NEW planner output --- //
	// TODO: Replace compileSelectLoop with compilePlannedStepsLoop
	// warnLog("Loop generation using compileSelectLoop is DEPRECATED and needs replacement with compilePlannedStepsLoop.");
	// Placeholder call - This WILL likely fail or produce incorrect code!
	// const { innermostLoopStartAddr, innermostLoopEndAddrPlaceholder } = compileSelectLoop(
	// 	compiler,
	// 	stmt,
	// 	[], // Pass empty array - compileSelectLoop needs replacement
	// 	fromCursors,
	// 	processRowCallback
	// );
	// === Replace Placeholder with Actual Call ===
	// Ensure that finalColumnMap is properly initialized before passing to compilePlannedStepsLoop.
	// The finalColumnMap is used by processRowCallback functions to handle LEFT JOIN padding
	// by determining which columns come from which relations.
	const { innermostLoopStartAddr, innermostLoopEndAddrPlaceholder } = compilePlannedStepsLoop(
		compiler,
		stmt,
		plannedSteps, // Pass the actual plan
		fromCursors, // Still needed for compileUnhandledWhereConditions
		processRowCallback,
		finalColumnMap, // Pass finalColumnMap for LEFT JOIN padding context
		coreColumnMap   // <<<< ADDED
	);
	// =========================================

	// --- DEFINE finalExitAddr Placeholder --- //
	const finalExitAddr = compiler.allocateAddress("finalSelectExit");

	// Resolve the placeholder for the end of all loops (jumps here before post-processing)
	compiler.resolveAddress(innermostLoopEndAddrPlaceholder);

	// --- Compile Post-Loop Output Processing (as before) --- //
	if (hasWindowFunctions && windowSorterInfo) {
		compileWindowOutput(compiler, windowSorterInfo, finalColumnMap, sharedFrameDefinition, regLimit, regOffset, finalExitAddr);
	} else if (needsAggProcessing) {
		compileAggregateOutput(compiler, stmt, finalColumnMap, finalResultBaseReg, finalNumCols, needsExternalSort, ephSortCursor, ephSortSchema, regLimit, regOffset, hasGroupBy, aggregateColumns, finalExitAddr);
	} else if (needsExternalSort) {
		compileSortOutput(compiler, ephSortCursor, ephSortSchema!, finalNumCols, regLimit, regOffset, finalExitAddr);
	}

	// Resolve the final exit point AFTER all post-processing
	compiler.resolveAddress(finalExitAddr); // The above Goto jumps here

	// --- Close Cursors --- //
	if (ephSortCursor !== -1) {
		compiler.emit(Opcode.Close, ephSortCursor, 0, 0, null, 0, "Close ORDER BY Sorter");
	}
	if (windowSorterInfo) {
		compiler.emit(Opcode.Close, windowSorterInfo.cursor, 0, 0, null, 0, "Close Window Sorter");
	}
	// Close cursors based on the actual plan executed
	const cursorsToClose = new Set<number>();
	plannedSteps.forEach(step => {
		if (step.type === 'Scan') {
			step.relation.contributingCursors.forEach(c => cursorsToClose.add(c));
		} else if (step.type === 'Join') {
			step.outputRelation.contributingCursors.forEach(c => cursorsToClose.add(c));
		}
		// TODO: Add logic for other step types if they introduce cursors
	});
	cursorsToClose.forEach(cursorId => {
		const alias = [...compiler.tableAliases.entries()].find(([, cIdx]) => cIdx === cursorId)?.[0] || `cursor ${cursorId}`;
		compiler.emit(Opcode.Close, cursorId, 0, 0, null, 0, `Close FROM Cursor ${alias}`);
	});
}

/** Handle SELECT without FROM - simpler case */
function compileSelectNoFrom(compiler: Compiler, stmt: AST.SelectStmt): void {
	// Compile expressions to get column names and result registers
	const { resultBaseReg, numCols, columnMap } = compiler.getSelectCoreStructure(stmt, []);

	// Set final column aliases
	compiler.columnAliases = columnMap.map((info, idx) => {
		return (info.expr as any)?.alias
			?? (info.expr?.type === 'column' ? (info.expr as AST.ColumnExpr).name : `col${idx}`);
	});

	// --- Compile WHERE clause if present (rare for no FROM, but possible) --- //
	if (stmt.where) {
		const whereReg = compiler.allocateMemoryCells(1);
		const addrSkipResult = compiler.allocateAddress('noFromResultSkip');
		compiler.compileExpression(stmt.where, whereReg);
		compiler.emit(Opcode.IfFalse, whereReg, addrSkipResult, 0, null, 0, "Check WHERE for constant SELECT");
		compiler.emit(Opcode.ResultRow, resultBaseReg, numCols, 0, null, 0, "Output constant result row");
		compiler.resolveAddress(addrSkipResult);
	} else {
		compiler.emit(Opcode.ResultRow, resultBaseReg, numCols, 0, null, 0, "Output constant result row");
	}
}
