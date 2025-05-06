import type { Compiler } from './compiler.js';
import type { ColumnResultInfo } from './structs.js';
import type { TableSchema } from '../schema/table.js';
import { Opcode } from '../vdbe/opcodes.js';
import type * as AST from '../parser/ast.js'; // Import AST
import { compileExpression } from './expression.js'; // Import expression compiler
import { createLogger } from '../common/logger.js';
import type { RowProcessingContext } from './select-loop.js';
import { expressionToString } from '../util/ddl-stringify.js';

const log = createLogger('compiler:select-output');
const warnLog = log.extend('warn');

export function processRowDirect(
	compiler: Compiler,
	stmt: AST.SelectStmt, // Use actual type
	plannedSteps: ReadonlyArray<any>, // Changed from joinLevels, kept ReadonlyArray<any> for now
	activeOuterCursors: ReadonlySet<number>,
	context: RowProcessingContext,
	needsExternalSort: boolean = false,
	ephSortCursor: number = -1,
	ephSortSchema: TableSchema | undefined = undefined,
	regLimit: number = 0,
	regOffset: number = 0
): number {
	const callbackStartAddr = compiler.getCurrentAddress();

	const { resultBaseReg: coreResultBase, numCols: coreNumCols, columnMap: coreColumnMap } =
		compiler.getSelectCoreStructure(stmt, [...activeOuterCursors]);

	// Compile expressions into their target registers for the current row
	for (const colInfo of coreColumnMap) {
		if (colInfo.expr) {
			// Pass activeOuterCursors for potential correlation
			// HavingContext is not applicable here
			// ArgumentMap is not applicable here
			compiler.compileExpression(colInfo.expr, colInfo.targetReg, undefined, undefined, undefined);
		}
		// If expr is null (e.g., from SELECT * expansion), VColumn already populated the register if source is direct column.
	}

	// LEFT JOIN NULL padding handling
	if (context.isLeftJoinPadding) {
		log("Processing LEFT JOIN NULL padding in direct output");

		const innerCursors = context.isLeftJoinPadding.innerContributingCursors;

		context.finalColumnMap.forEach((finalColInfo, idx) => {
			const isFromInnerRelation = finalColInfo.sourceCursor !== -1 && innerCursors.has(finalColInfo.sourceCursor);
			if (isFromInnerRelation) {
				// Find the corresponding column in the *currently computed* row map (coreColumnMap)
				// to identify the correct target register for NULLing for *this specific output context*.
				// This assumes that `finalColumnMap` (defining overall output) and `coreColumnMap` (current row being processed)
				// have a correspondence that allows us to find the right register in `coreColumnMap` to NULL out.
				const correspondingCoreCol = coreColumnMap.find(coreCol =>
					(finalColInfo.expr && coreCol.expr && expressionToString(finalColInfo.expr) === expressionToString(coreCol.expr)) ||
					(!finalColInfo.expr && !coreCol.expr && finalColInfo.sourceColumnIndex === coreCol.sourceColumnIndex && finalColInfo.sourceCursor === coreCol.sourceCursor)
				);

				if (correspondingCoreCol) {
					compiler.emit(Opcode.Null, 0, correspondingCoreCol.targetReg, 0, null, 0, `NULL Pad LEFT JOIN col from cursor ${finalColInfo.sourceCursor} into reg ${correspondingCoreCol.targetReg}`);
				} else {
					// This case is tricky. If finalColumnMap has columns not in coreColumnMap (e.g. aggregates combined with joins),
					// direct output might not be the right place, or the mapping logic needs to be more robust.
					// For simple direct output, finalColumnMap should align with coreColumnMap.
					warnLog(`Could not find matching current row register (coreColumnMap) for final column index ${idx} ('${finalColInfo.expr ? expressionToString(finalColInfo.expr) : `cursor ${finalColInfo.sourceCursor} col ${finalColInfo.sourceColumnIndex}`}') during LEFT JOIN padding.`);
					// As a fallback, if we know the final target register from finalColInfo, and it's supposed to be NULL,
					// but it wasn't part of the core compilation (e.g. complex structure), this might be an issue.
					// However, for processRowDirect, coreColumnMap *should* represent the row being outputted.
					// So, if `correspondingCoreCol` is not found, it implies a potential mismatch or complex case not handled here.
				}
			}
		});
	}

	if (needsExternalSort) {
		const insertDataReg = compiler.allocateMemoryCells(coreNumCols + 1);
		compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Direct Sort: NULL Rowid");
		compiler.emit(Opcode.Move, coreResultBase, insertDataReg + 1, coreNumCols, null, 0, "Direct Sort: Copy row result");
		compiler.emit(Opcode.VUpdate, coreNumCols + 1, insertDataReg, ephSortCursor, { table: ephSortSchema }, 0, "Direct Sort: Insert Row");
	} else {
		const addrSkipDirectRow = compiler.allocateAddress('skipDirectRow');
		if (regLimit > 0) {
			const addrPostDirectOffset = compiler.allocateAddress('postDirectOffset');
			compiler.emit(Opcode.IfZero, regOffset, addrPostDirectOffset, 0, null, 0, "Direct: Check Offset == 0");
			compiler.emit(Opcode.Subtract, 1, regOffset, regOffset, null, 0, "Direct: Decrement Offset");
			compiler.emit(Opcode.Goto, 0, addrSkipDirectRow, 0, null, 0, "Direct: Skip Row (Offset)");
			compiler.resolveAddress(addrPostDirectOffset);
		}

		compiler.emit(Opcode.ResultRow, coreResultBase, coreNumCols, 0, null, 0, "Output Direct Row");

		if (regLimit > 0) {
			const addrDirectLimitNotZero = compiler.allocateAddress('directLimitNotZero');
			compiler.emit(Opcode.IfZero, regLimit, addrDirectLimitNotZero, 0, null, 0, "Direct: Skip Limit Check if 0");
			compiler.emit(Opcode.Subtract, 1, regLimit, regLimit, null, 0, "Direct: Decrement Limit");
			// TODO: The jump target for limit reached needs to be the overall loop end placeholder.
			// This requires passing it down or having a known address.
			// For now, using a locally allocated placeholder that might need to be globally resolved.
			const jumpTargetIfLimitReached = compiler.allocateAddress('limitReachedDirectOutput');
			compiler.emit(Opcode.IfZero, regLimit, jumpTargetIfLimitReached, 0, null, 0, "Direct: Check Limit Reached");
			compiler.resolveAddress(addrDirectLimitNotZero);
			// warnLog(`Limit reached jump target ${jumpTargetIfLimitReached} in processRowDirect needs to point to the final loop exit.`);
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
	finalLoopEndAddr: number
): void {
	const addrSortLoopStart = compiler.allocateAddress('sortLoopStart');
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
	compiler.emit(Opcode.VNext, ephSortCursor, addrSortLoopStart, 0, null, 0, "VNext Sorter -> Loop Start"); // P2 = loop start
	compiler.emit(Opcode.Goto, 0, finalLoopEndAddr, 0, null, 0, "Sort Loop Finished, Go to Final End"); // This GOTO is hit if VNext falls through (EOF)
}
