// src/compiler/select.ts
import { Opcode } from '../common/constants';
import { StatusCode } from '../common/types';
import { SqliteError } from '../common/errors';
import { type P4Vtab, type P4FuncDef, type P4SortKey } from '../vdbe/instruction';
import type { Compiler, ColumnResultInfo, HavingContext } from './compiler'; // Ensure HavingContext is imported
import type * as AST from '../parser/ast';
import { compileUnhandledWhereConditions, type SubqueryCorrelationResult } from './helpers';
import type { ArgumentMap } from './expression';
import { analyzeSubqueryCorrelation } from './helpers'; // Added import

// --- SELECT Statement Compilation --- //

// Helper function to check if a result column is an aggregate function call
function isAggregateResultColumn(col: AST.ResultColumn): boolean {
	return col.type === 'column' && col.expr?.type === 'function' && col.expr.isAggregate === true;
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

	const hasGroupBy = !!stmt.groupBy && stmt.groupBy.length > 0;
	const aggregateColumns = stmt.columns.filter(isAggregateResultColumn) as ({ type: 'column', expr: AST.FunctionExpr, alias?: string })[];
	const hasAggregates = aggregateColumns.length > 0;
	const isSimpleAggregate = hasAggregates && !hasGroupBy; // e.g., SELECT COUNT(*) FROM t
	const needsAggProcessing = hasAggregates || hasGroupBy;

	// Determine the structure of the rows before potential sorting
	let preSortNumCols = 0;
	let preSortColumnMap: ColumnResultInfo[] = [];
	let preSortResultBaseReg = 0;

	// Store original result/alias state
	const savedResultColumns = compiler.resultColumns;
	const savedColumnAliases = compiler.columnAliases;
	compiler.resultColumns = [];
	compiler.columnAliases = [];

	// Open cursors first based on the FROM structure
	const fromCursors = compiler.compileFromCore(stmt.from);

	// Plan table access early to determine if ORDER BY is consumed
	const allCursors = [...fromCursors];
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

	if (needsAggProcessing) {
		// Aggregation determines the final structure
		// We will determine finalNumCols, finalColumnMap during the aggregation output loop.
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
	let ephSortSchema: import("../schema/table").TableSchema | undefined;
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
	const loopStarts: number[] = [];
	const loopEnds: number[] = [];
	const joinFailTargets: number[] = [];
	const matchFoundRegs: number[] = [];
	const activeOuterCursors = new Set<number>();
	let innermostVNextAddr = 0; // Will hold address of innermost loop's VNext
	let innermostProcessStartAddr = 0; // Start of WHERE/Aggregation/Output logic

	fromCursors.forEach((cursor, index) => {
		const schema = compiler.tableSchemas.get(cursor);
		if (!schema) throw new SqliteError(`Internal error: Schema not found for cursor ${cursor}`, StatusCode.INTERNAL);

		const loopStartAddr = compiler.allocateAddress();
		const eofTarget = compiler.allocateAddress();
		const joinFailTarget = compiler.allocateAddress(); // Target if join or WHERE fails at this level

		loopStarts.push(loopStartAddr);
		loopEnds.push(eofTarget);
		joinFailTargets.push(joinFailTarget);

		const joinType = getJoinTypeForLevel(stmt.from, index);
		const matchReg = (joinType === 'left') ? compiler.allocateMemoryCells(1) : 0;
		matchFoundRegs.push(matchReg);
		if (matchReg > 0) {
			compiler.emit(Opcode.Integer, 0, matchReg, 0, null, 0, `Init LEFT JOIN Match Flag [${index}] = 0`);
		}

		// Use planning info already computed
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
				finalArgsToCompile.forEach((argInfo, i) => {
					// Pass active outer cursors for correlation analysis in constraint expressions
					const correlation = analyzeSubqueryCorrelation(compiler, argInfo.expr, activeOuterCursors);
					compiler.compileExpression(argInfo.expr, regArgsStart + i, correlation);
				});
			}
			filterP4 = { idxNum: planningInfo.idxNum, idxStr: planningInfo.idxStr, nArgs: finalArgsToCompile.length };
		}
		compiler.emit(Opcode.VFilter, cursor, eofTarget, regArgsStart, filterP4, 0, `Filter/Scan Cursor ${index}`);
		compiler.resolveAddress(loopStartAddr);
		compiler.verifyWhereConstraints(cursor, joinFailTarget); // Verify constraints not omitted by plan

		// Compile explicit JOIN condition (ON/USING) if applicable
		if (index > 0) {
			const joinNode = findJoinNodeConnecting(stmt.from, index - 1, index, compiler);
			if (joinNode && joinType !== 'cross') {
				compileJoinCondition(compiler, joinNode, fromCursors.slice(0, index + 1), joinFailTarget);
			} else if (joinType === 'inner' && !joinNode) {
				// Implicit CROSS JOIN requires no ON/USING but acts like INNER
				// throw new SqliteError(`Missing ON/USING clause for table at join level ${index}`, StatusCode.ERROR);
			}
		}

		// If this row satisfies join conditions, set match flag for the *outer* row (if LEFT JOIN)
		if (index > 0) {
			const outerLevelIndex = index - 1;
			const outerMatchReg = matchFoundRegs[outerLevelIndex];
			if (outerMatchReg > 0) {
				compiler.emit(Opcode.Integer, 1, outerMatchReg, 0, null, 0, `Set LEFT JOIN Match Flag [${outerLevelIndex}] = 1`);
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
			const insertDataReg = compiler.allocateMemoryCells(finalNumCols + 1); // +1 for rowid
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
				compiler.emit(Opcode.IfZero, regLimit, loopEnds[0], 0, null, 0, "Check Limit Reached");
				compiler.resolveAddress(addrLimitNotZero);
			}
			// ------------------------------------ //
		}

		compiler.resolveAddress(addrSkipRow); // Target for offset skip or end of non-agg path
	}

	// Jump to the VNext of the innermost loop
	innermostVNextAddr = compiler.getCurrentAddress() + 2; // Address of the GOTO after VNext
	compiler.emit(Opcode.Goto, 0, innermostVNextAddr, 0, null, 0, "Goto Innermost VNext");

	// Resolve the target for WHERE failure - jump to VNext
	compiler.resolveAddress(innermostWhereFailTarget);
	compiler.emit(Opcode.Goto, 0, innermostVNextAddr, 0, null, 0, "WHERE Failed, Goto VNext");
	// --- End Innermost Processing --- //

	// --- Generate Loop Closing/VNext and LEFT JOIN NULL Padding --- //
	for (let i = fromCursors.length - 1; i >= 0; i--) {
		const cursor = fromCursors[i];
		const loopStartAddr = loopStarts[i];
		const eofAddr = loopEnds[i];
		const joinFailAddr = joinFailTargets[i];
		const matchReg = matchFoundRegs[i];

		// Resolve the target for join/where failure at this level
		compiler.resolveAddress(joinFailAddr);

		// Resolve the target for the GOTO after innermost processing (points to VNext)
		const currentVNextTargetAddr = compiler.getCurrentAddress(); // Address of this VNext
		if (i === fromCursors.length - 1) {
			compiler.resolveAddress(innermostVNextAddr - 2); // Resolve the GOTO target pointing here
			compiler.resolveAddress(innermostVNextAddr - 1); // Resolve the WHERE failed GOTO target
			innermostVNextAddr = currentVNextTargetAddr; // Update for outer loops
		}

		compiler.emit(Opcode.VNext, cursor, eofAddr, 0, null, 0, `VNext Cursor ${i}`);
		compiler.emit(Opcode.Goto, 0, loopStartAddr, 0, null, 0, `Goto LoopStart ${i}`);
		compiler.resolveAddress(eofAddr);

		// LEFT JOIN EOF NULL Padding
		const joinType = getJoinTypeForLevel(stmt.from, i);
		if (joinType === 'left' && matchReg > 0) {
			const addrSkipNullPadEof = compiler.allocateAddress();
			compiler.emit(Opcode.IfTrue, matchReg, addrSkipNullPadEof, 0, null, 0, `LEFT JOIN EOF: Skip NULL pad if match found [${i}]`);

			// Null pad columns originating from this cursor
			// Use the *core* column map to know which original columns to null pad
			coreColumnMap.forEach(info => {
				if (info.sourceCursor === cursor) {
					compiler.emit(Opcode.Null, 0, info.targetReg, 0, null, 0, `LEFT JOIN EOF: NULL Pad Col ${info.sourceColumnIndex} from Cursor ${cursor}`);
				}
			});

			// If this NULL padding potentially satisfies an outer LEFT JOIN, set its flag
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

		// Reset match flag for the level *inside* the loop we are closing
		if (matchReg > 0) {
			compiler.emit(Opcode.Integer, 0, matchReg, 0, null, 0, `Reset LEFT JOIN Match Flag [${i}] before outer VNext/EOF`);
		}
		activeOuterCursors.delete(cursor);
	} // --- End loop closing --- //

	// --- Final Aggregation Result Output --- //
	if (needsAggProcessing) {
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
		let aggIndex = 0;
		finalColumnMap.forEach(info => {
			if (info.expr?.type === 'function' && info.expr.isAggregate) {
				// It's an aggregate result
				const funcExpr = info.expr as AST.FunctionExpr;
				const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length)!;
				const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
				compiler.emit(Opcode.AggFinal, regAggContext, 0, info.targetReg, p4, 0, `AggFinal for ${funcExpr.name}`);
				aggIndex++;
			} else if (hasGroupBy) {
				// It's a group key result
				compiler.emit(Opcode.AggGroupValue, regMapIterator, groupKeyIndex, info.targetReg, null, 0, `Output Group Key ${groupKeyIndex}`);
				groupKeyIndex++;
			} else {
				// Should be simple aggregate with no group keys - result should be aggregate
				throw new Error("Internal: Unexpected column type in aggregate output loop");
			}
		});

		// Now we have the final row for the group in registers finalResultBaseReg to finalResultBaseReg + finalNumCols - 1

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
	} // --- End Final Aggregation Result Output --- //

	// --- Output from Sorter --- //
	if (needsExternalSort) {
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

	// Close FROM cursors if no sorter was used
	if (!needsExternalSort) {
		compiler.closeCursorsUsedBySelect(fromCursors);
	}

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
	joinNode: AST.JoinClause,
	activeCursors: number[], // Cursors active up to and including the right side of this join
	addrJoinFail: number
): void {
	if (activeCursors.length < 2) {
		throw new Error("Internal: compileJoinCondition called with insufficient active cursors.");
	}
	const leftCursor = activeCursors[activeCursors.length - 2]; // Cursor for the left side's result
	const rightCursor = activeCursors[activeCursors.length - 1]; // Cursor for the right side

	if (joinNode.condition) {
		// Compile the ON expression
		const regJoinCondition = compiler.allocateMemoryCells(1);
		// Correlation/ArgumentMap might be needed if the condition involves outer refs
		compiler.compileExpression(joinNode.condition, regJoinCondition);
		compiler.emit(Opcode.IfFalse, regJoinCondition, addrJoinFail, 0, null, 0, `JOIN: Check ON Condition`);
	} else if (joinNode.columns) {
		// Compile the USING condition
		const regUsingOk = compiler.allocateMemoryCells(1); // Use a single register for overall result
		const regLeftCol = compiler.allocateMemoryCells(1);
		const regRightCol = compiler.allocateMemoryCells(1);
		const leftSchema = compiler.tableSchemas.get(leftCursor);
		const rightSchema = compiler.tableSchemas.get(rightCursor);
		if (!leftSchema || !rightSchema) throw new Error("Internal: Schema not found for USING clause cursors.");

		for (const colName of joinNode.columns) {
			const leftColIdx = leftSchema.columnIndexMap.get(colName.toLowerCase());
			const rightColIdx = rightSchema.columnIndexMap.get(colName.toLowerCase());
			if (leftColIdx === undefined || rightColIdx === undefined) throw new SqliteError(`Column '${colName}' specified in USING clause not found in both tables.`, StatusCode.ERROR);

			compiler.emit(Opcode.VColumn, leftCursor, leftColIdx, regLeftCol, 0, 0, `USING(${colName}) Left`);
			compiler.emit(Opcode.VColumn, rightCursor, rightColIdx, regRightCol, 0, 0, `USING(${colName}) Right`);

			// Compare columns: result is NULL if either is NULL, true if equal, false otherwise
			// Use the full comparison logic from compileBinary for IS / IS NOT / = etc.
			const addrColsEqual = compiler.allocateAddress();
			const addrCompareEnd = compiler.allocateAddress();
			const regCompareResult = compiler.allocateMemoryCells(1);

			// Handle NULLs: If either is NULL, comparison fails (result 0 for JOIN)
			compiler.emit(Opcode.IfNull, regLeftCol, addrCompareEnd, 0, null, 0, `USING: Skip if left NULL`);
			compiler.emit(Opcode.IfNull, regRightCol, addrCompareEnd, 0, null, 0, `USING: Skip if right NULL`);

			// Compare non-null values
			compiler.emit(Opcode.Eq, regLeftCol, addrColsEqual, regRightCol, null, 0, `USING Compare ${colName}`);

			// Not Equal
			compiler.emit(Opcode.Integer, 0, regCompareResult, 0, null, 0); // Set result to false
			compiler.emit(Opcode.Goto, 0, addrCompareEnd, 0, null, 0);

			// Equal
			compiler.resolveAddress(addrColsEqual);
			compiler.emit(Opcode.Integer, 1, regCompareResult, 0, null, 0); // Set result to true

			compiler.resolveAddress(addrCompareEnd);

			// If the comparison result is false (0), jump to failure
			compiler.emit(Opcode.IfFalse, regCompareResult, addrJoinFail, 0, null, 0, `USING: Jump if ${colName} not equal`);
		}
	} else {
		// Natural join or cross join - no condition to compile here
	}
}
