import type { Compiler } from './compiler.js';
import type { ColumnResultInfo } from './compiler.js'; // Or wherever it's defined
import type { TableSchema } from '../schema/table.js';
import { Opcode } from '../vdbe/opcodes.js';
import { createLogger } from '../common/logger.js';
import type { RowProcessingContext } from './select-loop.js'; // Import the context type
import { expressionToString } from '../util/ddl-stringify.js';

const log = createLogger('compiler:select-output');
const warnLog = log.extend('warn');

export function processRowDirect(
	compiler: Compiler,
	stmt: any, // Replace with actual AST.SelectStmt type
	plannedSteps: ReadonlyArray<any>, // Changed from joinLevels
	activeOuterCursors: ReadonlySet<number>,
	context: RowProcessingContext, // Changed to use context object
	needsExternalSort: boolean = false,
	ephSortCursor: number = -1,
	ephSortSchema: TableSchema | undefined = undefined,
	regLimit: number = 0,
	regOffset: number = 0
): number {
	const callbackStartAddr = compiler.getCurrentAddress();

	// Re-calculate core results inside the loop to have current row values
	const { resultBaseReg: currentRowResultBase, numCols: currentRowNumCols, columnMap: currentRowColumnMap } =
		compiler.compileSelectCore(stmt, [...activeOuterCursors]); // Re-compile expressions for current row

	// LEFT JOIN NULL padding handling
	if (context.isLeftJoinPadding) {
		log("Processing LEFT JOIN NULL padding in direct output");

		// If this is LEFT JOIN padding, we need to NULL out registers from the inner relation
		// Find columns in finalColumnMap that correspond to the inner relation's cursors
		const innerCursors = context.isLeftJoinPadding.innerContributingCursors;

		// Iterate the FINAL column map provided in the context
		context.finalColumnMap.forEach((colInfo, idx) => {
			// Check if the source cursor for this *final output column* is one of the inner cursors
			const isFromInnerRelation = colInfo.sourceCursor !== -1 && innerCursors.has(colInfo.sourceCursor);
			if (isFromInnerRelation) {
				// This column comes from the inner relation of our LEFT JOIN - make it NULL
				// The targetReg here refers to the register in the *final* output structure
				const finalTargetReg = colInfo.targetReg;
				// We need to find the corresponding register in the *current* row's output
				// This requires mapping based on expression or index if structure is consistent.
				// Assuming the structure IS consistent between coreResult and finalColumnMap for non-agg/window cases.
				// Find the equivalent column in the *currently computed* row map
				const currentRowColInfo = currentRowColumnMap.find(currentRowCol =>
					// Attempt matching by expression string if available, otherwise index might be ambiguous
					(colInfo.expr && currentRowCol.expr && expressionToString(colInfo.expr) === expressionToString(currentRowCol.expr))
					// Fallback to index - this assumes the core compilation result columns are in the same order
					// as the final output columns, which might not hold if transformations happen.
					?? currentRowColumnMap[idx]
				);

				if (currentRowColInfo) {
					const targetReg = currentRowColInfo.targetReg;
					compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `NULL Pad LEFT JOIN col from cursor ${colInfo.sourceCursor} into reg ${targetReg}`);
				} else {
					warnLog(`Could not find matching current row register for final column index ${idx} during LEFT JOIN padding.`);
					// Attempting to NULL the final target register directly might be incorrect
					// if it hasn't been populated yet or is reused.
					// compiler.emit(Opcode.Null, 0, finalTargetReg, 0, null, 0, `NULL Pad Attempt on Final Reg ${finalTargetReg}`);
				}
			}
			// Otherwise, the column is computed normally (already handled by compileSelectCore earlier in this function)
		});
	}

	if (needsExternalSort) {
		// --- Store in Sorter ---
		const insertDataReg = compiler.allocateMemoryCells(currentRowNumCols + 1);
		compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Direct Sort: NULL Rowid");
		compiler.emit(Opcode.Move, currentRowResultBase, insertDataReg + 1, currentRowNumCols, null, 0, "Direct Sort: Copy row result");
		compiler.emit(Opcode.VUpdate, currentRowNumCols + 1, insertDataReg, ephSortCursor, { table: ephSortSchema }, 0, "Direct Sort: Insert Row");
	} else {
		// --- Direct Output ---
		const addrSkipDirectRow = compiler.allocateAddress('skipDirectRow');
		if (regLimit > 0) {
			const addrPostDirectOffset = compiler.allocateAddress('postDirectOffset');
			compiler.emit(Opcode.IfZero, regOffset, addrPostDirectOffset, 0, null, 0, "Direct: Check Offset == 0");
			compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Direct: Decrement Offset");
			compiler.emit(Opcode.Goto, 0, addrSkipDirectRow, 0, null, 0, "Direct: Skip Row (Offset)");
			compiler.resolveAddress(addrPostDirectOffset);
		}

		compiler.emit(Opcode.ResultRow, currentRowResultBase, currentRowNumCols, 0, null, 0, "Output Direct Row");

		if (regLimit > 0) {
			const addrDirectLimitNotZero = compiler.allocateAddress('directLimitNotZero');
			compiler.emit(Opcode.IfZero, regLimit, addrDirectLimitNotZero, 0, null, 0, "Direct: Skip Limit Check if 0");
			compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Direct: Decrement Limit");
			// If limit is reached, jump to the end of the *entire* loop structure
			// This placeholder needs to be passed down or handled differently.
			// Using a placeholder jumpTargetIfLimitReached for now.
			const jumpTargetIfLimitReached = compiler.allocateAddress('limitReachedDirect'); // Needs proper target
			compiler.emit(Opcode.IfZero, regLimit, jumpTargetIfLimitReached, 0, null, 0, "Direct: Check Limit Reached");
			compiler.resolveAddress(addrDirectLimitNotZero);
			// TODO: Resolve jumpTargetIfLimitReached at the actual end point (e.g., passed from compileSelectLoop)
		}
		compiler.resolveAddress(addrSkipDirectRow);
	}
	return callbackStartAddr;
}


export function compileSortOutput(
	compiler: Compiler,
	ephSortCursor: number,
	ephSortSchema: TableSchema,
	finalNumCols: number,
	regLimit: number,
	regOffset: number,
	finalLoopEndAddr: number // Address to jump to when done or limit reached
): void {
	const addrSortLoopStart = compiler.allocateAddress('sortLoopStart');
	// const addrSortLoopEnd = compiler.allocateAddress('sortLoopEnd'); // Use finalLoopEndAddr instead
	const sortedResultBaseReg = compiler.allocateMemoryCells(finalNumCols);

	compiler.emit(Opcode.Rewind, ephSortCursor, finalLoopEndAddr, 0, null, 0, "Rewind Sorter");
	compiler.resolveAddress(addrSortLoopStart);

	const addrSkipSortedRow = compiler.allocateAddress('skipSortedRow');
	if (regLimit > 0) {
		const addrPostSortOffsetCheck = compiler.allocateAddress('postSortOffsetCheck');
		compiler.emit(Opcode.IfZero, regOffset, addrPostSortOffsetCheck, 0, null, 0, "Sort Check Offset == 0");
		compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Sort Decrement Offset");
		compiler.emit(Opcode.Goto, 0, addrSkipSortedRow, 0, null, 0, "Sort Skip Row (Offset)");
		compiler.resolveAddress(addrPostSortOffsetCheck);
	}

	for (let i = 0; i < finalNumCols; i++) {
		compiler.emit(Opcode.VColumn, ephSortCursor, i, sortedResultBaseReg + i, 0, 0, `Read Sorted Col ${i}`);
	}
	compiler.emit(Opcode.ResultRow, sortedResultBaseReg, finalNumCols, 0, null, 0, "Output sorted row");

	if (regLimit > 0) {
		const addrSortLimitNotZero = compiler.allocateAddress('sortLimitNotZero');
		compiler.emit(Opcode.IfZero, regLimit, addrSortLimitNotZero, 0, null, 0, "Sort Skip Limit Check if already 0");
		compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Sort Decrement Limit");
		compiler.emit(Opcode.IfZero, regLimit, finalLoopEndAddr, 0, null, 0, "Sort Check Limit Reached");
		compiler.resolveAddress(addrSortLimitNotZero);
	}

	compiler.resolveAddress(addrSkipSortedRow);
	compiler.emit(Opcode.VNext, ephSortCursor, finalLoopEndAddr, 0, null, 0, "VNext Sorter");
	compiler.emit(Opcode.Goto, 0, addrSortLoopStart, 0, null, 0, "Loop Sorter Results");

	// No need to resolve addrSortLoopEnd, finalLoopEndAddr is used
}
