import { Opcode, ConflictResolution } from '../common/constants';
import { StatusCode } from '../common/types';
import { SqliteError } from '../common/errors';
import { type P4Vtab, type P4FuncDef } from '../vdbe/instruction';
import type { Compiler, ColumnResultInfo } from './compiler';
import type * as AST from '../parser/ast';
import { compileUnhandledWhereConditions, type SubqueryCorrelationResult } from './helpers';

// Helper function to check if a result column is an aggregate function call
function isAggregateResultColumn(col: AST.ResultColumn): boolean {
	return col.type === 'column' && col.expr?.type === 'function' && col.expr.isAggregate === true;
}

// Helper function to get expressions from a GROUP BY clause
function getGroupKeyExpressions(stmt: AST.SelectStmt): AST.Expression[] {
	return stmt.groupBy || [];
}

export function compileSelectStatement(compiler: Compiler, stmt: AST.SelectStmt): void {
	const hasGroupBy = !!stmt.groupBy && stmt.groupBy.length > 0;
	const aggregateColumns = stmt.columns.filter(isAggregateResultColumn) as ({ type: 'column', expr: AST.FunctionExpr, alias?: string })[];
	const hasAggregates = aggregateColumns.length > 0;
	const isSimpleAggregate = hasAggregates && !hasGroupBy; // e.g., SELECT COUNT(*) FROM t
	const needsAggProcessing = hasAggregates || hasGroupBy;

	// Validate selected columns: must be aggregate or part of GROUP BY key
	if (hasGroupBy) {
		const groupKeyExprStrings = new Set(stmt.groupBy!.map(expr => JSON.stringify(expr)));
		stmt.columns.forEach(col => {
			if (col.type === 'column' && !isAggregateResultColumn(col)) {
				if (!groupKeyExprStrings.has(JSON.stringify(col.expr))) {
					throw new SqliteError(`Column "${col.expr?.type === 'column' ? col.expr.name : (col.alias ?? '?')}" must appear in the GROUP BY clause or be used in an aggregate function`, StatusCode.ERROR);
				}
			}
		});
	}

	// Open cursors first based on the FROM structure
	const fromCursors = compiler.compileFromCore(stmt.from);

	if (fromCursors.length === 0 && (!stmt.from || stmt.from.length === 0)) {
		// Handle SELECT without FROM clause (potentially with aggregates like SELECT COUNT(1))
		compileSelectNoFrom(compiler, stmt);
		return;
	}

	// --- Check if Sorting is Required (ORDER BY) ---
	let needsExternalSort = false;
	let orderByConsumed = false;
	let orderByKeyMap: { colIdx: number, desc: boolean }[] = [];
	if (stmt.orderBy && stmt.orderBy.length > 0) {
		// If GROUP BY exists, ORDER BY can only be on GROUP BY keys or aggregates
		// We defer checking ORDER BY consumption until after aggregation
		needsExternalSort = true; // Assume sort is needed after aggregation/grouping
	}
	// ----------------------------------------------------------

	// --- Prepare Ephemeral Table for Sorting (if ORDER BY exists) ---
	let ephSortCursor = -1;
	let ephSortSchema: import("../schema/table").TableSchema | undefined;
	let ephSortNumCols = -1;
	let sortOutputRegMap: number[] = []; // Maps final output column index to eph table index

	if (needsExternalSort) {
		// Schema will be based on the final output of the aggregation/grouping step
		// We need to determine the number and rough type of output columns *after* aggregation
		// This is tricky without running compileSelectCore twice.
		// Let's estimate: number of group keys + number of aggregates
		ephSortNumCols = (stmt.groupBy?.length ?? 0) + aggregateColumns.length;
		if (isSimpleAggregate && !hasGroupBy) ephSortNumCols = aggregateColumns.length; // SELECT COUNT(*) case
		if (ephSortNumCols === 0) ephSortNumCols = 1; // SELECT literal GROUP BY literal?

		console.log(`Needs external sort, preparing ephemeral table with ${ephSortNumCols} columns.`);
		ephSortCursor = compiler.allocateCursor();
		ephSortSchema = compiler.createEphemeralSchema(ephSortCursor, ephSortNumCols);
		// TODO: Refine ephemeral table schema types based on group keys/aggregate results
		compiler.emit(Opcode.OpenEphemeral, ephSortCursor, ephSortNumCols, 0, null, 0, "Open Ephemeral for ORDER BY after Aggregation");
	}
	// -------------------------------------------------------------

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

	// --- Generate Nested Loops for FROM sources ---
	const loopStarts: number[] = [];
	const loopEnds: number[] = [];
	const joinFailTargets: number[] = [];
	const matchFoundRegs: number[] = [];
	const activeOuterCursors = new Set<number>();

	// --- Initialize Aggregation/Sorting related variables outside the block ---
	let finalResultBaseReg = 0;
	let finalNumCols = 0;
	let finalColumnMap: ColumnResultInfo[] = [];
	let groupKeyOutputRegs: number[] = [];

	fromCursors.forEach((cursor, index) => {
		const schema = compiler.tableSchemas.get(cursor);
		if (!schema) throw new SqliteError(`Internal error: Schema not found for cursor ${cursor}`, StatusCode.INTERNAL);

		const loopStartAddr = compiler.allocateAddress();
		const eofTarget = compiler.allocateAddress();
		const joinFailTarget = compiler.allocateAddress();

		loopStarts.push(loopStartAddr);
		loopEnds.push(eofTarget);
		joinFailTargets.push(joinFailTarget);

		const joinType = getJoinTypeForLevel(stmt.from, index);
		const matchReg = (joinType === 'left') ? compiler.allocateMemoryCells(1) : 0;
		matchFoundRegs.push(matchReg);
		if (matchReg > 0) {
			compiler.emit(Opcode.Integer, 0, matchReg, 0, null, 0, `Init LEFT JOIN Match Flag [${index}] = 0`);
		}

		compiler.planTableAccess(cursor, schema, stmt, activeOuterCursors);
		const planningInfo = compiler.cursorPlanningInfo.get(cursor);
		let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
		let regArgsStart = 0;

		if (planningInfo && planningInfo.idxNum !== 0) {
			const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
			planningInfo.usage.forEach((usage, constraintIdx) => {
				if (usage.argvIndex > 0) {
					const expr = planningInfo.constraintExpressions?.get(constraintIdx);
					if (!expr) throw new SqliteError(`Internal error: Missing expression for constraint ${constraintIdx} used in VFilter`, StatusCode.INTERNAL);
					while (argsToCompile.length < usage.argvIndex) { argsToCompile.push(null as any); }
					argsToCompile[usage.argvIndex - 1] = { constraintIdx, expr };
				}
			});
			const finalArgsToCompile = argsToCompile.filter(a => a !== null);
			if (finalArgsToCompile.length > 0) {
				regArgsStart = compiler.allocateMemoryCells(finalArgsToCompile.length);
				finalArgsToCompile.forEach((argInfo, i) => { compiler.compileExpression(argInfo.expr, regArgsStart + i); });
			}
			filterP4 = { idxNum: planningInfo.idxNum, idxStr: planningInfo.idxStr, nArgs: finalArgsToCompile.length };
		}
		compiler.emit(Opcode.VFilter, cursor, eofTarget, regArgsStart, filterP4, 0, `Filter/Scan Cursor ${index}`);
		compiler.resolveAddress(loopStartAddr);
		compiler.verifyWhereConstraints(cursor, joinFailTarget);

		if (index > 0) {
			const joinNode = findJoinNodeConnecting(stmt.from, index - 1, index, compiler);
			if (joinNode && joinType !== 'cross') {
				compileJoinCondition(compiler, joinNode, fromCursors.slice(0, index + 1), joinFailTarget);
			} else if (joinType === 'inner') {
				throw new SqliteError(`Missing ON/USING clause for table at join level ${index}`, StatusCode.ERROR);
			}
		}

		if (index > 0) {
			const outerLevelIndex = index - 1;
			const outerMatchReg = matchFoundRegs[outerLevelIndex];
			if (outerMatchReg > 0) {
				compiler.emit(Opcode.Integer, 1, outerMatchReg, 0, null, 0, `Set LEFT JOIN Match Flag [${outerLevelIndex}] = 1`);
			}
		}
		activeOuterCursors.add(cursor);

	}); // End of FROM loop setup

	// --- Innermost Processing (after all FROM rows are available) ---
	const innermostProcessStartAddr = compiler.getCurrentAddress();
	const innermostWhereFailTarget = compiler.allocateAddress(); // Target if WHERE fails
	const innermostVNextAddr = compiler.allocateAddress(); // Placeholder for innermost VNext jump

	// Compile remaining WHERE conditions
	compileUnhandledWhereConditions(compiler, stmt.where, fromCursors, innermostWhereFailTarget);

	if (needsAggProcessing) {
		// Calculate Group Key and call AggStep
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
			if (!funcDef) throw new Error("Aggregate function definition disappeared?"); // Should not happen

			const firstArgReg = compiler.allocateMemoryCells(funcExpr.args.length || 1); // Need at least 1 for COUNT(*)
			funcExpr.args.forEach((argExpr, i) => {
				compiler.compileExpression(argExpr, firstArgReg + i);
			});

			const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
			// Pass P1=StartReg, P3=SerializedKeyReg, P5=numKeys
			compiler.emit(Opcode.AggStep, regGroupKeyStart, firstArgReg, regSerializedKey, p4, numGroupKeys, `AggStep for ${funcExpr.name}`);
		});

	} else {
		// Not aggregating - calculate results directly
		const { resultBaseReg, numCols, columnMap } = compiler.compileSelectCore(stmt, fromCursors);

		// --- Apply Limit/Offset for non-sorted/non-aggregated results ---
		const addrSkipRowOutput = compiler.allocateAddress();
		if (regLimit > 0) {
			// Offset Check
			compiler.emit(Opcode.IfZero, regOffset, innermostProcessStartAddr + 2, 0, null, 0, "Check Offset"); // Jump past decr if 0
			compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Decrement Offset"); // R[P3] = R[P2] - R[P1]
			compiler.emit(Opcode.Goto, 0, innermostVNextAddr, 0, null, 0, "Skip Row (Offset)"); // Jump to VNext

			// Mark address after offset check (or jump target if offset was 0)
			compiler.resolveAddress(compiler.getCurrentAddress() - 2); // Adjusting jump target resolution
		}
		// -------------------------------------------------------------

		// If sorting needed, store in ephemeral table, otherwise output
		if (needsExternalSort) {
			const insertDataReg = compiler.allocateMemoryCells(numCols + 1);
			compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Sort: NULL Rowid for Eph Insert");
			compiler.emit(Opcode.Move, resultBaseReg, insertDataReg + 1, numCols, null, 0, "Sort: Copy result to Eph Insert Data");
			compiler.emit(Opcode.VUpdate, numCols + 1, insertDataReg, 0, { table: ephSortSchema }, 0, "Sort: Insert Row into Ephemeral");
		} else {
			// Output directly
			compiler.emit(Opcode.ResultRow, resultBaseReg, numCols, 0, null, 0, "Output result row");

			// --- Limit Check for non-sorted/non-aggregated results ---
			if (regLimit > 0) {
				compiler.emit(Opcode.IfZero, regLimit, innermostVNextAddr, 0, null, 0, "Skip Limit Check if 0"); // Skip if limit was 0
				compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Decrement Limit");
				compiler.emit(Opcode.IfZero, regLimit, loopEnds[0], 0, null, 0, "Check Limit Reached"); // Jump to outer loop end if limit hit
			}
			// -----------------------------------------------------------
		}
	}

	// Jump to the VNext of the innermost loop
	compiler.emit(Opcode.Goto, 0, innermostVNextAddr, 0, null, 0, "Goto Innermost VNext");

	// Resolve the target for WHERE failure
	compiler.resolveAddress(innermostWhereFailTarget);
	// If WHERE fails, jump directly to VNext
	compiler.emit(Opcode.Goto, 0, innermostVNextAddr, 0, null, 0, "WHERE Failed, Goto VNext");

	// --- Generate Loop Closing/VNext and LEFT JOIN NULL Padding ---
	for (let i = fromCursors.length - 1; i >= 0; i--) {
		const cursor = fromCursors[i];
		const loopStartAddr = loopStarts[i];
		const eofAddr = loopEnds[i];
		const joinFailAddr = joinFailTargets[i];
		const matchReg = matchFoundRegs[i];

		// Resolve the target for join/where failure at this level
		compiler.resolveAddress(joinFailAddr);

		// Resolve the target for the GOTO after innermost processing
		const currentVNextAddr = compiler.getCurrentAddress();
		if (i === fromCursors.length - 1) {
			compiler.resolveAddress(innermostVNextAddr);
		}

		compiler.emit(Opcode.VNext, cursor, eofAddr, 0, null, 0, `VNext Cursor ${i}`);
		compiler.emit(Opcode.Goto, 0, loopStartAddr, 0, null, 0, `Goto LoopStart ${i}`);
		compiler.resolveAddress(eofAddr);

		// LEFT JOIN EOF NULL Padding
		const joinType = getJoinTypeForLevel(stmt.from, i);
		if (joinType === 'left' && matchReg > 0) {
			const addrSkipNullPadEof = compiler.allocateAddress();
			compiler.emit(Opcode.IfTrue, matchReg, addrSkipNullPadEof, 0, null, 0, `LEFT JOIN EOF: Skip NULL pad if match found [${i}]`);

			// Need to re-run compileSelectCore to know which regs to NULL pad?
			// This is inefficient. Alternative: Store columnMap from a single run.
			// Assuming columnMap is available from the aggregation/result calculation step above.
			// This is complex if the structure differs significantly based on aggregation.
			// Let's assume for now the result structure is predictable enough.
			console.warn("LEFT JOIN NULL padding assumes result structure is consistent - may need refinement");
			const tempCoreResult = compiler.compileSelectCore(stmt, fromCursors); // Re-run to get map for this context
			tempCoreResult.columnMap.forEach(info => {
				if (info.sourceCursor === cursor) {
					compiler.emit(Opcode.Null, 0, info.targetReg, 0, null, 0, `LEFT JOIN EOF: NULL Pad Col ${info.sourceColumnIndex} from Cursor ${cursor}`);
				}
			});

			if (i > 0) {
				const outerMatchReg = matchFoundRegs[i - 1];
				if (outerMatchReg > 0) {
					compiler.emit(Opcode.Integer, 1, outerMatchReg, 0, null, 0, `Set LEFT JOIN Match Flag [${i - 1}] = 1 (due to NULL pad EOF)`);
				}
			}

			// Jump back to the *start* of the innermost processing block
			// This will re-evaluate WHERE, recalculate aggregates/results for the NULL-padded row
			compiler.emit(Opcode.Goto, 0, innermostProcessStartAddr, 0, null, 0, `LEFT JOIN EOF: Process NULL-padded row [${i}]`);

			compiler.resolveAddress(addrSkipNullPadEof);
		}

		if (i > 0) {
			const outerMatchReg = matchFoundRegs[i - 1];
			if (outerMatchReg > 0) {
				compiler.emit(Opcode.Integer, 0, outerMatchReg, 0, null, 0, `Reset LEFT JOIN Match Flag [${i - 1}] before outer VNext`);
			}
		}
		activeOuterCursors.delete(cursor);

	} // End loop closing

	// --- Final Aggregation Result Output --- (If Aggregation was done)
	if (needsAggProcessing) {
		const addrAggLoopStart = compiler.allocateAddress();
		const addrAggLoopEnd = compiler.allocateAddress();
		const regMapIterator = compiler.allocateMemoryCells(1); // Conceptual iterator register
		const regGroupKey = compiler.allocateMemoryCells(1);
		const regAggContext = compiler.allocateMemoryCells(1);

		// Result registers need to be defined *before* the loop
		// Moved declarations outside
		// let finalResultBaseReg = 0;
		// let finalNumCols = 0;
		// let finalColumnMap: ColumnResultInfo[] = []; // Initialize here
		// let groupKeyOutputRegs: number[] = [];

		// Determine the base register and number of columns for the final output *once*
		// Assume the structure is group keys followed by aggregates
		let estimatedFinalNumCols = (stmt.groupBy?.length ?? 0) + aggregateColumns.length;
		if (isSimpleAggregate && !hasGroupBy) estimatedFinalNumCols = aggregateColumns.length;
		if (estimatedFinalNumCols === 0 && hasGroupBy) estimatedFinalNumCols = stmt.groupBy!.length; // Only group keys selected?
		if (estimatedFinalNumCols === 0) estimatedFinalNumCols = 1; // Should have at least one output column?
		finalResultBaseReg = compiler.allocateMemoryCells(estimatedFinalNumCols);

		compiler.emit(Opcode.AggIterate, regMapIterator, 0, 0, null, 0, "Start Aggregate Result Iteration");
		compiler.resolveAddress(addrAggLoopStart);
		compiler.emit(Opcode.AggNext, regMapIterator, addrAggLoopEnd, 0, null, 0, "Next Aggregate Group");

		// Get Key and Context for the current group
		compiler.emit(Opcode.AggKey, regMapIterator, regGroupKey, 0, null, 0, "Get Group Key");
		compiler.emit(Opcode.AggContext, regMapIterator, regAggContext, 0, null, 0, "Get Aggregate Context");

		// Reconstruct Output Row (Group Keys + Aggregates)
		let currentResultReg = finalResultBaseReg; // Use the pre-allocated base
		finalColumnMap = []; // Clear map for this group's output structure
		let currentNumCols = 0; // Track columns *for this group*
		sortOutputRegMap = [];

		// 1. Output Group Key Columns (if GROUP BY)
		if (hasGroupBy) {
			groupKeyOutputRegs = [];
			stmt.groupBy!.forEach((expr, i) => {
				const keyReg = currentResultReg++;
				compiler.emit(Opcode.AggGroupValue, regMapIterator, i, keyReg, null, 0, `Output Group Key ${i}`);
				// finalNumCols++; // Counted already
				currentNumCols++; // Increment count for this group
				groupKeyOutputRegs.push(keyReg);
				finalColumnMap.push({ targetReg: keyReg, sourceCursor: -1, sourceColumnIndex: -1, expr: expr }); // Link to original expr
				// sortOutputRegMap.push(keyReg); // Map based on final index
			});
		}

		// 2. Output Aggregate Function Results
		aggregateColumns.forEach(aggCol => {
			const funcExpr = aggCol.expr;
			const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length)!;
			const aggResultReg = currentResultReg++;
			const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
			compiler.emit(Opcode.AggFinal, regAggContext, 0, aggResultReg, p4, 0, `AggFinal for ${funcExpr.name}`);
			// finalNumCols++; // Counted already
			currentNumCols++; // Increment count for this group
			finalColumnMap.push({ targetReg: aggResultReg, sourceCursor: -1, sourceColumnIndex: -1, expr: funcExpr });
			// sortOutputRegMap.push(aggResultReg);
		});

		// Update finalNumCols if it wasn't set before (e.g., first group)
		if (finalNumCols === 0) {
			finalNumCols = currentNumCols;
		}

		// Now we have the final row for the group in registers finalResultBaseReg to finalResultBaseReg + finalNumCols - 1

		// --- Compile HAVING clause ---
		const addrHavingFail = compiler.allocateAddress();
		if (stmt.having) {
			// Expressions in HAVING can refer to group keys or aggregate results
			// These values are now available in the finalResultBaseReg block
			const havingReg = compiler.allocateMemoryCells(1);
			// We need to adjust column references in the HAVING expression to point to the
			// correct registers in the finalResultBaseReg block.
			// Pass the finalColumnMap to compileExpression for this purpose.
			const havingContext: import("../compiler/compiler").HavingContext = { finalColumnMap };
			compiler.compileExpression(stmt.having, havingReg, undefined, havingContext);
			compiler.emit(Opcode.IfFalse, havingReg, addrHavingFail, 0, null, 0, "Check HAVING Clause");
		}
		// ---------------------------

		// Store in ephemeral sort table or output directly
		if (needsExternalSort) {
			const insertDataReg = compiler.allocateMemoryCells(finalNumCols + 1);
			compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Agg Sort: NULL Rowid");
			compiler.emit(Opcode.Move, finalResultBaseReg, insertDataReg + 1, finalNumCols, null, 0, "Agg Sort: Copy group result");
			compiler.emit(Opcode.VUpdate, finalNumCols + 1, insertDataReg, 0, { table: ephSortSchema }, 0, "Agg Sort: Insert Group Row");
		} else {
			compiler.emit(Opcode.ResultRow, finalResultBaseReg, finalNumCols, 0, null, 0, "Output Aggregate Group Row");
		}

		compiler.resolveAddress(addrHavingFail); // Jump here if HAVING is false
		compiler.emit(Opcode.Goto, 0, addrAggLoopStart, 0, null, 0, "Loop Aggregate Results");
		compiler.resolveAddress(addrAggLoopEnd);
	}
	// ---------------------------------------

	// Close all FROM cursors if aggregation wasn't performed (otherwise already closed)
	if (!needsAggProcessing) {
		compiler.closeCursorsUsedBySelect(fromCursors);
	}
}

/** Handle SELECT without FROM - simpler case */
function compileSelectNoFrom(compiler: Compiler, stmt: AST.SelectStmt): void {
	// No sorting needed for constant rows
	const { resultBaseReg, numCols } = compiler.compileSelectCore(stmt, []);
	// --- Compile WHERE clause if present (rare for no FROM, but possible) ---
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
	correlation?: SubqueryCorrelationResult // Optional correlation info
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
				const alias = fc.alias || fc.table.name;
				const cursorId = compiler.tableAliases.get(alias.toLowerCase());
				if (cursorId !== undefined) currentLevelCursors.add(cursorId);
			} else if (fc.type === 'join') {
				findCursors(fc.left);
				findCursors(fc.right);
			}
		};
		findCursors(fromClause);
	});

	// Combine outer cursors passed in with cursors from this level
	const combinedOuterCursors = new Set([...outerCursors, ...currentLevelCursors]);

	let estimatedNumCols = 0;
	const hasStar = stmt.columns.some(c => c.type === 'all');
	if (hasStar) {
		estimatedNumCols += outerCursors.reduce((sum, cursorIdx) => {
			const schema = compiler.tableSchemas.get(cursorIdx);
			const colSpec = stmt.columns.find(c => c.type === 'all' && c.table) as AST.ResultColumn & { type: 'all' } | undefined;
			const sourceNode = stmt.from?.find(f => { /* Simplified find */ return true; });
			const sourceAlias = (sourceNode?.type === 'table') ? sourceNode.alias : undefined;
			if (schema && (!colSpec || !colSpec.table || colSpec.table === schema.name || colSpec.table === sourceAlias)) {
				return sum + (schema?.columns.filter(c => !c.hidden).length || 0);
			}
			return sum;
		}, 0);
	}
	estimatedNumCols += stmt.columns.filter(c => c.type === 'column').length;
	if (estimatedNumCols === 0 && hasStar && outerCursors.length === 0) { estimatedNumCols = 0; }
	else if (estimatedNumCols === 0 && stmt.columns.length > 0 && !hasStar) { estimatedNumCols = stmt.columns.length; }
	else if (estimatedNumCols === 0) { estimatedNumCols = 1; }

	const resultBase = compiler.allocateMemoryCells(Math.max(1, estimatedNumCols));
	let actualNumCols = 0;
	const columnMap: ColumnResultInfo[] = [];
	const addrAfterResults = compiler.allocateAddress();

	let currentResultReg = resultBase;
	for (const column of stmt.columns) {
		if (column.type === 'all') {
			// Ensure expansion respects correlation context if needed?
			// For now, assume * expands based on cursors available in *this* scope (outer+current)
			combinedOuterCursors.forEach(cursorIdx => {
				const tableSchema = compiler.tableSchemas.get(cursorIdx);
				const alias = [...compiler.tableAliases.entries()].find(([, cIdx]) => cIdx === cursorIdx)?.[0];
				const starColSpec = stmt.columns.find(c => c.type === 'all' && c.table && (c.table === alias || c.table === tableSchema?.name)) as (AST.ResultColumn & { type: 'all' }) | undefined;

				if (tableSchema && (!starColSpec || starColSpec.table)) {
					tableSchema.columns.forEach((colSchema) => {
						if (!colSchema.hidden) {
							const targetReg = currentResultReg++;
							const colIdx = tableSchema.columnIndexMap.get(colSchema.name.toLowerCase());
							if (colIdx === undefined) {
								compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Expand *: Col ${colSchema.name} Idx Error`);
								columnMap.push({ targetReg, sourceCursor: cursorIdx, sourceColumnIndex: -1 });
							} else {
								compiler.emit(Opcode.VColumn, cursorIdx, colIdx, targetReg, 0, 0, `Expand *: ${alias || tableSchema.name}.${colSchema.name}`);
								const colExpr: AST.ColumnExpr = { type: 'column', name: colSchema.name, table: alias || tableSchema.name };
								columnMap.push({ targetReg, sourceCursor: cursorIdx, sourceColumnIndex: colIdx, expr: colExpr });
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
			// Pass combinedOuterCursors when compiling expressions recursively
			compiler.compileExpression(column.expr, targetReg, correlation);
			// NOTE: compileExpression itself needs updating to pass down the correct outer cursors
			// to analyzeSubqueryCorrelation if it encounters a nested subquery expression.
			// This requires further refinement in compileExpression/compileSubquery.

			let sourceCursor = -1;
			let sourceColumnIndex = -1;
			if (column.expr.type === 'column') {
				const colExpr = column.expr as AST.ColumnExpr;
				if (colExpr.table) {
					sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				} else {
					for (const cIdx of combinedOuterCursors) {
						const schema = compiler.tableSchemas.get(cIdx);
						if (schema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
							if (sourceCursor !== -1) {
								sourceCursor = -1;
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
			let colName = column.alias || (column.expr.type === 'column' ? column.expr.name : `col${actualNumCols + 1}`);
			compiler.columnAliases.push(colName);
			compiler.resultColumns.push({ name: colName, expr: column.expr });
			actualNumCols++;
		}
	}

	compiler.resultColumns = savedResultColumns;
	compiler.columnAliases = savedColumnAliases;
	return { resultBaseReg: resultBase, numCols: actualNumCols, columnMap };
}

function findJoinNodeConnecting(
	sources: AST.FromClause[] | undefined,
	leftLevelIndex: number,
	rightLevelIndex: number,
	compiler: Compiler
): AST.JoinClause | undefined {
	if (!sources || sources.length !== 1 || sources[0].type !== 'join') return undefined;
	const findNode = (node: AST.FromClause, level: number): { node: AST.JoinClause | null, nextLevel: number } => {
		if (node.type === 'table') {
			return { node: null, nextLevel: level + 1 };
		} else if (node.type === 'join') {
			const leftResult = findNode(node.left, level);
			if (leftResult.node) return leftResult;
			const rightResult = findNode(node.right, leftResult.nextLevel);
			if (rightResult.node) return rightResult;

			if (leftResult.nextLevel - 1 === leftLevelIndex && rightResult.nextLevel - 1 === rightLevelIndex) {
				return { node: node, nextLevel: rightResult.nextLevel };
			}
			return { node: null, nextLevel: rightResult.nextLevel };
		} else {
			throw new Error("Invalid node type in FROM clause");
		}
	}
	return findNode(sources[0], 0).node ?? undefined;
}

function getJoinTypeForLevel(
	sources: AST.FromClause[] | undefined,
	level: number
): AST.JoinClause['joinType'] | undefined {
	if (level === 0 || !sources || sources.length !== 1 || sources[0].type !== 'join') return undefined;
	const findType = (node: AST.FromClause, currentLevel: number): { type: AST.JoinClause['joinType'] | null, levelReached: number } => {
		if (node.type === 'table') {
			return { type: null, levelReached: currentLevel + 1 };
		} else if (node.type === 'join') {
			const leftResult = findType(node.left, currentLevel);
			if (leftResult.type) return leftResult;
			if (leftResult.levelReached === level + 1) {
				return { type: node.joinType, levelReached: -1 };
			}
			const rightResult = findType(node.right, leftResult.levelReached);
			return rightResult;
		} else {
			throw new Error("Invalid node type");
		}
	}
	const result = findType(sources[0], 0);
	if (result.type === null && level === 1 && sources[0].type === 'join') {
		return sources[0].joinType;
	}
	return result.type ?? undefined;
}

function compileJoinCondition(
	compiler: Compiler,
	joinNode: AST.JoinClause,
	activeCursors: number[],
	addrJoinFail: number
): void {
	const leftCursor = activeCursors[activeCursors.length - 2];
	const rightCursor = activeCursors[activeCursors.length - 1];

	if (joinNode.condition) {
		const regJoinCondition = compiler.allocateMemoryCells(1);
		compiler.compileExpression(joinNode.condition, regJoinCondition);
		compiler.emit(Opcode.IfFalse, regJoinCondition, addrJoinFail, 0, null, 0, `JOIN: Check ON Condition`);
	} else if (joinNode.columns) {
		const regUsingOk = compiler.allocateMemoryCells(1);
		const regLeftCol = compiler.allocateMemoryCells(1);
		const regRightCol = compiler.allocateMemoryCells(1);
		const leftSchema = compiler.tableSchemas.get(leftCursor)!;
		const rightSchema = compiler.tableSchemas.get(rightCursor)!;
		compiler.emit(Opcode.Integer, 1, regUsingOk, 0, null, 0);

		for (const colName of joinNode.columns) {
			const leftColIdx = leftSchema.columnIndexMap.get(colName.toLowerCase());
			const rightColIdx = rightSchema.columnIndexMap.get(colName.toLowerCase());
			if (leftColIdx === undefined || rightColIdx === undefined) throw new SqliteError(`Column '${colName}' specified in USING clause not found in both tables.`, StatusCode.ERROR);
			compiler.emit(Opcode.VColumn, leftCursor, leftColIdx, regLeftCol, 0, 0, `USING(${colName}) Left`);
			compiler.emit(Opcode.VColumn, rightCursor, rightColIdx, regRightCol, 0, 0, `USING(${colName}) Right`);
			const addrNextUsingCheck = compiler.allocateAddress();
			compiler.emit(Opcode.Eq, regRightCol, addrNextUsingCheck, regLeftCol, null, 0, `USING Compare ${colName}`);
			compiler.emit(Opcode.Integer, 0, regUsingOk, 0, null, 0);
			compiler.emit(Opcode.Goto, 0, compiler.getCurrentAddress() + 2, 0, null, 0);
			compiler.resolveAddress(addrNextUsingCheck);

			compiler.emit(Opcode.IfFalse, regUsingOk, addrJoinFail, 0, null, 0);
		}
	} else {
	}
}

export function compileInsertStatement(compiler: Compiler, stmt: AST.InsertStmt): void {
	const tableSchema = compiler.db._findTable(stmt.table.name, stmt.table.schema);
	if (!tableSchema) { throw new SqliteError(`Table not found: ${stmt.table.schema || 'main'}.${stmt.table.name}`, StatusCode.ERROR); }
	if (!tableSchema.isVirtual || !tableSchema.vtabInstance || !tableSchema.vtabModule?.xUpdate) { throw new SqliteError(`Table ${tableSchema.name} is not a virtual table supporting INSERT`, StatusCode.ERROR); }

	let targetColumns = stmt.columns;
	if (!targetColumns) {
		targetColumns = tableSchema.columns.filter(c => !c.hidden).map(c => c.name);
	} else {
		const schemaCols = new Set(tableSchema.columns.map(c => c.name.toLowerCase()));
		for (const col of targetColumns) {
			if (!schemaCols.has(col.toLowerCase())) {
				throw new SqliteError(`Column '${col}' not found in table '${tableSchema.name}'`, StatusCode.ERROR);
			}
		}
	}
	const numCols = targetColumns.length;
	const targetColumnIndices = targetColumns.map(name => tableSchema.columnIndexMap.get(name.toLowerCase())!);

	const cursor = compiler.allocateCursor();
	const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
	compiler.emit(Opcode.OpenWrite, cursor, numCols, 0, p4Vtab, 0, `OpenWrite ${tableSchema.name}`);

	const regNewRowid = compiler.allocateMemoryCells(1);
	const regDataStart = compiler.allocateMemoryCells(tableSchema.columns.length + 1);

	if (stmt.values) {
		for (const valueRow of stmt.values) {
			if (valueRow.length !== numCols) { throw new SqliteError(`Column count mismatch: table ${tableSchema.name} expected ${numCols} columns, but ${valueRow.length} values were supplied`, StatusCode.ERROR); }

			compiler.emit(Opcode.Null, 0, regDataStart, 0, null, 0, "Rowid=NULL for INSERT");
			for (let i = 0; i < tableSchema.columns.length; i++) {
				compiler.emit(Opcode.Null, 0, regDataStart + 1 + i);
			}
			for (let i = 0; i < numCols; i++) {
				const schemaColIndex = targetColumnIndices[i];
				compiler.compileExpression(valueRow[i], regDataStart + 1 + schemaColIndex);
			}

			const p4Update = { onConflict: stmt.onConflict || ConflictResolution.ABORT, table: tableSchema };
			compiler.emit(Opcode.VUpdate, tableSchema.columns.length + 1, regDataStart, regNewRowid, p4Update, 0, `VUpdate INSERT ${tableSchema.name}`);
		}
	} else if (stmt.select) { throw new SqliteError("INSERT ... SELECT compilation not implemented yet.", StatusCode.ERROR); }
	else { throw new SqliteError("INSERT statement missing VALUES or SELECT clause.", StatusCode.ERROR); }
	compiler.emit(Opcode.Close, cursor, 0, 0, null, 0, `Close ${tableSchema.name}`);
}

export function compileUpdateStatement(compiler: Compiler, stmt: AST.UpdateStmt): void {
	const tableSchema = compiler.db._findTable(stmt.table.name, stmt.table.schema);
	if (!tableSchema) { throw new SqliteError(`Table not found: ${stmt.table.schema || 'main'}.${stmt.table.name}`, StatusCode.ERROR); }
	if (!tableSchema.isVirtual || !tableSchema.vtabInstance || !tableSchema.vtabModule?.xUpdate) { throw new SqliteError(`Table ${tableSchema.name} is not a virtual table supporting UPDATE`, StatusCode.ERROR); }

	const cursor = compiler.allocateCursor();
	const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
	compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `OpenRead for UPDATE ${tableSchema.name}`);
	// --- Pass WHERE clause and undefined ORDER BY ---
	compiler.planTableAccess(cursor, tableSchema, stmt, new Set()); // Pass the full statement
	// ---------------------------------------------
	const planningInfo = compiler.cursorPlanningInfo.get(cursor);

	const regRowid = compiler.allocateMemoryCells(1);
	const addrEOF = compiler.allocateAddress();
	const addrLoopStart = compiler.allocateAddress();
	const addrContinueUpdate = compiler.allocateAddress();

	let regArgsStart = 0;
	let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
	if (planningInfo && planningInfo.idxNum !== 0) {
		const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
		planningInfo.usage.forEach((usage, constraintIdx) => {
			if (usage.argvIndex > 0) {
				const expr = planningInfo.constraintExpressions?.get(constraintIdx);
				if (!expr) throw new SqliteError(`Internal error: Missing expression for constraint ${constraintIdx} used in UPDATE VFilter`, StatusCode.INTERNAL);
				while (argsToCompile.length < usage.argvIndex) { argsToCompile.push(null as any); }
				argsToCompile[usage.argvIndex - 1] = { constraintIdx, expr };
			}
		});
		const finalArgsToCompile = argsToCompile.filter(a => a !== null);
		if (finalArgsToCompile.length > 0) {
			regArgsStart = compiler.allocateMemoryCells(finalArgsToCompile.length);
			finalArgsToCompile.forEach((argInfo, i) => { compiler.compileExpression(argInfo.expr, regArgsStart + i); });
		}
		filterP4 = { idxNum: planningInfo.idxNum, idxStr: planningInfo.idxStr, nArgs: finalArgsToCompile.length };
	}
	compiler.emit(Opcode.VFilter, cursor, addrEOF, regArgsStart, filterP4, 0, `Filter for UPDATE ${tableSchema.name} (Plan: ${planningInfo?.idxNum})`);
	compiler.resolveAddress(addrLoopStart);

	compileUnhandledWhereConditions(compiler, stmt.where, [cursor], addrContinueUpdate);

	const colNameToIndexMap = new Map<string, number>();
	tableSchema.columns.forEach((col, index) => { colNameToIndexMap.set(col.name.toLowerCase(), index); });
	const assignmentRegs = new Map<number, number>();
	const assignedColumnIndices = new Set<number>();
	for (const assignment of stmt.assignments) {
		const colNameLower = assignment.column.toLowerCase();
		const colIndex = colNameToIndexMap.get(colNameLower);
		if (colIndex === undefined) { throw new SqliteError(`Column '${assignment.column}' not found in table '${tableSchema.name}'`, StatusCode.ERROR); }
		if (assignedColumnIndices.has(colIndex)) { throw new SqliteError(`Column '${assignment.column}' specified more than once in SET clause`, StatusCode.ERROR); }
		const valueReg = compiler.allocateMemoryCells(1);
		compiler.compileExpression(assignment.value, valueReg);
		assignmentRegs.set(colIndex, valueReg);
		assignedColumnIndices.add(colIndex);
	}

	compiler.emit(Opcode.VRowid, cursor, regRowid, 0, null, 0, "Get Rowid for UPDATE");
	const numTableCols = tableSchema.columns.length;
	const regUpdateDataStart = compiler.allocateMemoryCells(numTableCols + 1);
	compiler.emit(Opcode.SCopy, regRowid, regUpdateDataStart, 0, null, 0, "Copy Rowid for VUpdate");
	for (let i = 0; i < numTableCols; i++) {
		const destReg = regUpdateDataStart + 1 + i;
		if (assignedColumnIndices.has(i)) {
			const sourceReg = assignmentRegs.get(i)!;
			compiler.emit(Opcode.SCopy, sourceReg, destReg, 0, null, 0, `Copy NEW value for col ${i}`);
		} else {
			compiler.emit(Opcode.VColumn, cursor, i, destReg, 0, 0, `Get OLD value for col ${i}`);
		}
	}

	const p4Update = { onConflict: stmt.onConflict || ConflictResolution.ABORT, table: tableSchema };
	compiler.emit(Opcode.VUpdate, numTableCols + 1, regUpdateDataStart, 0, p4Update, 0, `VUpdate UPDATE ${tableSchema.name}`);

	compiler.resolveAddress(addrContinueUpdate);
	compiler.emit(Opcode.VNext, cursor, addrEOF, 0, null, 0, "Advance to next row for UPDATE");
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "Loop back for next UPDATE");

	compiler.resolveAddress(addrEOF);
	compiler.emit(Opcode.Close, cursor, 0, 0, null, 0, `Close ${tableSchema.name}`);
}

export function compileDeleteStatement(compiler: Compiler, stmt: AST.DeleteStmt): void {
	const tableSchema = compiler.db._findTable(stmt.table.name, stmt.table.schema);
	if (!tableSchema) { throw new SqliteError(`Table not found: ${stmt.table.schema || 'main'}.${stmt.table.name}`, StatusCode.ERROR); }
	if (!tableSchema.isVirtual || !tableSchema.vtabInstance || !tableSchema.vtabModule?.xUpdate) { throw new SqliteError(`Table ${tableSchema.name} is not a virtual table supporting DELETE`, StatusCode.ERROR); }

	const cursor = compiler.allocateCursor();
	const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
	compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `OpenRead for DELETE ${tableSchema.name}`);
	// --- Pass WHERE clause and undefined ORDER BY ---
	compiler.planTableAccess(cursor, tableSchema, stmt, new Set()); // Pass the full statement
	// ---------------------------------------------
	const planningInfo = compiler.cursorPlanningInfo.get(cursor);

	const regRowid = compiler.allocateMemoryCells(1);
	const addrEOF = compiler.allocateAddress();
	const addrLoopStart = compiler.allocateAddress();
	const addrContinueDelete = compiler.allocateAddress();

	let regArgsStart = 0;
	let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
	if (planningInfo && planningInfo.idxNum !== 0) {
		const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
		planningInfo.usage.forEach((usage, constraintIdx) => {
			if (usage.argvIndex > 0) {
				const expr = planningInfo.constraintExpressions?.get(constraintIdx);
				if (!expr) throw new SqliteError(`Internal error: Missing expression for constraint ${constraintIdx} used in DELETE VFilter`, StatusCode.INTERNAL);
				while (argsToCompile.length < usage.argvIndex) { argsToCompile.push(null as any); }
				argsToCompile[usage.argvIndex - 1] = { constraintIdx, expr };
			}
		});
		const finalArgsToCompile = argsToCompile.filter(a => a !== null);
		if (finalArgsToCompile.length > 0) {
			regArgsStart = compiler.allocateMemoryCells(finalArgsToCompile.length);
			finalArgsToCompile.forEach((argInfo, i) => { compiler.compileExpression(argInfo.expr, regArgsStart + i); });
		}
		filterP4 = { idxNum: planningInfo.idxNum, idxStr: planningInfo.idxStr, nArgs: finalArgsToCompile.length };
	}
	compiler.emit(Opcode.VFilter, cursor, addrEOF, regArgsStart, filterP4, 0, `Filter for DELETE ${tableSchema.name} (Plan: ${planningInfo?.idxNum})`);
	compiler.resolveAddress(addrLoopStart);

	compileUnhandledWhereConditions(compiler, stmt.where, [cursor], addrContinueDelete);

	compiler.emit(Opcode.VRowid, cursor, regRowid, 0, null, 0, "Get Rowid for DELETE");
	const p4Update = { onConflict: ConflictResolution.ABORT, table: tableSchema };
	compiler.emit(Opcode.VUpdate, 1, regRowid, 0, p4Update, 0, `VUpdate DELETE ${tableSchema.name}`);

	compiler.resolveAddress(addrContinueDelete);
	compiler.emit(Opcode.VNext, cursor, addrEOF, 0, null, 0, "Advance to next row for DELETE");
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "Loop back for next DELETE");

	compiler.resolveAddress(addrEOF);
	compiler.emit(Opcode.Close, cursor, 0, 0, null, 0, `Close ${tableSchema.name}`);
}

export function compileCreateTableStatement(compiler: Compiler, stmt: AST.CreateTableStmt): void {
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, "CREATE TABLE (no-op in VDBE)");
}

export function compileCreateVirtualTableStatement(compiler: Compiler, stmt: AST.CreateVirtualTableStmt): void {
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, "CREATE VIRTUAL TABLE (no-op in VDBE)");
}

export function compileCreateIndexStatement(compiler: Compiler, stmt: AST.CreateIndexStmt): void {
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, "CREATE INDEX (no-op in VDBE)");
}

export function compileCreateViewStatement(compiler: Compiler, stmt: AST.CreateViewStmt): void {
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, "CREATE VIEW (no-op in VDBE)");
}

export function compileDropStatement(compiler: Compiler, stmt: AST.DropStmt): void {
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, "DROP (no-op in VDBE)");
}

export function compileAlterTableStatement(compiler: Compiler, stmt: AST.AlterTableStmt): void {
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, "ALTER TABLE (no-op in VDBE)");
}

export function compileBeginStatement(compiler: Compiler, stmt: AST.BeginStmt): void {
	compiler.emit(Opcode.VBegin, 0, 0, 0, null, 0, `BEGIN ${stmt.mode || 'DEFERRED'}`);
}

export function compileCommitStatement(compiler: Compiler, stmt: AST.CommitStmt): void {
	compiler.emit(Opcode.VCommit, 0, 0, 0, null, 0, "COMMIT");
}

export function compileRollbackStatement(compiler: Compiler, stmt: AST.RollbackStmt): void {
	if (stmt.savepoint) {
		// ROLLBACK TO savepoint
		const savepointName = compiler.addConstant(stmt.savepoint);
		// P1=0 indicates ROLLBACK TO
		// P2=unused? Or index?
		// P4=name constant index
		compiler.emit(Opcode.Savepoint, 0, 0, 0, savepointName, 0, `ROLLBACK TO ${stmt.savepoint}`);
		compiler.emit(Opcode.VRollbackTo, 0, 0, 0, savepointName, 0, `VRollbackTo ${stmt.savepoint}`); // VTab Hook
	} else {
		// Full ROLLBACK
		compiler.emit(Opcode.VRollback, 0, 0, 0, null, 0, "ROLLBACK");
	}
}

// --- Add Savepoint/Release Compilers ---
export function compileSavepointStatement(compiler: Compiler, stmt: AST.SavepointStmt): void {
	const savepointName = compiler.addConstant(stmt.name);
	// P1=1 indicates SAVEPOINT
	// P4=name constant index
	compiler.emit(Opcode.Savepoint, 1, 0, 0, savepointName, 0, `SAVEPOINT ${stmt.name}`);
	compiler.emit(Opcode.VSavepoint, 0, 0, 0, savepointName, 0, `VSavepoint ${stmt.name}`); // VTab Hook
}

export function compileReleaseStatement(compiler: Compiler, stmt: AST.ReleaseStmt): void {
	if (!stmt.savepoint) {
		throw new SqliteError("RELEASE statement requires a savepoint name.", StatusCode.ERROR);
	}
	const savepointName = compiler.addConstant(stmt.savepoint);
	// P1=2 indicates RELEASE
	// P4=name constant index
	compiler.emit(Opcode.Savepoint, 2, 0, 0, savepointName, 0, `RELEASE ${stmt.savepoint}`);
	compiler.emit(Opcode.VRelease, 0, 0, 0, savepointName, 0, `VRelease ${stmt.savepoint}`); // VTab Hook
}
