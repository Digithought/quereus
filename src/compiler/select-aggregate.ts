import { createLogger } from '../common/logger.js'; // Import logger
import type { Compiler } from './compiler.js';
import type { HavingContext } from './structs.js';
import type * as AST from '../parser/ast.js';
import { Opcode } from '../vdbe/opcodes.js';
import type { P4FuncDef } from '../vdbe/instruction.js';
import { getGroupKeyExpressions } from './select.js'; // Assuming this helper is moved/exported
import type { TableSchema } from '../schema/table.js';
import { expressionToString } from '../util/ddl-stringify.js';

const log = createLogger('compiler:select-aggregate'); // Create logger instance

export function processRowAggregate(
	compiler: Compiler,
	stmt: AST.SelectStmt,
	aggregateColumns: ReadonlyArray<{ type: 'column', expr: AST.FunctionExpr, alias?: string }>,
	regAggKey: number,
	regAggArgs: number,
	regAggSerializedKey: number,
	hasGroupBy: boolean
): number {
	const callbackStartAddr = compiler.getCurrentAddress();
	const baseKeyReg = compiler.allocateMemoryCells(1);
	const compoundKeyReg = compiler.allocateMemoryCells(1);

	// Compile group key expressions (only used if hasGroupBy)
	const groupKeyExprs = getGroupKeyExpressions(stmt);
	const firstGroupKeyReg = regAggKey; // Keep track of the base for MakeRecord
	groupKeyExprs.forEach((expr, i) => {
		// Compile each expression into its designated key register slot
		// Ensure regAggKey itself is allocated safely (>= localsStartOffset)
		// The allocateMemoryCells should handle this, but be mindful.
		const targetReg = firstGroupKeyReg + i;
		compiler.compileExpression(expr, targetReg);
	});

	if (hasGroupBy) {
		// Use the range starting at firstGroupKeyReg as source for MakeRecord
		compiler.emit(Opcode.MakeRecord, firstGroupKeyReg, groupKeyExprs.length, baseKeyReg, null, 0, "Make base group key");
	} else {
		const keyConstantIndex = compiler.addConstant('0');
		compiler.emit(Opcode.String8, 0, baseKeyReg, 0, keyConstantIndex, 0, "Load simple agg base key '0'");
	}

	// Call AggStep for each aggregate function with a compound key
	aggregateColumns.forEach((aggCol, index) => {
		const funcExpr = aggCol.expr;
		const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length);
		if (!funcDef || !funcDef.xStep) {
			throw new Error(`Aggregate function ${funcExpr.name} not found or missing xStep`);
		}

		// --- Create Compound Key: baseKey + "_" + index --- //
		const suffix = `_${index}`;
		const suffixReg = compiler.allocateMemoryCells(1);
		const suffixConstantIndex = compiler.addConstant(suffix);
		compiler.emit(Opcode.String8, 0, suffixReg, 0, suffixConstantIndex, 0, `Load key suffix ${suffix}`)
		compiler.emit(Opcode.Concat, baseKeyReg, suffixReg, compoundKeyReg, null, 0, "Create compound key");
		// ------------------------------------------------- //

		// Compile arguments into their registers
		funcExpr.args.forEach((arg, i) => {
			compiler.compileExpression(arg, regAggArgs + i);
		});

		const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
		// P3 is now compoundKeyReg. P1/P5 are less relevant for simple agg but needed by handler logic.
		compiler.emit(Opcode.AggStep, firstGroupKeyReg, regAggArgs, compoundKeyReg, p4, groupKeyExprs.length, `AggStep for ${funcExpr.name} (idx ${index})`);
	});

	return callbackStartAddr;
}


export function compileAggregateOutput(
	compiler: Compiler,
	stmt: AST.SelectStmt,
	finalColumnMap: ReadonlyArray<any>, // Replace with ColumnResultInfo
	finalResultBaseReg: number,
	finalNumCols: number,
	needsExternalSort: boolean,
	ephSortCursor: number,
	ephSortSchema: TableSchema | undefined,
	regLimit: number,
	regOffset: number,
	hasGroupBy: boolean,
	aggregateColumns: ReadonlyArray<{ type: 'column', expr: AST.FunctionExpr, alias?: string }>,
	finalLoopEndAddr: number // Address to jump to when done/limit reached
): void {

	if (hasGroupBy) {
		// --- GROUP BY Aggregation Output (Looping) ---
		const addrAggLoopStart = compiler.allocateAddress('aggLoopStart');
		const addrAggLoopEnd = compiler.allocateAddress('aggLoopEnd'); // Dedicated end for agg loop
		const regMapIterator = compiler.allocateMemoryCells(1);
		const regGroupKey = compiler.allocateMemoryCells(1);
		const regAggContext = compiler.allocateMemoryCells(1);

		compiler.emit(Opcode.AggIterate, regMapIterator, 0, 0, null, 0, "Start Aggregate Result Iteration");
		compiler.resolveAddress(addrAggLoopStart);
		compiler.emit(Opcode.AggNext, regMapIterator, addrAggLoopEnd, 0, null, 0, "Next Aggregate Group");

		compiler.emit(Opcode.AggKey, regMapIterator, regGroupKey, 0, null, 0, "Get Group Key");
		compiler.emit(Opcode.AggContext, regMapIterator, regAggContext, 0, null, 0, "Get Aggregate Context");

		// Keep track of which group key index we are currently processing
		let groupKeyOutputIndex = 0;
		// Get the original GROUP BY expressions for comparison
		const groupByKeyExprStrings = new Set(getGroupKeyExpressions(stmt).map(expressionToString));

		finalColumnMap.forEach(info => {
			const exprString = info.expr ? expressionToString(info.expr) : null;
			// Check if the current output column corresponds to a GROUP BY key
			const isGroupKeyColumn = exprString && groupByKeyExprStrings.has(exprString);

			if (isGroupKeyColumn) {
				// Emit instruction to output the corresponding group key component
				compiler.emit(Opcode.AggGroupValue, regMapIterator, groupKeyOutputIndex, info.targetReg, null, 0, `Output Group Key ${groupKeyOutputIndex}`);
				groupKeyOutputIndex++; // Increment only when outputting a group key
			} else if (info.expr?.type === 'function' /* && isAggregate - check needed? */ ) {
				// Assume remaining columns are aggregate results (needs refinement?)
				const funcExpr = info.expr as AST.FunctionExpr;
				const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length);
				if (!funcDef || !funcDef.xFinal) {
					// Should have been caught earlier, but defensive check
					console.warn(`Cannot find aggregate function or xFinal for ${funcExpr.name} during output`);
					compiler.emit(Opcode.Null, 0, info.targetReg, 0, null, 0, `NULL for missing AggFinal ${funcExpr.name}`);
				} else {
					const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
					// Emit AggFinal using the retrieved aggregate context
					compiler.emit(Opcode.AggFinal, regAggContext, 0, info.targetReg, p4, 0, `AggFinal for ${funcExpr.name}`);
				}
			} else {
				// Should not happen if finalColumnMap is built correctly
				console.warn(`Unexpected column type in compileAggregateOutput loop: ${info.expr?.type}`);
				compiler.emit(Opcode.Null, 0, info.targetReg, 0, null, 0, `NULL for unexpected column`);
			}
		});

		// Compile HAVING clause
		const addrHavingFail = compiler.allocateAddress('havingFail');
		if (stmt.having) {
			const havingReg = compiler.allocateMemoryCells(1);
			const havingContext: HavingContext = { finalColumnMap };
			compiler.compileExpression(stmt.having, havingReg, undefined, havingContext);
			compiler.emit(Opcode.IfFalse, havingReg, addrHavingFail, 0, null, 0, "Check HAVING Clause");
		}

		// Store in sorter or output directly
		if (needsExternalSort) {
			const insertDataReg = compiler.allocateMemoryCells(finalNumCols + 1);
			compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Agg Sort: NULL Rowid");
			compiler.emit(Opcode.Move, finalResultBaseReg, insertDataReg + 1, finalNumCols, null, 0, "Agg Sort: Copy group result");
			compiler.emit(Opcode.VUpdate, finalNumCols + 1, insertDataReg, ephSortCursor, { table: ephSortSchema }, 0, "Agg Sort: Insert Group Row");
		} else {
			// Apply Limit/Offset
			const addrSkipAggRow = compiler.allocateAddress('skipAggRow');
			if (regLimit > 0) {
				const addrPostAggOffset = compiler.allocateAddress('postAggOffset');
				compiler.emit(Opcode.IfZero, regOffset, addrPostAggOffset, 0, null, 0, "Agg Check Offset == 0");
				compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Agg Decrement Offset");
				compiler.emit(Opcode.Goto, 0, addrSkipAggRow, 0, null, 0, "Agg Skip Row (Offset)");
				compiler.resolveAddress(addrPostAggOffset);
			}
			compiler.emit(Opcode.ResultRow, finalResultBaseReg, finalNumCols, 0, null, 0, "Output Aggregate Group Row");
			if (regLimit > 0) {
				const addrAggLimitNotZero = compiler.allocateAddress('aggLimitNotZero');
				compiler.emit(Opcode.IfZero, regLimit, addrAggLimitNotZero, 0, null, 0, "Agg Skip Limit Check if 0");
				compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Agg Decrement Limit");
				compiler.emit(Opcode.IfZero, regLimit, addrAggLoopEnd, 0, null, 0, "Agg Check Limit Reached"); // Jump to end of this agg loop
				compiler.resolveAddress(addrAggLimitNotZero);
			}
			compiler.resolveAddress(addrSkipAggRow);
		}

		compiler.resolveAddress(addrHavingFail);
		compiler.emit(Opcode.Goto, 0, addrAggLoopStart, 0, null, 0, "Loop Aggregate Results");
		compiler.resolveAddress(addrAggLoopEnd); // End of GROUP BY output loop

	} else {
		// --- Simple Aggregate Output ---
		const baseKeyReg = compiler.allocateMemoryCells(1);
		const compoundKeyReg = compiler.allocateMemoryCells(1);
		const regTempAccumulator = compiler.allocateMemoryCells(1);

		// --- Load Base Key '0' --- //
		const keyConstantIndex = compiler.addConstant('0');
		compiler.emit(Opcode.String8, 0, baseKeyReg, 0, keyConstantIndex, 0, "Load simple agg base key '0'");

		// --- Iterate original aggregateColumns, get context, finalize --- //
		if (finalNumCols !== aggregateColumns.length) {
			log.extend('warn')(`Mismatch between finalNumCols (${finalNumCols}) and aggregateColumns count (${aggregateColumns.length}) in simple aggregate.`);
		}
		if (finalResultBaseReg === 0 && finalNumCols > 0) {
			 finalResultBaseReg = compiler.allocateMemoryCells(finalNumCols);
		}

		aggregateColumns.forEach((aggCol, index) => {
			if (index >= finalNumCols) return; // Avoid writing past allocated space

			// --- Create Compound Key --- //
			const suffix = `_${index}`;
			const suffixReg = compiler.allocateMemoryCells(1);
			const suffixConstantIndex = compiler.addConstant(suffix);
			compiler.emit(Opcode.String8, 0, suffixReg, 0, suffixConstantIndex, 0, `Load key suffix ${suffix}`)
			compiler.emit(Opcode.Concat, baseKeyReg, suffixReg, compoundKeyReg, null, 0, "Create compound key");
			// ------------------------ //

			// --- Get Accumulator using Compound Key --- //
			compiler.emit(Opcode.AggGetAccumulatorByKey, compoundKeyReg, regTempAccumulator, 0, null, 0, `Get accumulator for key in reg ${compoundKeyReg}`)
			// ------------------------------------------ //

			const funcExpr = aggCol.expr;
			const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length)!;
			const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
			const targetReg = finalResultBaseReg + index;

			// AggFinal: P1=regTempAccumulator, P3=targetReg
			compiler.emit(Opcode.AggFinal, regTempAccumulator, 0, targetReg, p4, 0, `AggFinal for ${funcExpr.name}`);
		});

		// Compile HAVING clause
		const addrHavingFailSimple = compiler.allocateAddress('havingFailSimple');
		const addrPastHavingSimple = compiler.allocateAddress('pastHavingSimple');
		if (stmt.having) {
			const havingReg = compiler.allocateMemoryCells(1);
			const havingContext: HavingContext = { finalColumnMap };
			compiler.compileExpression(stmt.having, havingReg, undefined, havingContext);
			compiler.emit(Opcode.IfFalse, havingReg, addrHavingFailSimple, 0, null, 0, "Check HAVING Clause (Simple Agg)");
		}

		// Store or output result
		if (needsExternalSort) {
			const insertDataReg = compiler.allocateMemoryCells(finalNumCols + 1);
			compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Simple Agg Sort: NULL Rowid");
			compiler.emit(Opcode.Move, finalResultBaseReg, insertDataReg + 1, finalNumCols, null, 0, "Simple Agg Sort: Copy result");
			compiler.emit(Opcode.VUpdate, finalNumCols + 1, insertDataReg, ephSortCursor, { table: ephSortSchema }, 0, "Simple Agg Sort: Insert Row");
		} else {
			const addrSkipOutputSimple = compiler.allocateAddress('skipOutputSimple');
			if (regLimit > 0) {
				compiler.emit(Opcode.IfZero, regOffset, addrSkipOutputSimple, 1, null, 0, "Simple Agg Check Offset != 0");
			}
			compiler.emit(Opcode.ResultRow, finalResultBaseReg, finalNumCols, 0, null, 0, "Output Simple Aggregate Row");
			compiler.resolveAddress(addrSkipOutputSimple);
		}

		compiler.emit(Opcode.Goto, 0, addrPastHavingSimple, 0, null, 0, "Skip HAVING fail target");
		compiler.resolveAddress(addrHavingFailSimple);
		compiler.resolveAddress(addrPastHavingSimple);
	}
}
