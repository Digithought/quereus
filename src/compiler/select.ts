import { Opcode } from '../vdbe/opcodes.js';
import { StatusCode, SqlDataType } from '../common/types.js';
import { SqliteError } from '../common/errors.js';
import { type P4FuncDef, type P4SortKey } from '../vdbe/instruction.js';
import type { Compiler, ColumnResultInfo, HavingContext } from './compiler.js'; // Ensure HavingContext is imported
import type * as AST from '../parser/ast.js';
import type { ArgumentMap } from './handlers.js';
import type { TableSchema } from '../schema/table.js'; // Import TableSchema only
import type { ColumnSchema } from '../schema/column.js'; // Import ColumnSchema from correct location
import type { SubqueryCorrelationResult } from './correlation.js';
import { setupWindowSorter, type WindowSorterInfo } from './window.js'; // Import window setup function
import { expressionToString } from '../util/ddl-stringify.js';
import { MemoryTableModule } from '../vtab/memory/module.js';
// --- NEW IMPORTS for Refactoring ---
import { compileSelectLoop, type ProcessRowCallback } from './select-loop.js';
import { processRowAggregate, compileAggregateOutput } from './select-aggregate.js';
import { processRowDirect, compileSortOutput } from './select-output.js';
import { processRowWindow, compileWindowOutput } from './select-window.js';
import { compileJoinCondition, emitLeftJoinNullPadding } from './join.js'; // Added emitLeftJoinNullPadding
import { getExpressionCollation } from './utils.js'; // Import needed utility

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
	console.warn(`Schema lookup for table function '${functionName}' not implemented. Using placeholder schema.`);

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

	console.log(`Compiled function source '${functionName}' aliased as '${alias}' with cursor ${cursor}.`);
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

	// --- BEGIN PRE-PASS ---
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
		console.warn("compileFromCore returned no cursors for a non-empty FROM clause. Check CTE handling.");
	}
	// ------------------------------------------------------------------ //

	// Pre-process join levels to gather information about the structure
	const joinLevels = preprocessJoinLevels(compiler, stmt.from);
	// Ensure fromCursors count matches joinLevels count (sanity check)
	if (fromCursors.length !== joinLevels.length) {
		console.error(`Mismatch between fromCursors (${fromCursors.length}) and joinLevels (${joinLevels.length})`);
		// Potentially throw an error here or try to reconcile
	}

	// Check for window functions
	const windowColumns = stmt.columns.filter(isWindowFunctionColumn) as {
		type: 'column';
		expr: AST.WindowFunctionExpr;
		alias?: string;
	}[];
	const hasWindowFunctions = windowColumns.length > 0;

	const hasGroupBy = !!stmt.groupBy && stmt.groupBy.length > 0;
	const aggregateColumns = stmt.columns.filter(col => isAggregateResultColumn(compiler, col)) as ({ type: 'column', expr: AST.FunctionExpr, alias?: string })[];
	const hasAggregates = aggregateColumns.length > 0;
	const isSimpleAggregate = hasAggregates && !hasGroupBy;
	const needsAggProcessing = hasAggregates || hasGroupBy;

	// Store original result/alias state
	const savedResultColumns = compiler.resultColumns;
	const savedColumnAliases = compiler.columnAliases;
	compiler.resultColumns = [];
	compiler.columnAliases = [];

	// Plan table access early to determine if ORDER BY is consumed
	// Use the `fromCursors` obtained earlier
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
			// Sort key info will be constructed later, after finalColumnMap is known
		}
	}

	let windowSorterInfo: WindowSorterInfo | undefined;
	let sharedFrameDefinition: AST.WindowFrame | undefined;
	let ephSortCursor = -1;
	let ephSortSchema: TableSchema | undefined;
	let regLimit = 0;
	let regOffset = 0;
	let coreResultBaseReg = 0;
	let coreNumCols = 0;
	let coreColumnMap: ColumnResultInfo[] = [];
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
		// Determine final structure for Aggregation
		finalColumnMap = [];
		let currentResultReg = compiler.allocateMemoryCells(1); // Start allocating regs for final results
		finalResultBaseReg = currentResultReg; // Store the base

		// Add group key columns to map (only if GROUP BY exists)
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

		// Handle cases like SELECT COUNT(*) where finalColumnMap might be empty but we need a result column
		if (finalNumCols === 0 && !hasGroupBy) {
			finalNumCols = 1; // Ensure at least one cell for simple aggregate
			// Re-allocate base register if needed (should usually be covered by initial allocation)
			if (finalResultBaseReg === 0) { // Check if it wasn't allocated
				finalResultBaseReg = compiler.allocateMemoryCells(1);
			}
			// Add a placeholder entry if needed for alias setting?
			// Or rely on compileAggregateOutput to handle this case?
			// Let's assume compileAggregateOutput handles the AggFinal into finalResultBaseReg correctly.
		}

		// Set column aliases based on the final structure *now*
		// This is needed *before* potentially setting up the sorter based on aliases
		compiler.columnAliases = finalColumnMap.map((info, idx) =>
			// Use alias if provided
			(info.expr as any)?.alias
			// Use column name if it's a simple column expression without alias
			?? (info.expr?.type === 'column') ? (info.expr as AST.ColumnExpr).name : (
				// Use stringified expression if possible
				(info.expr && expressionToString(info.expr))
					// Fallback to default colN name
					?? `col${idx}`
			)
		);

	} else {
		// Direct output uses core structure initially
		finalResultBaseReg = coreResultBaseReg;
		finalColumnMap = coreColumnMap;
		finalNumCols = coreNumCols;
	}

	// --- Build Sort Key Info and Prepare External Sorter (if needed) ---
	if (needsExternalSort && !hasWindowFunctions) {
		const columnMapForSort = needsAggProcessing ? finalColumnMap : coreColumnMap;
		const keyIndices: number[] = [];
		const collations: string[] = [];
		const directions: boolean[] = []; // true for DESC, false for ASC

		stmt.orderBy!.forEach(orderTerm => {
			let found = false;
			const exprStr = expressionToString(orderTerm.expr);
			for (let i = 0; i < columnMapForSort.length; i++) {
				const colInfo = columnMapForSort[i];
				if (colInfo.expr && expressionToString(colInfo.expr) === exprStr) {
					keyIndices.push(i); // Index within the ephemeral sorter table
					// Get collation directly from the expression
					const collation = getExpressionCollation(compiler, orderTerm.expr).toUpperCase()
						|| 'BINARY'; // Default to BINARY if somehow not determined
					collations.push(collation);
					// Convert direction to uppercase for comparison
					directions.push(orderTerm.direction?.toUpperCase() === 'DESC');
					found = true;
					break;
				}
			}
			if (!found) {
				// Handle ORDER BY expressions not directly in the SELECT list (e.g., ORDER BY hidden_col)
				// This requires adding the expression to the sorter table which isn't implemented yet.
				throw new SqliteError(`ORDER BY expression '${exprStr}' not found in result columns. Sorting by complex expressions not directly selected is not yet supported.`, StatusCode.ERROR);
			}
		});

		// Add the required 'type' property and ensure it's not null
		if (keyIndices.length > 0) { // Only create sortKeyInfo if there are keys
			sortKeyInfo = { type: 'sortkey', keyIndices, collations, directions };
		}

		ephSortCursor = compiler.allocateCursor();
		// Pass sortKeyInfo which is now P4SortKey | null, handle null case
		ephSortSchema = compiler.createEphemeralSchema(ephSortCursor, finalNumCols, sortKeyInfo ?? undefined);
		compiler.emit(Opcode.OpenEphemeral, ephSortCursor, finalNumCols, 0, ephSortSchema, 0, "Open ORDER BY Sorter");
	}

	// --- Define Row Processing Callback ---
	let processRowCallback: ProcessRowCallback;
	if (hasWindowFunctions && windowSorterInfo) {
		processRowCallback = (
			_compiler, _stmt, _joinLevels, _activeOuterCursors, _innermostWhereFailTarget
		) => processRowWindow(compiler, stmt, coreColumnMap, windowSorterInfo!); // Use core map for window input
	} else if (needsAggProcessing) {
		const maxAggArgs = aggregateColumns.reduce((max, col) => Math.max(max, col.expr.args.length), 0);
		regAggArgs = compiler.allocateMemoryCells(Math.max(1, maxAggArgs));
		regAggSerializedKey = compiler.allocateMemoryCells(1);
		// ---------------------------------
		console.log(`DEBUG: Allocated agg regs: Key=${regAggKey}, Args=${regAggArgs}, SerKey=${regAggSerializedKey}`); // <-- Log allocated values

		// Store allocated regs in separate consts for clarity in closure
		const allocatedAggKeyReg = regAggKey;
		const allocatedAggArgsReg = regAggArgs;
		const allocatedAggSerKeyReg = regAggSerializedKey;

		console.log(`DEBUG: Values passed to callback: Key=${allocatedAggKeyReg}, Args=${allocatedAggArgsReg}, SerKey=${allocatedAggSerKeyReg}`); // <-- Log values going into closure

		processRowCallback = (
			_compiler, _stmt, _joinLevels, _activeOuterCursors, _innermostWhereFailTarget
		) => processRowAggregate(
			compiler, stmt, aggregateColumns,
			allocatedAggKeyReg,
			allocatedAggArgsReg, // Pass via new const
			allocatedAggSerKeyReg,
			hasGroupBy
		);
	} else {
		processRowCallback = (
			_compiler, _stmt, joinLevelsInner, activeOuterCursorsInner, innermostWhereFailTargetInner
		) => processRowDirect(
			compiler, stmt, joinLevelsInner, activeOuterCursorsInner, innermostWhereFailTargetInner,
			needsExternalSort, ephSortCursor, ephSortSchema, regLimit, regOffset
		);
	}

	// --- Compile Main Loop ---
	const { innermostLoopStartAddr, innermostLoopEndAddrPlaceholder } = compileSelectLoop(
		compiler,
		stmt,
		joinLevels,
		fromCursors,
		processRowCallback
	);

	// --- DEFINE finalExitAddr Placeholder --- //
	// This is the target address for jumps when LIMIT is reached or processing finishes.
	const finalExitAddr = compiler.allocateAddress("finalSelectExit");

	// Resolve the placeholder for the end of all loops (jumps here before post-processing)
	compiler.resolveAddress(innermostLoopEndAddrPlaceholder);

	// --- Compile Post-Loop Output Processing ---
	if (hasWindowFunctions && windowSorterInfo) {
		compileWindowOutput(compiler, windowSorterInfo, finalColumnMap, sharedFrameDefinition, regLimit, regOffset, finalExitAddr);
	} else if (needsAggProcessing) {
		compileAggregateOutput(compiler, stmt, finalColumnMap, finalResultBaseReg, finalNumCols, needsExternalSort, ephSortCursor, ephSortSchema, regLimit, regOffset, hasGroupBy, aggregateColumns, finalExitAddr);
	} else if (needsExternalSort) {
		compileSortOutput(compiler, ephSortCursor, ephSortSchema!, finalNumCols, regLimit, regOffset, finalExitAddr);
	}

	// Resolve the final exit point AFTER all post-processing
	compiler.resolveAddress(finalExitAddr); // The above Goto jumps here

	// --- Close Cursors ---
	if (ephSortCursor !== -1) {
		compiler.emit(Opcode.Close, ephSortCursor, 0, 0, null, 0, "Close ORDER BY Sorter");
	}
	if (windowSorterInfo) {
		compiler.emit(Opcode.Close, windowSorterInfo.cursor, 0, 0, null, 0, "Close Window Sorter");
	}
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
		const addrSkipResult = compiler.allocateAddress('noFromResultSkip');
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
