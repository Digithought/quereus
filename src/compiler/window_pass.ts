import { Compiler } from './compiler';
import type { WindowSorterInfo } from './window';
import { Opcode } from '../common/constants';
import { SqliteError } from '../common/errors';
import type * as AST from '../parser/ast'; // Import AST types
import { expressionToString } from '../util/ddl-stringify'; // Import the missing function
import type { FunctionSchema } from '../schema/function'; // Import FunctionSchema for P5
import type { P5AggFrameInfo } from '../vdbe/instruction'; // Import P5AggFrameInfo
import type { P4RangeScanInfo } from '../vdbe/instruction'; // Import P4RangeScanInfo
import type { P4LagLeadInfo } from '../vdbe/instruction'; // Import P4LagLeadInfo
import { StatusCode } from '../common/types'; // Import StatusCode

/**
 * Compiles the pass for calculating window functions after the data
 * has been sorted into the window sorter ephemeral table.
 *
 * Assumes all window functions in this pass share the same frame definition
 * (if any is present).
 *
 * @param compiler The compiler instance.
 * @param windowSorterInfo Information about the window sorter setup.
 * @param finalResultBaseReg The base register for the final result row (used for output mapping).
 * @param finalNumCols The number of columns in the final result row (used for output mapping).
 * @param frameDefinition The shared frame definition for window functions in this pass (optional).
 */
export function compileWindowFunctionsPass(
	compiler: Compiler,
	windowSorterInfo: WindowSorterInfo,
	finalResultBaseReg: number,
	finalNumCols: number,
	frameDefinition?: AST.WindowFrame
): void {
	const winSortCursor = windowSorterInfo.cursor;
	const winNumCols = windowSorterInfo.schema.columns.length;
	const numPartitionKeys = windowSorterInfo.numPartitionKeys;
	const allKeyIndices = windowSorterInfo.sortKeyP4.keyIndices;
	const partitionKeyIndices = allKeyIndices.slice(0, numPartitionKeys);
	const orderKeyIndices = allKeyIndices.slice(numPartitionKeys);
	const numOrderKeys = orderKeyIndices.length;

	// Registers for partition/order logic
	const regWinRowKeys = compiler.allocateMemoryCells(numPartitionKeys > 0 ? numPartitionKeys : 1);
	const regPrevPartitionKeys = compiler.allocateMemoryCells(numPartitionKeys > 0 ? numPartitionKeys : 1);
	const regIsNewPartition = compiler.allocateMemoryCells(1);
	const regWinRowData = compiler.allocateMemoryCells(winNumCols); // Holds the full sorter row
	const regRowNumberCounter = compiler.allocateMemoryCells(1);
	const regOne = compiler.allocateMemoryCells(1);
	const regCurrentOrderKeys = compiler.allocateMemoryCells(numOrderKeys > 0 ? numOrderKeys : 1);
	const regPrevOrderKeys = compiler.allocateMemoryCells(numOrderKeys > 0 ? numOrderKeys : 1);
	const regRank = compiler.allocateMemoryCells(1);
	const regDenseRank = compiler.allocateMemoryCells(1);
	const regOrderKeysDiffer = compiler.allocateMemoryCells(1);

	// Registers for Frame State
	let regFrameStartPtr = 0; // Rowid/pointer of the first row in the current frame
	let regFrameEndPtr = 0;   // Rowid/pointer of the last row in the current frame
	let regCurrentRowPtr = 0; // Rowid/pointer of the current row being processed
	let regPartitionStartPtr = 0; // Rowid/pointer of the first row in the current partition
	let regPartitionEndPtr = 0;   // Rowid/pointer of the last row in the current partition (less common)
	// Registers for bound values if they are expressions
	let regStartBoundValue = 0;
	let regEndBoundValue = 0;

	// Allocate partition start rowid register here
	let regPartitionStartRowid = 0;

	if (frameDefinition) {
		regFrameStartPtr = compiler.allocateMemoryCells(1);
		regFrameEndPtr = compiler.allocateMemoryCells(1);
		regCurrentRowPtr = compiler.allocateMemoryCells(1);
		regPartitionStartPtr = compiler.allocateMemoryCells(1);
		// Allocate partition start rowid register if frame definition exists
		regPartitionStartRowid = compiler.allocateMemoryCells(1);
		// Allocate registers for bound values if they are expressions
		if (frameDefinition.start.type === 'preceding' || frameDefinition.start.type === 'following') {
			if( (frameDefinition.start as { value: AST.Expression }).value ){ // Check if value exists
				regStartBoundValue = compiler.allocateMemoryCells(1);
			}
		}
		if (frameDefinition.end && (frameDefinition.end.type === 'preceding' || frameDefinition.end.type === 'following')) {
			if( (frameDefinition.end as { value: AST.Expression }).value ){ // Check if value exists
				regEndBoundValue = compiler.allocateMemoryCells(1);
			}
		}

		compiler.emit(Opcode.Null, 0, regFrameStartPtr, 1, null, 0, "Init Frame Start Ptr");
		compiler.emit(Opcode.Null, 0, regFrameEndPtr, 1, null, 0, "Init Frame End Ptr");
		compiler.emit(Opcode.Null, 0, regCurrentRowPtr, 1, null, 0, "Init Current Row Ptr");
		compiler.emit(Opcode.Null, 0, regPartitionStartPtr, 1, null, 0, "Init Partition Start Ptr");
		compiler.emit(Opcode.Null, 0, regPartitionStartRowid, 1, null, 0, "Init Partition Start Rowid");
	}

	// Jump addresses
	const addrWindowLoopStart = compiler.allocateAddress();
	const addrWindowLoopEnd = compiler.allocateAddress();
	const addrNewPartitionFound = compiler.allocateAddress();
	const addrPartitionCheckDone = compiler.allocateAddress();
	const addrPostPartitionReset = compiler.allocateAddress();

	// Initialize state before loop
	if (numPartitionKeys > 0) {
		compiler.emit(Opcode.Null, 0, regPrevPartitionKeys, numPartitionKeys, null, 0, "Init Prev Partition Keys to NULL");
	} else {
		compiler.emit(Opcode.Integer, 1, regIsNewPartition, 0, null, 0, "Init: Assume first row is new 'partition'");
	}
	if (numOrderKeys > 0) {
		compiler.emit(Opcode.Null, 0, regPrevOrderKeys, numOrderKeys, null, 0, "Init Prev Order Keys to NULL");
	}
	compiler.emit(Opcode.Integer, 0, regRowNumberCounter, 0, null, 0, "Init Row Number Counter to 0");
	compiler.emit(Opcode.Integer, 0, regRank, 0, null, 0, "Init Rank");
	compiler.emit(Opcode.Integer, 0, regDenseRank, 0, null, 0, "Init Dense Rank");
	compiler.emit(Opcode.Integer, 1, regOne, 0, null, 0, "Load constant 1");

	// Start Window Loop
	compiler.emit(Opcode.Rewind, winSortCursor, addrWindowLoopEnd, 0, null, 0, "Rewind Window Sorter");
	compiler.resolveAddress(addrWindowLoopStart);

	// Get current row pointer/rowid (needed for frame calcs)
	if(frameDefinition) {
		compiler.emit(Opcode.VRowid, winSortCursor, regCurrentRowPtr, 0, null, 0, "Get Current Row Pointer");
	}

	// Partition Boundary Detection
	if (numPartitionKeys > 0) {
		compiler.emit(Opcode.Integer, 0, regIsNewPartition, 0, null, 0, "Assume same partition");
		for (let i = 0; i < numPartitionKeys; i++) {
			const pkIndex = partitionKeyIndices[i];
			const regCurrentKey = regWinRowKeys + i;
			const regPrevKey = regPrevPartitionKeys + i;
			compiler.emit(Opcode.VColumn, winSortCursor, pkIndex, regCurrentKey, null, 0, `Read Win Part Key ${i} (idx ${pkIndex})`);
			compiler.emit(Opcode.Ne, regCurrentKey, addrNewPartitionFound, regPrevKey, null, 0x01, `Check Part Key ${i} != Prev`);
		}
		compiler.emit(Opcode.Goto, 0, addrPartitionCheckDone, 0, null, 0, "Partition Keys Match");

		compiler.resolveAddress(addrNewPartitionFound);
		compiler.emit(Opcode.Integer, 1, regIsNewPartition, 0, null, 0, "Flag New Partition");
		// Reset state
		compiler.emit(Opcode.Integer, 0, regRowNumberCounter, 0, null, 0, "Reset Row Number Counter to 0");
		compiler.emit(Opcode.Integer, 0, regRank, 0, null, 0, "Reset Rank Counter");
		compiler.emit(Opcode.Integer, 0, regDenseRank, 0, null, 0, "Reset Dense Rank Counter");
		if (numOrderKeys > 0) {
			compiler.emit(Opcode.Null, 0, regPrevOrderKeys, numOrderKeys, null, 0, "Reset Prev Order Keys to NULL");
		}
		// Reset Frame Pointers and set Partition Start Pointer
		if (frameDefinition) {
			compiler.emit(Opcode.Null, 0, regFrameStartPtr, 1, null, 0, "Reset Frame Start Ptr");
			compiler.emit(Opcode.Null, 0, regFrameEndPtr, 1, null, 0, "Reset Frame End Ptr");
			// Set Partition Start Pointer to the current row's pointer
			compiler.emit(Opcode.Move, regCurrentRowPtr, regPartitionStartPtr, 1, null, 0, "Set Partition Start Ptr");
			// Store Partition Start Rowid
			compiler.emit(Opcode.VRowid, winSortCursor, regPartitionStartRowid, 0, null, 0, "Store Partition Start Rowid");
		}
		compiler.emit(Opcode.Move, regWinRowKeys, regPrevPartitionKeys, numPartitionKeys, null, 0, `Update Prev Part Keys`);
		compiler.emit(Opcode.Goto, 0, addrPostPartitionReset, 0, null, 0, "Continue after partition reset");

		compiler.resolveAddress(addrPartitionCheckDone);
	} else {
		// Handle first row of single partition
		const addrNotFirstRow = compiler.allocateAddress();
		compiler.emit(Opcode.IfFalse, regIsNewPartition, addrNotFirstRow, 0, null, 0, "Check if first row");
		// It is the first row
		if (frameDefinition) {
			compiler.emit(Opcode.Move, regCurrentRowPtr, regPartitionStartPtr, 1, null, 0, "Set Partition Start Ptr (First Row)");
		}
		compiler.emit(Opcode.Integer, 0, regIsNewPartition, 0, null, 0, "Clear New Partition flag after first row");
		compiler.resolveAddress(addrNotFirstRow);
	}
	compiler.resolveAddress(addrPostPartitionReset);

	// Read full sorter row data
	for (let i = 0; i < winNumCols; i++) {
		if (numPartitionKeys > 0 && partitionKeyIndices.includes(i)) {
			const pkRegOffset = partitionKeyIndices.indexOf(i);
			compiler.emit(Opcode.Move, regWinRowKeys + pkRegOffset, regWinRowData + i, 1, null, 0, `Copy already read Part Key ${pkRegOffset}`);
		} else {
			compiler.emit(Opcode.VColumn, winSortCursor, i, regWinRowData + i, null, 0, `Read Win Full Row Col ${i}`);
		}
	}

	// Basic Window Function Calculation (Numbering)
	compiler.emit(Opcode.Add, regRowNumberCounter, regOne, regRowNumberCounter, null, 0, "Increment Row Number");
	compiler.emit(Opcode.Integer, 0, regOrderKeysDiffer, 0, null, 0, "Assume order keys same");
	if (numOrderKeys > 0) {
		const addrOrderCheckDone = compiler.allocateAddress();
		const addrOrderDiffer = compiler.allocateAddress();
		for (let i = 0; i < numOrderKeys; i++) {
			const okIndex = orderKeyIndices[i];
			const regCurrentKey = regWinRowData + okIndex;
			compiler.emit(Opcode.Move, regCurrentKey, regCurrentOrderKeys + i, 1, null, 0, `Store Current Order Key ${i}`);
			const regPrevKey = regPrevOrderKeys + i;
			compiler.emit(Opcode.Ne, regCurrentKey, addrOrderDiffer, regPrevKey, null, 0x01, `Check Order Key ${i}`); // Use Ne with null handling
		}
		compiler.emit(Opcode.Goto, 0, addrOrderCheckDone, 0, null, 0, "Order Keys Match");
		compiler.resolveAddress(addrOrderDiffer);
		compiler.emit(Opcode.Integer, 1, regOrderKeysDiffer, 0, null, 0, "Flag Order Keys Differ");
		compiler.resolveAddress(addrOrderCheckDone);
	}

	const addrUpdateRanks = compiler.allocateAddress();
	const addrRankCalcsDone = compiler.allocateAddress();
	compiler.emit(Opcode.IfTrue, regIsNewPartition, addrUpdateRanks, 0, null, 0, "If New Partition, Update Ranks");
	if (numOrderKeys > 0) {
		compiler.emit(Opcode.IfTrue, regOrderKeysDiffer, addrUpdateRanks, 0, null, 0, "If Order Keys Differ, Update Ranks");
	} else {
		compiler.emit(Opcode.IfFalse, regIsNewPartition, addrRankCalcsDone, 0, null, 0, "If same partition and no ORDER BY, skip rank update");
	}
	compiler.emit(Opcode.Goto, 0, addrRankCalcsDone, 0, null, 0, "Skip Rank Updates");
	compiler.resolveAddress(addrUpdateRanks);
	compiler.emit(Opcode.Move, regRowNumberCounter, regRank, 1, null, 0, "Update Rank = Current RowNumber");
	const addrSkipDenseRankInc = compiler.allocateAddress();
	compiler.emit(Opcode.IfTrue, regIsNewPartition, addrSkipDenseRankInc, 0, null, 0, "Skip Dense Rank check if new partition");
	compiler.emit(Opcode.IfFalse, regOrderKeysDiffer, addrSkipDenseRankInc, 0, null, 0, "Skip Dense Rank inc if order keys same");
	compiler.emit(Opcode.Add, regDenseRank, regOne, regDenseRank, null, 0, "Increment Dense Rank");
	compiler.resolveAddress(addrSkipDenseRankInc);
	compiler.resolveAddress(addrRankCalcsDone);

	// --- Frame Boundary Calculation and Update ---
	if (frameDefinition) {
		// Compile bound expressions if needed (only once per execution ideally, but here per row for simplicity)
		if (regStartBoundValue > 0 && frameDefinition.start.type !== 'currentRow' && frameDefinition.start.type !== 'unboundedPreceding' && frameDefinition.start.type !== 'unboundedFollowing') {
			compiler.compileExpression((frameDefinition.start as { value: AST.Expression }).value, regStartBoundValue);
		}
		if (regEndBoundValue > 0 && frameDefinition.end && frameDefinition.end.type !== 'currentRow' && frameDefinition.end.type !== 'unboundedPreceding' && frameDefinition.end.type !== 'unboundedFollowing') {
			compiler.compileExpression((frameDefinition.end as { value: AST.Expression }).value, regEndBoundValue);
		}

		if (frameDefinition.type === 'rows') {
			// --- ROWS Frame Start Calculation ---
			switch (frameDefinition.start.type) {
				case 'unboundedPreceding':
					// Start is the beginning of the partition
					compiler.emit(Opcode.Move, regPartitionStartPtr, regFrameStartPtr, 1, null, 0, "Frame Start = Partition Start");
					break;
				case 'preceding':
					// Start is N rows before current row
					// Placeholder: SeekRel(cursor, target_reg, base_ptr_reg, offset_reg, direction)
					// Direction: -1 for preceding, +1 for following
					compiler.emit(Opcode.SeekRel, winSortCursor, regFrameStartPtr, regCurrentRowPtr, regStartBoundValue, -1, `SeekRel ${winSortCursor} -> ${regFrameStartPtr} from ${regCurrentRowPtr} offset ${regStartBoundValue} dir -1`);
					// Need to handle boundary conditions (don't go before partition start)
					// Placeholder: MaxPtr(regFrameStartPtr, regPartitionStartPtr, regFrameStartPtr)
					compiler.emit(Opcode.MaxPtr, regFrameStartPtr, regPartitionStartPtr, regFrameStartPtr, null, 0, `MaxPtr ${regFrameStartPtr}, ${regPartitionStartPtr} -> ${regFrameStartPtr}`);
					break;
				case 'currentRow':
					// Start is the current row
					compiler.emit(Opcode.Move, regCurrentRowPtr, regFrameStartPtr, 1, null, 0, "Frame Start = Current Row");
					break;
				case 'following':
					// Start is N rows after current row
					compiler.emit(Opcode.SeekRel, winSortCursor, regFrameStartPtr, regCurrentRowPtr, regStartBoundValue, 1, `SeekRel ${winSortCursor} -> ${regFrameStartPtr} from ${regCurrentRowPtr} offset ${regStartBoundValue} dir +1`);
					// Need to handle boundary (don't go past end of partition - harder without knowing end)
					break;
				default:
					throw new Error(`Unhandled ROWS frame start type: ${(frameDefinition.start as any).type}`);

			}

			// --- ROWS Frame End Calculation ---
			const endBound = frameDefinition.end; // Can be null
			if (!endBound) {
				// Default end: CURRENT ROW if start is UNBOUNDED PRECEDING or N PRECEDING
				// Default end: UNBOUNDED FOLLOWING if start is CURRENT ROW or N FOLLOWING (SQLite behavior)
				// Let's assume default CURRENT ROW for simplicity now
				compiler.emit(Opcode.Move, regCurrentRowPtr, regFrameEndPtr, 1, null, 0, "Default Frame End = Current Row");
			} else {
				switch (endBound.type) {
					case 'unboundedFollowing':
						// End is the end of the partition (conceptually)
						// Need a way to represent this. Maybe seek to end or use a special marker.
						compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `Frame End = Partition End (Placeholder)`);
						// Store a special value (e.g., MAX_ROWID or NULL?)
						compiler.emit(Opcode.Null, 0, regFrameEndPtr, 1, null, 0, "Set Frame End to Partition End (Placeholder)");
						break;
					case 'preceding':
						compiler.emit(Opcode.SeekRel, winSortCursor, regFrameEndPtr, regCurrentRowPtr, regEndBoundValue, -1, `SeekRel ${winSortCursor} -> ${regFrameEndPtr} from ${regCurrentRowPtr} offset ${regEndBoundValue} dir -1`);
						// Need boundary check (not before partition start)
						compiler.emit(Opcode.MaxPtr, regFrameEndPtr, regPartitionStartPtr, regFrameEndPtr, null, 0, `MaxPtr ${regFrameEndPtr}, ${regPartitionStartPtr} -> ${regFrameEndPtr}`);
						break;
					case 'currentRow':
						compiler.emit(Opcode.Move, regCurrentRowPtr, regFrameEndPtr, 1, null, 0, "Frame End = Current Row");
						break;
					case 'following':
						compiler.emit(Opcode.SeekRel, winSortCursor, regFrameEndPtr, regCurrentRowPtr, regEndBoundValue, 1, `SeekRel ${winSortCursor} -> ${regFrameEndPtr} from ${regCurrentRowPtr} offset ${regEndBoundValue} dir +1`);
						// Need boundary check (not past partition end)
						break;
					default:
						throw new Error(`Unhandled ROWS frame end type: ${(endBound as any).type}`);
				}
			}
		} else if (frameDefinition.type === 'range') {
			// --- RANGE Frame Calculation ---
			// We use a single RangeScan opcode which performs the scan within the VDBE
			// based on the cursor's merged results and the frame definition.

			// Gather info needed for the P4 operand
			const orderByIndices = orderKeyIndices;
			const orderByDirs = windowSorterInfo.sortKeyP4.directions.slice(numPartitionKeys);
			const orderByColls = windowSorterInfo.sortKeyP4.collations?.slice(numPartitionKeys) ?? orderByIndices.map(() => undefined);

			const rangeScanInfo: P4RangeScanInfo = {
				type: 'rangescaninfo',
				frameDef: frameDefinition,
				orderByIndices: orderByIndices,
				orderByDirs: orderByDirs,
				orderByColls: orderByColls,
				currPtrReg: regCurrentRowPtr,
				partStartPtrReg: regPartitionStartPtr,
				startBoundReg: regStartBoundValue > 0 ? regStartBoundValue : undefined,
				endBoundReg: regEndBoundValue > 0 ? regEndBoundValue : undefined,
			};

			// compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `Placeholder: Calculate RANGE frame boundaries based on ORDER BY key values`);
			compiler.emit(Opcode.RangeScan, winSortCursor, regFrameStartPtr, regFrameEndPtr, rangeScanInfo, 0, `Calculate RANGE frame for ${winSortCursor}`);

		} else {
			throw new Error(`Unhandled frame type: ${frameDefinition.type}`);
		}
	}
	// -----------------------------------------------------------

	// Calculate Frame-Based Window Functions
	windowSorterInfo.windowResultPlaceholders.forEach((placeholderInfo, winExpr) => {
		const functionName = winExpr.function.name.toLowerCase();
		const resultReg = placeholderInfo.resultReg;

		switch (functionName) {
			case 'row_number':
				compiler.emit(Opcode.Move, regRowNumberCounter, resultReg, 1, null, 0, "Store ROW_NUMBER");
				break;
			case 'rank':
				compiler.emit(Opcode.Move, regRank, resultReg, 1, null, 0, "Store RANK");
				break;
			case 'dense_rank':
				compiler.emit(Opcode.Move, regDenseRank, resultReg, 1, null, 0, "Store DENSE_RANK");
				break;

			// --- Frame-Dependent Functions ---
			case 'sum':
			case 'avg':
			case 'count':
			case 'min':
			case 'max':
				if (!frameDefinition) {
					compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `WARN: Default frame assumed for ${functionName}`);
					// Assume default frame (range unbounded preceding to current row)
					// Use our helper function for frame-based aggregates
					const argColIndex = winExpr.function.args.length > 0 ?
						windowSorterInfo.exprToSorterIndex.get(expressionToString(winExpr.function.args[0])) ?? -1 : -1;

					// *** Create a default frame definition for the call ***
					const defaultFrameDef: AST.WindowFrame = {
						type: 'rows', // Defaulting to ROWS behavior for now
						start: { type: 'unboundedPreceding' },
						end: { type: 'currentRow' }
					};

					// Use the new frame aggregate helper with the default definition
					compileFrameAggregate(compiler, winSortCursor, functionName, winExpr, resultReg, defaultFrameDef, regStartBoundValue, regEndBoundValue, regPartitionStartRowid, numPartitionKeys, partitionKeyIndices, regWinRowKeys,
						// *** Pass Order By Info from windowSorterInfo ***
						{
							keyIndices: orderKeyIndices,
							directions: windowSorterInfo.sortKeyP4.directions.slice(numPartitionKeys),
							collations: windowSorterInfo.sortKeyP4.collations?.slice(numPartitionKeys)
						},
						windowSorterInfo);
				} else {
					// Similar to above, but with explicit frame definition
					const argColIndex = winExpr.function.args.length > 0 ?
						windowSorterInfo.exprToSorterIndex.get(expressionToString(winExpr.function.args[0])) ?? -1 : -1;

					// Use the helper function
					compileFrameAggregate(compiler, winSortCursor, functionName, winExpr, resultReg, frameDefinition, regStartBoundValue, regEndBoundValue, regPartitionStartRowid, numPartitionKeys, partitionKeyIndices, regWinRowKeys,
						// *** Pass Order By Info from windowSorterInfo ***
						{
							keyIndices: orderKeyIndices,
							directions: windowSorterInfo.sortKeyP4.directions.slice(numPartitionKeys),
							collations: windowSorterInfo.sortKeyP4.collations?.slice(numPartitionKeys)
						},
						windowSorterInfo);
				}
				break;

			case 'first_value':
			case 'last_value':
				if (!frameDefinition) {
					compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `WARN: Default frame assumed for ${functionName}`);
					// For first_value with default frame (unbounded preceding to current):
					// - Save current position
					// - Rewind cursor to start
					// - Get the value
					// - Restore cursor
					// For last_value with default frame (unbounded preceding to current):
					// - Current row is the last row, so just get the current value

					const argColIndex = windowSorterInfo.exprToSorterIndex.get(expressionToString(winExpr.function.args[0]));
					if (argColIndex === undefined) {
						throw new SqliteError(`${functionName} argument expression not found in sorter: ${expressionToString(winExpr.function.args[0])}`, StatusCode.ERROR);
					}

					if (functionName === 'first_value') {
						// Save current position
						const savedPosReg = compiler.allocateMemoryCells(1);
						// Not needed if we're using SeekRelative which manages cursor pos internally

						// Rewind to start of partition/frame
						compiler.emit(Opcode.Rewind, winSortCursor, 0, 0, null, 0, "Rewind for FIRST_VALUE");

						// Get the first value
						compiler.emit(Opcode.VColumn, winSortCursor, argColIndex, resultReg, null, 0, "Get FIRST_VALUE");

						// We can leave the cursor at this position since window functions
						// are calculated one at a time per row in the Window pass
					} else { // last_value with default frame
						// Current row is the last row of the default frame
						compiler.emit(Opcode.VColumn, winSortCursor, argColIndex, resultReg, null, 0, "Get LAST_VALUE (default=current row)");
					}
				} else {
					// Similar to above but with explicit frame definition
					const argColIndex = windowSorterInfo.exprToSorterIndex.get(expressionToString(winExpr.function.args[0]));
					if (argColIndex === undefined) {
						throw new SqliteError(`${functionName} argument expression not found in sorter: ${expressionToString(winExpr.function.args[0])}`, StatusCode.ERROR);
					}

					if (functionName === 'first_value') {
						// Save current position
						const savedPosReg = compiler.allocateMemoryCells(1);
						const curPosReg = compiler.allocateMemoryCells(1);
						compiler.emit(Opcode.Integer, 0, curPosReg, 0, null, 0, "Save starting position counter");

						// Calculate frame start position
						const frameStartAddrResolved = compileFrameBoundary(
							compiler, winSortCursor, frameDefinition.start, true,
							regStartBoundValue, regPartitionStartRowid,
							frameDefinition.type === 'range',
							// *** Pass Order By Info ***
							{
								keyIndices: orderKeyIndices,
								directions: windowSorterInfo.sortKeyP4.directions.slice(numPartitionKeys),
								collations: windowSorterInfo.sortKeyP4.collations?.slice(numPartitionKeys)
							},
							numPartitionKeys, partitionKeyIndices, regWinRowKeys // Pass partition info
						);
						compiler.resolveAddress(frameStartAddrResolved);

						// Get the value at frame start
						compiler.emit(Opcode.VColumn, winSortCursor, argColIndex, resultReg, null, 0, "Get FIRST_VALUE at frame start");

						// *** Restore original position ***
						compileRestoreCursorPosition(compiler, winSortCursor, savedPosReg, regPartitionStartRowid);

					} else { // last_value
						// Save current position
						const savedPosReg = compiler.allocateMemoryCells(1);
						const curPosReg = compiler.allocateMemoryCells(1);
						compiler.emit(Opcode.Integer, 0, curPosReg, 0, null, 0, "Save starting position counter");

						// Calculate frame end position based on frame definition
						const endBound = frameDefinition.end || { type: 'currentRow' };
						const frameEndAddrResolved = compileFrameBoundary(
							compiler, winSortCursor, endBound, false,
							regEndBoundValue, regPartitionStartRowid,
							frameDefinition.type === 'range',
							// *** Pass Order By Info ***
							{
								keyIndices: orderKeyIndices,
								directions: windowSorterInfo.sortKeyP4.directions.slice(numPartitionKeys),
								collations: windowSorterInfo.sortKeyP4.collations?.slice(numPartitionKeys)
							},
							numPartitionKeys, partitionKeyIndices, regWinRowKeys // Pass partition info
						);
						compiler.resolveAddress(frameEndAddrResolved);

						// Get the value at frame end
						compiler.emit(Opcode.VColumn, winSortCursor, argColIndex, resultReg, null, 0, "Get LAST_VALUE at frame end");

						// *** Restore original position ***
						compileRestoreCursorPosition(compiler, winSortCursor, savedPosReg, regPartitionStartRowid);
					}
				}
				break;

			case 'nth_value':
				// Needs frame and Nth argument handling
				compiler.emit(Opcode.Null, 0, resultReg, 1, null, 0, `Placeholder ${functionName}`);
				break;

			case 'lag':
			case 'lead': {
				// NEW IMPLEMENTATION using SeekRelative
				const cursorIdx = winSortCursor; // The window cursor
				const resultReg = placeholderInfo.resultReg; // The result register

				// Need to compile offset, which could be a constant or expression
				const offsetExpr = winExpr.function.args.length > 1 ? winExpr.function.args[1] : null;
				let offsetReg = compiler.allocateMemoryCells(1); // Change to 'let' instead of 'const'
				if (offsetExpr) {
					compiler.compileExpression(offsetExpr, offsetReg);
				} else {
					// Default offset is 1
					compiler.emit(Opcode.Integer, 1, offsetReg, 0, null, 0, "Default offset 1");
				}

				// Compile default value
				const defaultExpr = winExpr.function.args.length > 2 ? winExpr.function.args[2] : null;
				const defaultReg = compiler.allocateMemoryCells(1);
				if (defaultExpr) {
					compiler.compileExpression(defaultExpr, defaultReg);
				} else {
					compiler.emit(Opcode.Null, 0, defaultReg, 0, null, 0, "Default value NULL");
				}

				// If LAG, negate the offset
				if (functionName === 'lag') {
					const negOffsetReg = compiler.allocateMemoryCells(1);
					compiler.emit(Opcode.Negative, offsetReg, negOffsetReg, 0, null, 0, "Negate offset for LAG");
					offsetReg = negOffsetReg;
				}

				// Get column index for the argument
				const argExpr = winExpr.function.args[0];
				const argColIndex = windowSorterInfo.exprToSorterIndex.get(expressionToString(argExpr));
				if (argColIndex === undefined) {
					throw new SqliteError(`${functionName} argument expression not found in sorter: ${expressionToString(argExpr)}`, StatusCode.ERROR);
				}

				// Create jump addresses for branching
				const addrSeekFailed = compiler.allocateAddress();
				const addrRestore = compiler.allocateAddress(); // Address to jump to for restoring position

				// *** Save current cursor position ***
				const savedPosReg = compiler.allocateMemoryCells(1);
				compileSaveCursorPosition(compiler, cursorIdx, savedPosReg);

				// Attempt to seek relative by the offset
				// P5=1 means jump to addrSeekFailed if SeekRelative returns false
				compiler.emit(Opcode.SeekRelative, cursorIdx, addrSeekFailed, offsetReg, null, 1,
					`${functionName}: Seek ${functionName === 'lead' ? "forward" : "backward"} by offset`);

				// Seek successful - get the column value
				compiler.emit(Opcode.VColumn, cursorIdx, argColIndex, resultReg, null, 0,
					`${functionName}: Get column value`);

				// Skip default value logic and go directly to restore
				compiler.emit(Opcode.Goto, 0, addrRestore, 0, null, 0, `${functionName}: Skip default value`);

				// Seek failed - use default value
				compiler.resolveAddress(addrSeekFailed);
				compiler.emit(Opcode.SCopy, defaultReg, resultReg, 0, null, 0,
					`${functionName}: Use default value`);

				// *** Restore cursor position ***
				compiler.resolveAddress(addrRestore);
				compileRestoreCursorPosition(compiler, cursorIdx, savedPosReg /*, regPartitionStartRowid */);
				// TODO: Pass regPartitionStartRowid if needed for restore optimization

				break;
			}

			default:
				compiler.emit(Opcode.Null, 0, resultReg, 1, null, 0, `Placeholder for Unknown WF ${functionName}`);
				break;
		}
	});

	// Update Previous State for Next Iteration
	if (numOrderKeys > 0) {
		compiler.emit(Opcode.Move, regCurrentOrderKeys, regPrevOrderKeys, numOrderKeys, null, 0, `Update Prev Order Keys`);
	}

	// Advance Sorter Cursor and Loop
	compiler.emit(Opcode.VNext, winSortCursor, addrWindowLoopEnd, 0, null, 0, "Next Window Row");
	compiler.emit(Opcode.Goto, 0, addrWindowLoopStart, 0, null, 0, "Goto Next Window Calc");

	compiler.resolveAddress(addrWindowLoopEnd);
}

/**
 * Helper function to compute a frame boundary (start or end) using the new SeekRelative approach.
 * This generates VDBE code to position the cursor at the appropriate frame boundary.
 *
 * @param compiler The compiler instance
 * @param cursorIdx The window sorter cursor index
 * @param bound The frame bound definition (e.g., "CURRENT ROW", "3 PRECEDING")
 * @param isFrameStart Whether this is the start bound (true) or end bound (false)
 * @param boundValueReg Register with the bound value if available (for N PRECEDING/FOLLOWING)
 * @param partitionStartRowidReg Optional register with info about partition start
 * @param isRangeFrame Whether this is a RANGE frame (vs ROWS frame)
 * @param orderByInfo Optional information about ORDER BY keys (required for RANGE frames)
 * @param numPartitionKeys Number of partition keys
 * @param partitionKeyIndices Indices of partition keys in sorter
 * @param regOriginalPartKeys Register holding original partition keys
 * @returns The jump address to continue execution after boundary computation
 */
function compileFrameBoundary(
	compiler: Compiler,
	cursorIdx: number,
	bound: AST.WindowFrameBound,
	isFrameStart: boolean,
	boundValueReg?: number,
	partitionStartRowidReg?: number,
	isRangeFrame: boolean = false,
	orderByInfo?: {
		keyIndices: number[],
		directions: boolean[],
		collations?: (string | undefined)[]
	},
	numPartitionKeys?: number,
	partitionKeyIndices?: number[],
	regOriginalPartKeys?: number
): number {
	const addrContinue = compiler.allocateAddress();
	const savedPosReg = compiler.allocateMemoryCells(1);

	compileSaveCursorPosition(compiler, cursorIdx, savedPosReg);

	if (isRangeFrame) {
		if (!orderByInfo || orderByInfo.keyIndices.length === 0) {
			throw new SqliteError("RANGE frames require an ORDER BY clause.", StatusCode.ERROR);
		}

		// Registers for RANGE logic
		const regCurrentOrderByKeys = compiler.allocateMemoryCells(orderByInfo.keyIndices.length);
		const regTargetValue = compiler.allocateMemoryCells(1); // For N PRECEDING/FOLLOWING target
		const regIterOrderByKey = compiler.allocateMemoryCells(1); // Key of row during iteration
		const regIsDone = compiler.allocateMemoryCells(1); // Flag for loop termination
		const addrLoopStart = compiler.allocateAddress();
		const addrLoopExit = compiler.allocateAddress();
		const addrPeerLoopStart = compiler.allocateAddress();
		const addrPeerLoopExit = compiler.allocateAddress();

		// Get ORDER BY keys for the *original* current row
		for (let i = 0; i < orderByInfo.keyIndices.length; i++) {
			compiler.emit(Opcode.VColumn, cursorIdx, orderByInfo.keyIndices[i], regCurrentOrderByKeys + i, null, 0, "RANGE: Get current row ORDER BY key");
		}

		if (bound.type === 'preceding' || bound.type === 'following') {
			// --- RANGE N PRECEDING / N FOLLOWING ---
			if (orderByInfo.keyIndices.length !== 1) {
				throw new SqliteError("RANGE with offset requires exactly one ORDER BY clause", StatusCode.ERROR);
			}
			if (!boundValueReg) {
				throw new SqliteError(`Missing bound value register for RANGE ${bound.type}`, StatusCode.INTERNAL);
			}

			const regCurrentKey = regCurrentOrderByKeys; // Since only one key
			const regN = boundValueReg;
			const orderByColIdx = orderByInfo.keyIndices[0];

			// TODO: Check if ORDER BY key is numeric affinity? Assume it is for now.

			// Calculate target value: current_key - N (PRECEDING) or current_key + N (FOLLOWING)
			if (bound.type === 'preceding') {
				compiler.emit(Opcode.Subtract, regN, regCurrentKey, regTargetValue, null, 0, "RANGE: target = current_key - N");
			} else { // following
				compiler.emit(Opcode.Add, regN, regCurrentKey, regTargetValue, null, 0, "RANGE: target = current_key + N");
			}

			// Determine seek direction and comparison operator
			const seekOffset = (bound.type === 'preceding') ? -1 : 1;
			const comparisonOp = (bound.type === 'preceding') ? Opcode.Ge : Opcode.Le; // Find first row >= target (PRECEDING), last row <= target (FOLLOWING)
			const coll = orderByInfo.collations?.[0];
			const p4Coll = coll ? { type: 'coll' as const, name: coll } : null;

			// Loop: Seek, Compare, Check Peers
			compiler.emit(Opcode.Integer, 0, regIsDone, 0, null, 0, "RANGE: Init IsDone flag");
			compiler.resolveAddress(addrLoopStart);

			// Get current iteration row's ORDER BY key
			compiler.emit(Opcode.VColumn, cursorIdx, orderByColIdx, regIterOrderByKey, null, 0, "RANGE: Get iter ORDER BY key");

			// Compare iteration key with target value
			// If condition met (Ge for PRECEDING, Le for FOLLOWING), jump to peer check
			compiler.emit(comparisonOp, regIterOrderByKey, addrPeerLoopStart, regTargetValue, p4Coll, 0x01, "RANGE: Check if iter_key meets target");

			// Condition not met yet, try seeking further
			const tempOffsetReg = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Integer, seekOffset, tempOffsetReg, 0, null, 0, `RANGE: Set seek offset ${seekOffset}`);
			// Jump to loop exit if seek fails (hit partition boundary/EOF)
			compiler.emit(Opcode.SeekRelative, cursorIdx, addrLoopExit, tempOffsetReg, null, 1, "RANGE: Seek next row");

			// Seek succeeded, loop again
			compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "RANGE: Loop seek");

			// --- Peer Check --- (Entered when comparisonOp condition was met)
			compiler.resolveAddress(addrPeerLoopStart);
			// We are potentially on a row satisfying the boundary value.
			// Now, find the *first* peer (if PRECEDING) or *last* peer (if FOLLOWING).
			const peerSeekOffset = (bound.type === 'preceding') ? -1 : 1; // Seek backward for PRECEDING, forward for FOLLOWING
			const peerRegCurrentKey = compiler.allocateMemoryCells(1); // Key of the row *at the boundary*
			const peerRegNeighborKey = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.SCopy, regIterOrderByKey, peerRegCurrentKey, 0, null, 0, "RANGE: Store boundary key");

			// Loop to find edge of peer group
			const addrPeerLoopContinue = compiler.allocateAddress();
			compiler.resolveAddress(addrPeerLoopContinue);

			// *** ADD Partition Check at start of Peer Loop ***
			// *** Check if partition parameters are defined before using ***
			if (numPartitionKeys !== undefined && numPartitionKeys > 0 && partitionKeyIndices && regOriginalPartKeys !== undefined) {
				const regLoopPartKeys = compiler.allocateMemoryCells(numPartitionKeys);
				for (let i = 0; i < numPartitionKeys; i++) {
					compiler.emit(Opcode.VColumn, cursorIdx, partitionKeyIndices[i], regLoopPartKeys + i, null, 0, `RANGE PEER: Read Part Key ${i}`);
					// Compare with the *original* partition key. If different, exit peer loop.
					compiler.emit(Opcode.Ne, regLoopPartKeys + i, addrPeerLoopExit, regOriginalPartKeys + i, null, 0x01, `RANGE PEER: Check Part Key ${i} != Original`);
				}
			} // *** End check for defined parameters ***
			// *** End Partition Check ***

			// Save position before trying to seek to neighbor
			const peerSavedPosReg = compiler.allocateMemoryCells(1);

			const peerTempOffsetReg = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Integer, peerSeekOffset, peerTempOffsetReg, 0, null, 0, `RANGE: Set peer seek offset ${peerSeekOffset}`);
			// Jump to peer loop exit if seek fails
			compiler.emit(Opcode.SeekRelative, cursorIdx, addrPeerLoopExit, peerTempOffsetReg, null, 1, "RANGE: Seek to neighbor peer");

			// Seek succeeded, get neighbor's key
			compiler.emit(Opcode.VColumn, cursorIdx, orderByColIdx, peerRegNeighborKey, null, 0, "RANGE: Get neighbor ORDER BY key");

			// Compare neighbor key with the boundary key
			// If they are *different*, the previous row (peerSavedPosReg) was the edge peer.
			compiler.emit(Opcode.Ne, peerRegNeighborKey, addrPeerLoopExit, peerRegCurrentKey, p4Coll, 0x01, "RANGE: Check if neighbor is still a peer");

			// Neighbor is still a peer, continue loop
			compiler.emit(Opcode.Goto, 0, addrPeerLoopContinue, 0, null, 0, "RANGE: Continue seeking peers");

			// --- Exit Peer Loop ---
			compiler.resolveAddress(addrPeerLoopExit);
			// Restore position to the last valid peer found (before the non-peer or seek failure)
			compileRestoreCursorPosition(compiler, cursorIdx, peerSavedPosReg);
			compiler.emit(Opcode.Integer, 1, regIsDone, 0, null, 0, "RANGE: Flag boundary found"); // Mark as done
			compiler.emit(Opcode.Goto, 0, addrLoopExit, 0, null, 0, "RANGE: Boundary peer found, exit main loop");

			// --- Exit Main Loop ---
			compiler.resolveAddress(addrLoopExit);
			// If regIsDone is 0, the loop finished without finding a suitable boundary row.
			// What should the position be? Depends on PRECEDING/FOLLOWING.
			// PRECEDING: If not found, boundary is start of partition.
			// FOLLOWING: If not found, boundary is end of partition (EOF).
			const addrBoundarySet = compiler.allocateAddress();
			compiler.emit(Opcode.IfTrue, regIsDone, addrBoundarySet, 0, null, 0, "RANGE: Skip default boundary if found");

			if (bound.type === 'preceding') {
				if (partitionStartRowidReg) {
					compileRestoreCursorPosition(compiler, cursorIdx, partitionStartRowidReg);
				} else {
					compiler.emit(Opcode.Rewind, cursorIdx, 0, 0, null, 0, "RANGE PRECEDING: Rewind (no boundary found)");
				}
			} else { // following
				// Seek to EOF (VNext loop)
				const addrEofLoop = compiler.allocateAddress();
				const addrEofDone = compiler.allocateAddress();
				compiler.resolveAddress(addrEofLoop);
				compiler.emit(Opcode.VNext, cursorIdx, addrEofDone, 0, null, 0, `RANGE FOLLOWING: Seek EOF`);
				compiler.emit(Opcode.Goto, 0, addrEofLoop, 0, null, 0);
				compiler.resolveAddress(addrEofDone);
			}
			compiler.resolveAddress(addrBoundarySet);
			compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "RANGE N PRECEDING/FOLLOWING: Jump to continue");

		} else if (bound.type === 'currentRow') {
			// --- RANGE CURRENT ROW --- (Peer finding)
			const regPeerOrderByKeys = compiler.allocateMemoryCells(orderByInfo.keyIndices.length);
			const addrPeerLoop = compiler.allocateAddress();
			const addrEndOfPeers = compiler.allocateAddress();
			const seekOffset = isFrameStart ? -1 : 1; // Seek backwards for start, forwards for end
			const jumpOnFail = 1;

			compiler.resolveAddress(addrPeerLoop);
			const tempOffsetReg = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Integer, seekOffset, tempOffsetReg, 0, null, 0, `RANGE CUR ROW: Set seek offset ${seekOffset}`);
			compiler.emit(Opcode.SeekRelative, cursorIdx, addrEndOfPeers, tempOffsetReg, null, jumpOnFail, "RANGE CUR ROW: Seek one step for peers");

			// Check if the new row is a peer
			for (let i = 0; i < orderByInfo.keyIndices.length; i++) {
				compiler.emit(Opcode.VColumn, cursorIdx, orderByInfo.keyIndices[i], regPeerOrderByKeys + i, null, 0, "RANGE CUR ROW: Get peer ORDER BY key");
				const coll = orderByInfo.collations?.[i];
				const p4Coll = coll ? { type: 'coll' as const, name: coll } : null;
				compiler.emit(Opcode.Ne, regCurrentOrderByKeys + i, addrEndOfPeers, regPeerOrderByKeys + i, p4Coll, 0x01, "RANGE CUR ROW: Check if peer keys differ");
			}
			compiler.emit(Opcode.Goto, 0, addrPeerLoop, 0, null, 0, "RANGE CUR ROW: Continue seeking peers");

			compiler.resolveAddress(addrEndOfPeers);
			if (isFrameStart) {
				// Step forward onto the first peer
				const tempOffsetRegFwd = compiler.allocateMemoryCells(1);
				compiler.emit(Opcode.Integer, 1, tempOffsetRegFwd, 0, null, 0, "RANGE CUR ROW: Set seek offset 1");
				compiler.emit(Opcode.SeekRelative, cursorIdx, addrContinue, tempOffsetRegFwd, null, 1, "RANGE CUR ROW: Step forward onto first peer"); // Jump on fail is okay
			}
			// For end bound, we are already on the last peer
			compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "RANGE CURRENT ROW: Boundary found");

		} else if (bound.type === 'unboundedPreceding' && isFrameStart) {
			// Fall through to ROWS logic below
		} else if (bound.type === 'unboundedFollowing' && !isFrameStart) {
			// Fall through to ROWS logic below
		} else {
			// Should not happen if previous checks worked
			throw new SqliteError(`Unhandled RANGE bound type: ${bound.type}`, StatusCode.INTERNAL);
		}
	} // --- End of isRangeFrame block ---

	// --- ROWS Frame Logic OR Fallback for UNBOUNDED RANGE ---
	switch (bound.type) {
		case 'unboundedPreceding':
			if (partitionStartRowidReg) {
				compileRestoreCursorPosition(compiler, cursorIdx, partitionStartRowidReg);
			} else {
				compiler.emit(Opcode.Rewind, cursorIdx, 0, 0, null, 0, "Rewind to start (UNBOUNDED PRECEDING)");
			}
			compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "UNBOUNDED PRECEDING: Jump to continue");
			break;
		case 'unboundedFollowing':
			const addrEofLoop = compiler.allocateAddress();
			const addrEofDone = compiler.allocateAddress();
			compiler.resolveAddress(addrEofLoop);
			compiler.emit(Opcode.VNext, cursorIdx, addrEofDone, 0, null, 0, `Seek EOF (UNBOUNDED FOLLOWING)`);
			compiler.emit(Opcode.Goto, 0, addrEofLoop, 0, null, 0);
			compiler.resolveAddress(addrEofDone);
			compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "UNBOUNDED FOLLOWING: Jump to continue");
			break;
		case 'currentRow':
			if (isRangeFrame) {
				// Already handled above
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "RANGE CURRENT ROW: Already processed");
			} else {
				// ROWS CURRENT ROW: Restore position
				compileRestoreCursorPosition(compiler, cursorIdx, savedPosReg);
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "ROWS CURRENT ROW: Jump to continue after restore");
			}
			break;
		case 'preceding':
			if (isRangeFrame) throw new Error("RANGE PRECEDING N NYI - Should have been caught earlier");
			if (!boundValueReg) throw new SqliteError("Missing bound value register for PRECEDING", StatusCode.INTERNAL);
			const negatedOffsetReg = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Negative, boundValueReg, negatedOffsetReg, 0, null, 0, "Negate PRECEDING offset");
			const addrPrecedingSeekFailed = compiler.allocateAddress();
			compiler.emit(Opcode.SeekRelative, cursorIdx, addrPrecedingSeekFailed, negatedOffsetReg, null, 1, `Seek PRECEDING (jump on fail)`);
			compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "PRECEDING: Seek successful");
			compiler.resolveAddress(addrPrecedingSeekFailed);
			if (partitionStartRowidReg) {
				compileRestoreCursorPosition(compiler, cursorIdx, partitionStartRowidReg);
			} else {
				compiler.emit(Opcode.Rewind, cursorIdx, 0, 0, null, 0, "Rewind (PRECEDING bound too large)");
			}
			compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "PRECEDING: Jump to continue after handling fail");
			break;
		case 'following':
			if (isRangeFrame) throw new Error("RANGE FOLLOWING N NYI - Should have been caught earlier");
			if (!boundValueReg) throw new SqliteError("Missing bound value register for FOLLOWING", StatusCode.INTERNAL);
			const addrFollowingSeekFailed = compiler.allocateAddress();
			compiler.emit(Opcode.SeekRelative, cursorIdx, addrFollowingSeekFailed, boundValueReg, null, 1, `Seek FOLLOWING (jump on fail)`);
			compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "FOLLOWING: Seek successful");
			compiler.resolveAddress(addrFollowingSeekFailed);
			compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "FOLLOWING: Jump to continue after EOF");
			break;
		default:
			throw new SqliteError(`Unsupported frame bound type: ${(bound as any).type}`, StatusCode.INTERNAL);
	}

	compiler.resolveAddress(addrContinue);
	// The function used to return addrContinue, but maybe void is better?
	// Let's keep returning it for now in case it's useful downstream.
	return addrContinue;
}

/**
 * Helper function to calculate an aggregate function over a window frame.
 * Uses cursor navigation to iterate over the frame, applying aggregate steps.
 *
 * @param compiler The compiler instance
 * @param cursor The cursor index
 * @param funcName The aggregate function name
 * @param winExpr The original window function expression (for args)
 * @param resultReg The register to store the result in
 * @param frameDef The frame definition
 * @param startBoundReg Register for start bound value (if needed)
 * @param endBoundReg Register for end bound value (if needed)
 * @param partStartRowidReg Register for partition start rowid
 * @param numPartitionKeys Number of partition keys
 * @param partitionKeyIndices Indices of partition keys in sorter
 * @param regOriginalPartKeys Register holding original partition keys
 * @param orderByInfo Optional ORDER BY info (needed for RANGE)
 * @param sorterInfo Full WindowSorterInfo for column mapping
 */
function compileFrameAggregate(
	compiler: Compiler,
	cursor: number,
	funcName: string,
	winExpr: AST.WindowFunctionExpr, // Pass the expression
	resultReg: number,
	frameDef: AST.WindowFrame,
	startBoundReg: number,
	endBoundReg: number,
	partStartRowidReg: number,
	numPartitionKeys: number,
	partitionKeyIndices: number[],
	regOriginalPartKeys: number,
	orderByInfo: { keyIndices: number[]; directions: boolean[]; collations?: (string | undefined)[] } | undefined,
	sorterInfo: WindowSorterInfo // Need sorter info for arg mapping
): void {
	// --- Basic Setup ---
	const savedPosReg = compiler.allocateMemoryCells(1);
	const argReg = compiler.allocateMemoryCells(1);
	const accReg = compiler.allocateMemoryCells(1);
	let avgCountReg = 0; // For AVG
	const regOne = compiler.allocateMemoryCells(1);
	compiler.emit(Opcode.Integer, 1, regOne, 0, null, 0, "Load constant 1");
	// *** Declare and Initialize regZero here ***
	const regZero = compiler.allocateMemoryCells(1);
	compiler.emit(Opcode.Integer, 0, regZero, 0, null, 0, "Load 0");

	// Get argument column index from sorter info
	const argExpr = winExpr.function.args?.[0];
	const argColIndex = argExpr
		? sorterInfo.exprToSorterIndex.get(expressionToString(argExpr)) ?? -1
		: -1; // -1 if no args (e.g., COUNT(*))

	// 1. Save original cursor position
	compileSaveCursorPosition(compiler, cursor, savedPosReg);

	// 2. Initialize accumulator
	switch (funcName.toLowerCase()) {
		case 'count':
			compiler.emit(Opcode.Integer, 0, accReg, 0, null, 0, "Initialize COUNT to 0");
			break;
		case 'sum':
			compiler.emit(Opcode.Integer, 0, accReg, 0, null, 0, "Initialize SUM to 0");
			break;
		case 'avg':
			avgCountReg = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Integer, 0, accReg, 0, null, 0, "Initialize AVG_SUM to 0");
			compiler.emit(Opcode.Integer, 0, avgCountReg, 0, null, 0, "Initialize AVG_COUNT to 0");
			break;
		case 'min':
		case 'max':
			compiler.emit(Opcode.Null, 0, accReg, 0, null, 0, "Initialize MIN/MAX to NULL");
			break;
		default:
			// TODO: Handle UDFs or throw error
			compiler.emit(Opcode.Null, 0, accReg, 0, null, 0, `Init ${funcName} accumulator`);
	}

	// --- Frame Calculation & Iteration ---
	if (frameDef.type === 'rows') {
		// --- ROWS Frame Logic ---
		const regStartOffset = compiler.allocateMemoryCells(1);
		const regEndOffset = compiler.allocateMemoryCells(1);
		const regSteps = compiler.allocateMemoryCells(1);
		const regMaxSteps = compiler.allocateMemoryCells(1);
		const regCurrentPartKeys = compiler.allocateMemoryCells(numPartitionKeys > 0 ? numPartitionKeys : 1);
		const addrLoopStart = compiler.allocateAddress();
		const addrLoopEnd = compiler.allocateAddress();
		const addrFrameSetupDone = compiler.allocateAddress();

		// Calculate relative start offset
		compileBoundToRelativeOffset(compiler, frameDef.start, startBoundReg, regStartOffset, true);
		// Calculate relative end offset
		compileBoundToRelativeOffset(compiler, frameDef.end ?? { type: 'currentRow' }, endBoundReg, regEndOffset, false);

		// Calculate max steps (endOffset - startOffset + 1)
		compiler.emit(Opcode.Subtract, regStartOffset, regEndOffset, regMaxSteps, null, 0, "endOffset - startOffset");
		compiler.emit(Opcode.Add, regMaxSteps, regOne, regMaxSteps, null, 0, "+ 1 for step count");

		// Check if frame is empty (maxSteps <= 0)
		compiler.emit(Opcode.Le, regMaxSteps, addrLoopEnd, regZero, null, 0, "If maxSteps <= 0, skip loop");

		// Seek to frame start
		const addrSeekFailed = compiler.allocateAddress();
		compiler.emit(Opcode.SeekRelative, cursor, addrSeekFailed, regStartOffset, null, 1,
			`ROWS: Seek to frame start (offset: ${regStartOffset})`);
		compiler.emit(Opcode.Goto, 0, addrFrameSetupDone, 0, null, 0, "ROWS: Seek start success");
		compiler.resolveAddress(addrSeekFailed);
		// Seek failed (likely hit partition boundary before finding start)
		// Which rows should be included? If start is PRECEDING, maybe some rows are included.
		// If start is FOLLOWING, the frame is empty.
		// Let's assume for now seek failure means empty frame for simplicity.
		compiler.emit(Opcode.Integer, 0, regMaxSteps, 0, null, 0, "ROWS: Set maxSteps=0 on seek fail");
		compiler.emit(Opcode.Goto, 0, addrLoopEnd, 0, null, 0, "ROWS: Jump to end on seek fail");

		compiler.resolveAddress(addrFrameSetupDone);
		// Initialize step counter
		compiler.emit(Opcode.Integer, 0, regSteps, 0, null, 0, "ROWS: Init step counter");

		// -- Loop Start --
		compiler.resolveAddress(addrLoopStart);

		// Check partition boundary
		if (numPartitionKeys > 0) {
			for (let i = 0; i < numPartitionKeys; i++) {
				compiler.emit(Opcode.VColumn, cursor, partitionKeyIndices[i], regCurrentPartKeys + i, null, 0, `ROWS: Read Part Key ${i}`);
				compiler.emit(Opcode.Ne, regCurrentPartKeys + i, addrLoopEnd, regOriginalPartKeys + i, null, 0x01, `ROWS: Check Part Key ${i} != Original`);
			}
		}

		// Check step count
		compiler.emit(Opcode.Ge, regSteps, addrLoopEnd, regMaxSteps, null, 0, "ROWS: Check if steps >= maxSteps");

		// Perform aggregate step
		// ... (duplicate of the aggregate step logic from previous version) ...
		if (argColIndex >= 0) {
			compiler.emit(Opcode.VColumn, cursor, argColIndex, argReg, null, 0, "ROWS: Get value");
		} else if (funcName.toLowerCase() === 'count') {
			compiler.emit(Opcode.Integer, 1, argReg, 0, null, 0, "ROWS: COUNT(*)");
		}
		switch (funcName.toLowerCase()) {
			case 'count':
				if (argColIndex >= 0) compiler.emit(Opcode.IfNull, argReg, addrLoopStart + 2, 0, null, 0, "Skip null");
				compiler.emit(Opcode.Add, accReg, regOne, accReg, null, 0, "Inc COUNT");
				break;
			case 'sum':
			case 'avg':
				compiler.emit(Opcode.IfNull, argReg, addrLoopStart + 2, 0, null, 0, "Skip null");
				compiler.emit(Opcode.Add, accReg, argReg, accReg, null, 0, "Add SUM");
				if (funcName.toLowerCase() === 'avg') compiler.emit(Opcode.Add, avgCountReg, regOne, avgCountReg, null, 0, "Inc AVG count");
				break;
			case 'min':
				const skipMin = compiler.allocateAddress();
				compiler.emit(Opcode.IfNull, argReg, skipMin, 0, null, 0);
				const updateMin = compiler.allocateAddress();
				compiler.emit(Opcode.IfNull, accReg, updateMin, 0, null, 0);
				compiler.emit(Opcode.Le, argReg, skipMin, accReg, null, 0);
				compiler.resolveAddress(updateMin);
				compiler.emit(Opcode.SCopy, argReg, accReg, 0, null, 0);
				compiler.resolveAddress(skipMin);
				break;
			case 'max':
				const skipMax = compiler.allocateAddress();
				compiler.emit(Opcode.IfNull, argReg, skipMax, 0, null, 0);
				const updateMax = compiler.allocateAddress();
				compiler.emit(Opcode.IfNull, accReg, updateMax, 0, null, 0);
				compiler.emit(Opcode.Ge, argReg, skipMax, accReg, null, 0);
				compiler.resolveAddress(updateMax);
				compiler.emit(Opcode.SCopy, argReg, accReg, 0, null, 0);
				compiler.resolveAddress(skipMax);
				break;
		}

		// Increment step counter
		compiler.emit(Opcode.Add, regSteps, regOne, regSteps, null, 0, "ROWS: Increment step counter");

		// Advance cursor
		compiler.emit(Opcode.VNext, cursor, addrLoopEnd, 0, null, 0, "ROWS: Advance to next frame row"); // Jump to LoopEnd on EOF
		compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "ROWS: Loop to next frame row");

		// -- Loop End --
		compiler.resolveAddress(addrLoopEnd);

	} else { // --- RANGE Frame Logic ---
		// Assumes compileFrameBoundary correctly positioned the cursor at the frame START for RANGE.
		// We need to iterate until the current row's ORDER BY key is no longer
		// equal to the ORDER BY key of the frame END boundary row.
		const regEndBoundaryRowid = compiler.allocateMemoryCells(1);
		const regCurrentRowid = compiler.allocateMemoryCells(1);
		const regCurrentOrderByKeys = compiler.allocateMemoryCells(orderByInfo ? orderByInfo.keyIndices.length : 1);
		const regEndBoundaryKeys = compiler.allocateMemoryCells(orderByInfo ? orderByInfo.keyIndices.length : 1);
		const addrRangeLoopStart = compiler.allocateAddress();
		const addrRangeLoopEnd = compiler.allocateAddress();

		// First, find the *end* boundary and save its Rowid and ORDER BY keys
		compileSaveCursorPosition(compiler, cursor, savedPosReg); // Save start position
		const endBound = frameDef.end ?? { type: 'currentRow' };
		const addrEndBoundaryFound = compileFrameBoundary(
			compiler, cursor, endBound, false, // Find END boundary
			endBoundReg, partStartRowidReg,
			true, // isRangeFrame = true
			orderByInfo, numPartitionKeys, partitionKeyIndices, regOriginalPartKeys
		);
		compiler.resolveAddress(addrEndBoundaryFound);
		// Save the rowid and order by keys of the end boundary row
		compiler.emit(Opcode.VRowid, cursor, regEndBoundaryRowid, 0, null, 0, "RANGE: Save end boundary rowid");
		if (orderByInfo) {
			for (let i = 0; i < orderByInfo.keyIndices.length; i++) {
				compiler.emit(Opcode.VColumn, cursor, orderByInfo.keyIndices[i], regEndBoundaryKeys + i, null, 0, "RANGE: Save end boundary ORDER BY key");
			}
		}
		// Restore cursor position back to the frame START
		compileRestoreCursorPosition(compiler, cursor, savedPosReg, partStartRowidReg);

		// --- Start RANGE Aggregation Loop ---
		compiler.resolveAddress(addrRangeLoopStart);

		// Check partition boundary first
		if (numPartitionKeys > 0) {
			const regLoopPartKeys = compiler.allocateMemoryCells(numPartitionKeys);
			for (let i = 0; i < numPartitionKeys; i++) {
				compiler.emit(Opcode.VColumn, cursor, partitionKeyIndices[i], regLoopPartKeys + i, null, 0, `RANGE: Read Part Key ${i}`);
				compiler.emit(Opcode.Ne, regLoopPartKeys + i, addrRangeLoopEnd, regOriginalPartKeys + i, null, 0x01, `RANGE: Check Part Key ${i} != Original`);
			}
		}

		// Check if current row is past the end boundary (using ORDER BY keys)
		if (orderByInfo) {
			const addrKeysLeEnd = compiler.allocateAddress();
			let isPastEnd = false; // Flag if any key comparison indicates we are past the end
			for (let i = 0; i < orderByInfo.keyIndices.length; i++) {
				// Get current row's key for comparison
				compiler.emit(Opcode.VColumn, cursor, orderByInfo.keyIndices[i], regCurrentOrderByKeys + i, null, 0, "RANGE Agg: Get current ORDER BY key");

				const coll = orderByInfo.collations?.[i];
				const p4Coll = coll ? { type: 'coll' as const, name: coll } : null;

				// Determine comparison opcode based on ORDER BY direction
				// We want to EXIT the loop if CURRENT > END (for ASC) or CURRENT < END (for DESC)
				const comparisonOp = orderByInfo.directions[i] ? Opcode.Lt : Opcode.Gt;

				// Perform the comparison. If true (current is past end), jump to loop end.
				compiler.emit(comparisonOp, regCurrentOrderByKeys + i, addrRangeLoopEnd, regEndBoundaryKeys + i, p4Coll, 0x01,
					`RANGE Agg: Check if current key past end key (col ${i})`);
			}
			// If we fall through, the current row is still within the frame boundaries (or exactly at the end)
		}
		// *** End End-of-Frame Check ***

		// Perform aggregate step (same logic as ROWS)
		// ... (copy aggregate step logic here) ...
		if (argColIndex >= 0) {
			compiler.emit(Opcode.VColumn, cursor, argColIndex, argReg, null, 0, "RANGE: Get value");
		} else if (funcName.toLowerCase() === 'count') {
			compiler.emit(Opcode.Integer, 1, argReg, 0, null, 0, "RANGE: COUNT(*)");
		}
		switch (funcName.toLowerCase()) {
			case 'count':
				if (argColIndex >= 0) compiler.emit(Opcode.IfNull, argReg, addrRangeLoopStart + 2, 0, null, 0, "Skip null"); // Adjust jump?
				compiler.emit(Opcode.Add, accReg, regOne, accReg, null, 0, "Inc COUNT");
				break;
			case 'sum':
			case 'avg':
				compiler.emit(Opcode.IfNull, argReg, addrRangeLoopStart + 2, 0, null, 0, "Skip null");
				compiler.emit(Opcode.Add, accReg, argReg, accReg, null, 0, "Add SUM");
				if (funcName.toLowerCase() === 'avg') compiler.emit(Opcode.Add, avgCountReg, regOne, avgCountReg, null, 0, "Inc AVG count");
				break;
			case 'min':
				const skipMinR = compiler.allocateAddress(); compiler.emit(Opcode.IfNull, argReg, skipMinR, 0, null, 0);
				const updateMinR = compiler.allocateAddress(); compiler.emit(Opcode.IfNull, accReg, updateMinR, 0, null, 0);
				compiler.emit(Opcode.Le, argReg, skipMinR, accReg, null, 0); compiler.resolveAddress(updateMinR);
				compiler.emit(Opcode.SCopy, argReg, accReg, 0, null, 0); compiler.resolveAddress(skipMinR);
				break;
			case 'max':
				const skipMaxR = compiler.allocateAddress(); compiler.emit(Opcode.IfNull, argReg, skipMaxR, 0, null, 0);
				const updateMaxR = compiler.allocateAddress(); compiler.emit(Opcode.IfNull, accReg, updateMaxR, 0, null, 0);
				compiler.emit(Opcode.Ge, argReg, skipMaxR, accReg, null, 0); compiler.resolveAddress(updateMaxR);
				compiler.emit(Opcode.SCopy, argReg, accReg, 0, null, 0); compiler.resolveAddress(skipMaxR);
				break;
		}

		// Advance cursor
		compiler.emit(Opcode.VNext, cursor, addrRangeLoopEnd, 0, null, 0, "RANGE: Advance to next frame row"); // Jump to LoopEnd on EOF
		compiler.emit(Opcode.Goto, 0, addrRangeLoopStart, 0, null, 0, "RANGE: Loop to next frame row");

		// -- End RANGE Aggregation Loop --
		compiler.resolveAddress(addrRangeLoopEnd);
	}

	// --- Finalize & Restore ---
	// Handle AVG final calculation
	if (funcName.toLowerCase() === 'avg') {
		const addrAvgNull = compiler.allocateAddress();
		const regZero = compiler.allocateMemoryCells(1);
		compiler.emit(Opcode.Integer, 0, regZero, 0, null, 0, "Load 0 for AVG check");
		// Check if count is zero
		compiler.emit(Opcode.Eq, avgCountReg, addrAvgNull, regZero, null, 0, "AVG: Check if count is zero");
		// Count > 0, perform division
		compiler.emit(Opcode.Divide, avgCountReg, accReg, resultReg, null, 0, "AVG: sum / count");
		const addrAvgDone = compiler.allocateAddress();
		compiler.emit(Opcode.Goto, 0, addrAvgDone, 0, null, 0, "AVG: Skip null result");
		compiler.resolveAddress(addrAvgNull);
		// Count is zero, result is NULL
		compiler.emit(Opcode.Null, 0, resultReg, 0, null, 0, "AVG: Result is NULL (count=0)");
		compiler.resolveAddress(addrAvgDone);
	} else {
		// For other aggregates, just copy the accumulator
		compiler.emit(Opcode.SCopy, accReg, resultReg, 0, null, 0, `Set final ${funcName} result`);
	}

	// Restore original cursor position
	compileRestoreCursorPosition(compiler, cursor, savedPosReg, partStartRowidReg);
}

/** Helper to convert frame bound to relative offset register for ROWS */
function compileBoundToRelativeOffset(
	compiler: Compiler,
	bound: AST.WindowFrameBound,
	boundValueReg: number,
	resultOffsetReg: number,
	isStartBound: boolean
): void {
	switch (bound.type) {
		case 'unboundedPreceding':
			// How to represent unbounded? Use a very large negative number?
			// Or maybe handle it outside this offset calculation.
			// For offset calculation, let's treat it as max negative seek.
			compiler.emit(Opcode.Integer, -2147483648, resultOffsetReg, 0, null, 0, "Offset: UNBOUNDED PRECEDING"); // Placeholder large negative
			break;
		case 'preceding':
			// Value is in boundValueReg, negate it
			compiler.emit(Opcode.Negative, boundValueReg, resultOffsetReg, 0, null, 0, "Offset: PRECEDING N");
			break;
		case 'currentRow':
			compiler.emit(Opcode.Integer, 0, resultOffsetReg, 0, null, 0, "Offset: CURRENT ROW (0)");
			break;
		case 'following':
			// Value is already positive
			compiler.emit(Opcode.SCopy, boundValueReg, resultOffsetReg, 0, null, 0, "Offset: FOLLOWING N");
			break;
		case 'unboundedFollowing':
			// Use a very large positive number?
			compiler.emit(Opcode.Integer, 2147483647, resultOffsetReg, 0, null, 0, "Offset: UNBOUNDED FOLLOWING"); // Placeholder large positive
			break;
	}
}

/**
 * Emits VDBE code to save the current rowid of a cursor.
 * @param compiler The compiler instance.
 * @param cursorIdx The index of the cursor.
 * @param regSavedRowid The register where the rowid should be saved.
 */
function compileSaveCursorPosition(
	compiler: Compiler,
	cursorIdx: number,
	regSavedRowid: number
): void {
	// Check if cursor is valid before getting rowid?
	// Assume cursor is valid when this is called.
	compiler.emit(Opcode.VRowid, cursorIdx, regSavedRowid, 0, null, 0, `Save cursor ${cursorIdx} rowid`);
}

/**
 * Emits VDBE code to restore a cursor's position to a previously saved rowid.
 * This uses a potentially inefficient rewind-and-scan approach.
 * Assumes the target rowid is still present in the cursor's result set.
 *
 * @param compiler The compiler instance.
 * @param cursorIdx The index of the cursor.
 * @param regSavedRowid The register containing the target rowid to seek to.
 * @param regPartitionStartRowid Optional: Register with the rowid of the partition start. If provided, rewinds only to partition start.
 */
function compileRestoreCursorPosition(
	compiler: Compiler,
	cursorIdx: number,
	regSavedRowid: number,
	regPartitionStartRowid?: number
): void {
	const addrRestoreFailed = compiler.allocateAddress(); // Jump here if SeekRowid fails
	const addrRestoreDone = compiler.allocateAddress();

	// Try seeking directly to the rowid
	// P5=1 jumps to addrRestoreFailed if SeekRowid returns false (not found or not supported)
	compiler.emit(Opcode.SeekRowid, cursorIdx, addrRestoreFailed, regSavedRowid, null, 1,
		`Restore Pos: Attempt SeekRowid to restore cursor ${cursorIdx}`);

	// SeekRowid succeeded
	compiler.emit(Opcode.Goto, 0, addrRestoreDone, 0, null, 0, "Restore Pos: SeekRowid successful");

	// SeekRowid failed (or not supported), fall back to scan (or just warn/error)
	compiler.resolveAddress(addrRestoreFailed);
	// For now, just issue a warning. A fallback scan could be added here if needed.
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `WARN: Cursor ${cursorIdx} position restore failed (SeekRowid failed or not supported)`);
	// NOTE: If SeekRowid fails because the row *doesn't exist*, the cursor state might be EOF.
	// If it fails because xSeekToRowid isn't implemented, the state is also likely EOF.
	// We might need to explicitly handle the state or re-seek to the *original* saved position
	// if the operation that moved the cursor needs atomicity.
	// For current window functions, leaving it at EOF/fail state might be acceptable.

	// Restore successful or handled failure
	compiler.resolveAddress(addrRestoreDone);
}
