import type { Compiler, HavingContext } from './compiler.js';
import type * as AST from '../parser/ast.js';
import { Opcode } from '../vdbe/opcodes.js';
import type { P4FuncDef } from '../vdbe/instruction.js';
import { getGroupKeyExpressions } from './select.js'; // Assuming this helper is moved/exported
import type { TableSchema } from '../schema/table.js';

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

	// Compile group key expressions for this row (needed for MakeRecord)
	getGroupKeyExpressions(stmt).forEach((expr, i) => {
		compiler.compileExpression(expr, regAggKey + i);
	});

	if (hasGroupBy) {
		// Make the key record from the group key expression results
		compiler.emit(Opcode.MakeRecord, regAggKey, getGroupKeyExpressions(stmt).length, regAggSerializedKey, null, 0, "Make group key for AggStep");
	}
	// Note: For simple agg, regAggSerializedKey already contains '0' from before the loop

	// Call AggStep for each aggregate function
	aggregateColumns.forEach(aggCol => {
		const funcExpr = aggCol.expr;
		const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length);
		if (!funcDef || !funcDef.xStep) {
			throw new Error(`Aggregate function ${funcExpr.name} not found or missing xStep`);
		}
		// Compile arguments into their registers
		funcExpr.args.forEach((arg, i) => {
			compiler.compileExpression(arg, regAggArgs + i);
		});

		const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
		// P1 = Group Key Regs, P2 = Arg Regs, P3 = Serialized Key Reg, P5 = Num Group Keys
		compiler.emit(Opcode.AggStep, regAggKey, regAggArgs, regAggSerializedKey, p4, getGroupKeyExpressions(stmt).length, `AggStep for ${funcExpr.name}`);
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

		let groupKeyIndex = 0;
		finalColumnMap.forEach(info => {
			if (info.expr?.type === 'function' && info.expr.isAggregate) {
				const funcExpr = info.expr as AST.FunctionExpr;
				const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length)!;
				const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
				compiler.emit(Opcode.AggFinal, regAggContext, 0, info.targetReg, p4, 0, `AggFinal for ${funcExpr.name}`);
			} else {
				compiler.emit(Opcode.AggGroupValue, regMapIterator, groupKeyIndex, info.targetReg, null, 0, `Output Group Key ${groupKeyIndex}`);
				groupKeyIndex++;
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
		const regSimpleAggKey = compiler.allocateMemoryCells(1);
		const regAggContext = compiler.allocateMemoryCells(1);
		compiler.emit(Opcode.String8, 0, regSimpleAggKey, 0, '0', 0, "Get simple aggregate key '0'");
		compiler.emit(Opcode.AggGetContext, regSimpleAggKey, regAggContext, 0, null, 0, "Get simple aggregate context");

		finalColumnMap.forEach(info => {
			if (info.expr?.type === 'function' && info.expr.isAggregate) {
				const funcExpr = info.expr as AST.FunctionExpr;
				const funcDef = compiler.db._findFunction(funcExpr.name, funcExpr.args.length)!;
				const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: funcExpr.args.length };
				compiler.emit(Opcode.AggFinal, regAggContext, 0, info.targetReg, p4, 0, `AggFinal for ${funcExpr.name}`);
			} // (Handle other cases as before)
			else if (info.expr) { compiler.compileExpression(info.expr, info.targetReg); }
			else if (!(finalNumCols === 1 && finalColumnMap.length === 0)) {
				compiler.emit(Opcode.Null, 0, info.targetReg, 0, null, 0, "NULL for unexpected simple agg col");
			}
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
			// If limit > 0, we should jump to end here if the single row is output.
			// Limit check is effectively handled by only outputting one row.
		}

		compiler.emit(Opcode.Goto, 0, addrPastHavingSimple, 0, null, 0, "Skip HAVING fail target");
		compiler.resolveAddress(addrHavingFailSimple);
		compiler.resolveAddress(addrPastHavingSimple);
	}
}
