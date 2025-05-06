import type { Compiler } from './compiler.js';
import type { WindowSorterInfo } from './window.js';
import { compileWindowFunctionsPass } from './window_pass.js';
import type * as AST from '../parser/ast.js';
import { Opcode } from '../vdbe/opcodes.js';
import { expressionToString } from '../util/ddl-stringify.js';
import type { ColumnResultInfo } from './structs.js';
import { createLogger } from '../common/logger.js';
import type { RowProcessingContext } from './select-loop.js';

const log = createLogger('compiler:select-window');

export function processRowWindow(
	compiler: Compiler,
	stmt: AST.SelectStmt,
	currentRowColumnMap: ReadonlyArray<ColumnResultInfo>,
	windowSorterInfo: WindowSorterInfo,
	context: RowProcessingContext
): number {
	const callbackStartAddr = compiler.getCurrentAddress();

	if (context.isLeftJoinPadding) {
		log("Processing LEFT JOIN NULL padding in window function mode");
		// Note: The logic below for emitting Move or Null already considers the padding context implicitly
		// when sourceExpr is compiled or when coreColInfo.targetReg is used.
		// Explicitly, if a column contributing to a PARTITION BY or ORDER BY key comes from the
		// padded side of a LEFT JOIN, its value should be NULL. This is handled when coreColInfo.targetReg
		// (which should reflect the current row's state, including NULLs from padding) is moved to the sorter.
	}

	const sorterDataReg = windowSorterInfo.dataBaseReg;
	windowSorterInfo.schema.columns.forEach((col, i) => {
		const sourceExpr = windowSorterInfo.indexToExpression.get(i);

		if (sourceExpr) {
			// Data column needed for partition/order/args
			// Find the corresponding column in the current row's data (currentRowColumnMap)
			// This map should contain results of expressions from the SELECT core, already considering padding.
			const coreColInfo = currentRowColumnMap.find(info =>
				info.expr && expressionToString(info.expr) === expressionToString(sourceExpr));

			if (coreColInfo) {
				// If we are in a LEFT JOIN padding context AND the original source of this data
				// (before it became part of currentRowColumnMap) was from the inner, now-NULLed table,
				// then coreColInfo.targetReg should already hold NULL if expressions were compiled correctly
				// against the padded row state.
				// The check context.isLeftJoinPadding.innerContributingCursors.has(coreColInfo.sourceCursor)
				// directly on coreColInfo (which represents an *expression result* or a *direct column from current row*)
				// might be misleading if coreColInfo.sourceCursor refers to an intermediate cursor rather than the true origin.
				// However, if coreColInfo.targetReg correctly reflects the (potentially NULLed) value due to padding,
				// just moving it is correct.

				// Let's assume coreColInfo.targetReg correctly has the value (or NULL if padded)
				// from the current row context.
				compiler.emit(Opcode.Move, coreColInfo.targetReg, sorterDataReg + i, 1, null, 0,
					`Move ${i}: ${expressionToString(sourceExpr).substring(0, 20)}`);
			} else {
				// If the source expression for the sorter column wasn't found in the current row map,
				// this is an issue, or it implies the expression should have been evaluated differently.
				// For safety, emit NULL.
				compiler.emit(Opcode.Null, 0, sorterDataReg + i, 1, null, 0,
					`NULL for sorter col ${i} (expr ${expressionToString(sourceExpr).substring(0,15)} not found in current row)`);
			}
		} else {
			// Placeholder for window function result itself in the sorter schema
			compiler.emit(Opcode.Null, 0, sorterDataReg + i, 1, null, 0,
				`NULL placeholder for window result col ${i}`);
		}
	});

	const recordReg = compiler.allocateMemoryCells(1);
	// const rowidReg = compiler.allocateMemoryCells(1); // Not used directly for VUpdate here
	// compiler.emit(Opcode.Null, 0, rowidReg, 0, null, 0, "Window Sort: NULL Rowid"); // Rowid not part of MakeRecord for this sorter type
	compiler.emit(Opcode.MakeRecord, sorterDataReg, windowSorterInfo.schema.columns.length, recordReg, windowSorterInfo.sortKeyP4 /* Pass sort key for MakeRecord if applicable */, 0, "Make Window Sort Record");

	// For VUpdate into an ephemeral table (like the sorter), P1 is number of columns in record + 1 (for rowid), P2 is start reg of (rowid, col0, col1...).
	// If sorter is without rowid, P1 is num sorter cols, P2 is start of data.
	// Assuming sorter is an ephemeral table that might be WITHOUT ROWID or handle rowids internally.
	// The current MemoryTable VUpdate typically expects (rowid, col0, ...).
	// Let's prepare data including a NULL rowid if the sorter schema expects it.
	const numSorterDataCols = windowSorterInfo.schema.columns.length;
	const insertDataReg = compiler.allocateMemoryCells(numSorterDataCols + 1); // +1 for potential rowid
	compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Window Sort: Prep Rowid (NULL)");
	compiler.emit(Opcode.Move, sorterDataReg, insertDataReg + 1, numSorterDataCols, null, 0, "Window Sort: Copy data for insert");
	compiler.emit(Opcode.VUpdate, numSorterDataCols + 1, insertDataReg, windowSorterInfo.cursor, { table: windowSorterInfo.schema }, 0, "Insert Row into Window Sorter");

	return callbackStartAddr;
}


export function compileWindowOutput(
	compiler: Compiler,
	windowSorterInfo: WindowSorterInfo,
	finalColumnMap: ReadonlyArray<ColumnResultInfo>,
	sharedFrameDefinition: AST.WindowFrame | undefined,
	regLimit: number,
	regOffset: number,
	finalLoopEndAddr: number
): void {
	compiler.emit(Opcode.Sort, windowSorterInfo.cursor, finalLoopEndAddr /* Jump here if sort is empty */, 0, null, 0, "Sort Window Function Data");

	const outputBaseReg = compiler.allocateMemoryCells(finalColumnMap.length);

	compileWindowFunctionsPass(compiler, windowSorterInfo, outputBaseReg, finalColumnMap.length, sharedFrameDefinition);

	const addrWinLoopStart = compiler.allocateAddress('winLoopStart');

	compiler.emit(Opcode.Rewind, windowSorterInfo.cursor, finalLoopEndAddr, 0, null, 0, "Rewind Window Sorter for Output");
	compiler.resolveAddress(addrWinLoopStart);

	finalColumnMap.forEach((colInfo, i) => {
		if (colInfo.expr?.type === 'windowFunction') {
			const placeholderInfo = windowSorterInfo.windowResultPlaceholders.get(colInfo.expr);
			if (!placeholderInfo) throw new Error(`Internal error: Window placeholder not found for output column ${i} ('${expressionToString(colInfo.expr)}')`);
			compiler.emit(Opcode.Move, placeholderInfo.resultReg, outputBaseReg + i, 1, null, 0, `Move window result to output ${i}`);
		} else {
			// This is a non-window function column. It should be a pass-through value that was stored in the sorter.
			const sorterColIdx = colInfo.sourceColumnIndex; // This MUST be the index in the sorter table schema.

			if (sorterColIdx === -1) {
				// This implies the column was not directly stored in the sorter payload, which is unexpected for pass-through columns.
				// It might have been calculated by compileWindowFunctionsPass (though that's usually for window func results)
				// or there is a mapping issue.
				log.extend('warn')(`Final column ${i} ('${colInfo.expr ? expressionToString(colInfo.expr) : 'unknown'}') in window output is not a window function and has an invalid sorter index (-1). Emitting NULL.`);
				compiler.emit(Opcode.Null, 0, outputBaseReg + i, 0, null, 0, `NULL for non-window col ${i} in window output (invalid sorterIndex)`);
			} else {
				// Read the pass-through column directly from the sorter.
				compiler.emit(Opcode.VColumn, windowSorterInfo.cursor, sorterColIdx, outputBaseReg + i, null, 0, `Read sorter payload col ${sorterColIdx} to output ${i}`);
			}
		}
	});

	const addrSkipWinRow = compiler.allocateAddress('skipWinRow');
	if (regLimit > 0) {
		const addrPostWinOffset = compiler.allocateAddress('postWinOffset');
		compiler.emit(Opcode.IfZero, regOffset, addrPostWinOffset, 0, null, 0, "Window: Check Offset == 0");
		compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Window: Decrement Offset");
		compiler.emit(Opcode.Goto, 0, addrSkipWinRow, 0, null, 0, "Window: Skip Row (Offset)");
		compiler.resolveAddress(addrPostWinOffset);
	}

	compiler.emit(Opcode.ResultRow, outputBaseReg, finalColumnMap.length, 0, null, 0, "Output Window Function Row");

	if (regLimit > 0) {
		const addrWinLimitNotZero = compiler.allocateAddress('winLimitNotZero');
		compiler.emit(Opcode.IfZero, regLimit, addrWinLimitNotZero, 0, null, 0, "Window: Skip Limit Check if 0");
		compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Window: Decrement Limit");
		compiler.emit(Opcode.IfZero, regLimit, finalLoopEndAddr, 0, null, 0, "Window: Check Limit Reached");
		compiler.resolveAddress(addrWinLimitNotZero);
	}

	compiler.resolveAddress(addrSkipWinRow);
	compiler.emit(Opcode.VNext, windowSorterInfo.cursor, addrWinLoopStart, 0, null, 0, "Next Window Row -> Loop Start");
	compiler.emit(Opcode.Goto, 0, finalLoopEndAddr, 0, null, 0, "Window Loop Finished, Go To Final End"); // Should be hit if VNext falls through (EOF)
}
