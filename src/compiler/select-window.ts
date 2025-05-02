import type { Compiler } from './compiler.js';
import type { WindowSorterInfo, setupWindowSorter } from './window.js'; // Assuming these are moved/exported
import { compileWindowFunctionsPass } from './window_pass.js'; // Assuming this is moved/exported
import type * as AST from '../parser/ast.js';
import { Opcode } from '../vdbe/opcodes.js';
import { expressionToString } from '../util/ddl-stringify.js';
import type { ColumnResultInfo } from './compiler.js'; // Or wherever defined
import { createLogger } from '../common/logger.js'; // Import logger
import type { RowProcessingContext } from './select-loop.js'; // Import the context type

const log = createLogger('compiler:select-window');
const warnLog = log.extend('warn');

export function processRowWindow(
	compiler: Compiler,
	stmt: AST.SelectStmt,
	currentRowColumnMap: ReadonlyArray<ColumnResultInfo>,
	windowSorterInfo: WindowSorterInfo,
	context: RowProcessingContext // Added context parameter
): number {
	const callbackStartAddr = compiler.getCurrentAddress();

	// Handle LEFT JOIN NULL padding
	if (context.isLeftJoinPadding) {
		log("Processing LEFT JOIN NULL padding in window function mode");
		// For window functions with LEFT JOIN padding, we need to make sure any window
		// partition by/order by expressions that use columns from the inner relation
		// correctly evaluate to NULL.
		// Generally this will happen naturally through the normal expression evaluation,
		// but we can add this note to be explicit about the expected behavior.
	}

	// Populate window sorter registers with the current row data
	const sorterDataReg = windowSorterInfo.dataBaseReg;
	windowSorterInfo.schema.columns.forEach((col, i) => {
		const sourceExpr = windowSorterInfo.indexToExpression.get(i);

		// If this column is from a cursor in context.isLeftJoinPadding?.innerContributingCursors,
		// we should set it to NULL. However, expression-based sorter columns don't store
		// their cursor information directly, so we'd need a more complex mapping.
		// In practice, the compileExpression will naturally handle NULL propagation.

		if (sourceExpr) {
			// Data column needed for partition/order/args
			const coreColInfo = currentRowColumnMap.find(info =>
				info.expr && expressionToString(info.expr) === expressionToString(sourceExpr));
			if (coreColInfo) {
				// If we're in LEFT JOIN padding mode AND this column is from an inner cursor, make it NULL
				if (context.isLeftJoinPadding &&
				    coreColInfo.sourceCursor !== -1 &&
				    context.isLeftJoinPadding.innerContributingCursors.has(coreColInfo.sourceCursor)) {
					compiler.emit(Opcode.Null, 0, sorterDataReg + i, 0, null, 0,
						`NULL Pad for LEFT JOIN: ${expressionToString(sourceExpr).substring(0, 20)}`);
				} else {
					compiler.emit(Opcode.Move, coreColInfo.targetReg, sorterDataReg + i, 1, null, 0,
						`Move ${i}: ${expressionToString(sourceExpr).substring(0, 20)}`);
				}
			} else {
				compiler.emit(Opcode.Null, 0, sorterDataReg + i, 1, null, 0,
					`NULL for sorter col ${i} (expr not found in current row)`);
			}
		} else {
			// Placeholder for window function result
			compiler.emit(Opcode.Null, 0, sorterDataReg + i, 1, null, 0,
				`NULL placeholder for window result col ${i}`);
		}
	});

	// Insert the data into the window sorter
	const recordReg = compiler.allocateMemoryCells(1);
	const rowidReg = compiler.allocateMemoryCells(1);
	compiler.emit(Opcode.Null, 0, rowidReg, 0, null, 0, "Window Sort: NULL Rowid");
	compiler.emit(Opcode.MakeRecord, sorterDataReg, windowSorterInfo.schema.columns.length, recordReg, null, 0, "Make Window Sort Record");
	const insertDataReg = compiler.allocateMemoryCells(windowSorterInfo.schema.columns.length + 1);
	compiler.emit(Opcode.Move, rowidReg, insertDataReg, 1, null, 0, "Copy rowid for insert");
	compiler.emit(Opcode.Move, sorterDataReg, insertDataReg + 1, windowSorterInfo.schema.columns.length, null, 0, "Copy data for insert");
	compiler.emit(Opcode.VUpdate, windowSorterInfo.schema.columns.length + 1, insertDataReg, windowSorterInfo.cursor, { table: windowSorterInfo.schema }, 0, "Insert Row into Window Sorter");

	return callbackStartAddr;
}


export function compileWindowOutput(
	compiler: Compiler,
	windowSorterInfo: WindowSorterInfo,
	finalColumnMap: ReadonlyArray<ColumnResultInfo>,
	sharedFrameDefinition: AST.WindowFrame | undefined,
	regLimit: number,
	regOffset: number,
	finalLoopEndAddr: number // Address to jump to when done
): void {
	// Sort the window data
	compiler.emit(Opcode.Sort, windowSorterInfo.cursor, 0, 0, null, 0, "Sort Window Function Data");

	const outputBaseReg = compiler.allocateMemoryCells(finalColumnMap.length);

	// Run the window functions pass
	compileWindowFunctionsPass(compiler, windowSorterInfo, outputBaseReg, finalColumnMap.length, sharedFrameDefinition);

	// Loop through sorted data and build final output
	const addrWinLoopStart = compiler.allocateAddress('winLoopStart');
	// const addrWinLoopEnd = compiler.allocateAddress('winLoopEnd'); // Use finalLoopEndAddr instead

	compiler.emit(Opcode.Rewind, windowSorterInfo.cursor, finalLoopEndAddr, 0, null, 0, "Rewind Window Sorter for Output");
	compiler.resolveAddress(addrWinLoopStart);

	// Move data from sorter or calculated results to output registers
	finalColumnMap.forEach((colInfo, i) => {
		if (colInfo.expr?.type === 'windowFunction') {
			const placeholderInfo = windowSorterInfo!.windowResultPlaceholders.get(colInfo.expr);
			if (!placeholderInfo) throw new Error(`Internal error: Window placeholder not found for output column ${i}`);
			compiler.emit(Opcode.Move, placeholderInfo.resultReg, outputBaseReg + i, 1, null, 0, `Move window result to output ${i}`);
		} else {
			const sorterColIdx = colInfo.sourceColumnIndex;
			compiler.emit(Opcode.VColumn, windowSorterInfo!.cursor, sorterColIdx, outputBaseReg + i, null, 0, `Read sorter col ${sorterColIdx} to output ${i}`);
		}
	});

	// Apply LIMIT/OFFSET
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
	compiler.emit(Opcode.VNext, windowSorterInfo.cursor, finalLoopEndAddr, 0, null, 0, "Next Window Row");
	compiler.emit(Opcode.Goto, 0, addrWinLoopStart, 0, null, 0, "Window Loop");

	// Close window sorter cursor (moved to main orchestrator?)
	// compiler.emit(Opcode.Close, windowSorterInfo.cursor, 0, 0, null, 0, "Close Window Sorter");
}
