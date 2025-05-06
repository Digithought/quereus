import type { Compiler } from './compiler.js';
import type { ColumnResultInfo } from './structs.js';
import type { TableSchema } from '../schema/table.js';
import { Opcode } from '../vdbe/opcodes.js';
import * as AST from '../parser/ast.js'; // Import AST
import { compileExpression } from './expression.js'; // Import expression compiler
import * as CompilerState from './compilerState.js'; // Import CompilerState

export function processRowDirect(
	compiler: Compiler,
	stmt: AST.SelectStmt, // Use actual type
	joinLevels: ReadonlyArray<any>, // Replace with actual JoinLevelInfo type
	activeOuterCursors: ReadonlySet<number>,
	innermostWhereFailTarget: number | undefined, // Not used directly here, but part of signature
	needsExternalSort: boolean,
	ephSortCursor: number,
	ephSortSchema: TableSchema | undefined,
	regLimit: number,
	regOffset: number
): number {
	const callbackStartAddr = CompilerState.getCurrentAddressHelper(compiler);

	// Get the structure (registers, mapping) but don't compile expressions here
	const { resultBaseReg: coreResultBase, numCols: coreNumCols, columnMap: coreColumnMap } =
		compiler.getSelectCoreStructure(stmt, [...activeOuterCursors]);

	for (const colInfo of coreColumnMap) {
		if (colInfo.expr) {
			// Pass activeOuterCursors for potential correlation
			// HavingContext is not applicable here
			// ArgumentMap is not applicable here
			compileExpression(compiler, colInfo.expr, colInfo.targetReg);
		}
		// If expr is null (e.g., from SELECT * expansion), VColumn already populated the register.
	}

	if (needsExternalSort) {
		// --- Store in Sorter ---
		const insertDataReg = compiler.allocateMemoryCells(coreNumCols + 1);
		compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Direct Sort: NULL Rowid");
		compiler.emit(Opcode.Move, coreResultBase, insertDataReg + 1, coreNumCols, null, 0, "Direct Sort: Copy row result");
		compiler.emit(Opcode.VUpdate, coreNumCols + 1, insertDataReg, ephSortCursor, { table: ephSortSchema }, 0, "Direct Sort: Insert Row");
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

		compiler.emit(Opcode.ResultRow, coreResultBase, coreNumCols, 0, null, 0, "Output Direct Row");

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
