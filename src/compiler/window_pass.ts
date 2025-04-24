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

	if (frameDefinition) {
		regFrameStartPtr = compiler.allocateMemoryCells(1);
		regFrameEndPtr = compiler.allocateMemoryCells(1);
		regCurrentRowPtr = compiler.allocateMemoryCells(1);
		regPartitionStartPtr = compiler.allocateMemoryCells(1);
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
					// Assume default frame (e.g., RANGE UNBOUNDED PRECEDING) - calculation still needs frame boundaries
					// For now, just placeholder
					compiler.emit(Opcode.Null, 0, resultReg, 1, null, 0, `Placeholder ${functionName} (Default Frame)`);
				} else {
					// Placeholder: Aggregate over frame
					// Need opcode like AggFrame(cursor, func, frame_start_ptr, frame_end_ptr, value_col_idx, result_reg)
					const argColIndex = winExpr.function.args.length > 0 ?
						windowSorterInfo.exprToSorterIndex.get(expressionToString(winExpr.function.args[0])) : -1; // Get sorter index for arg
					const funcDef = compiler.db._findFunction(functionName, winExpr.function.args.length);
					if (!funcDef) throw new Error(`Window function ${functionName} not found`);

					const p5Info: P5AggFrameInfo = {
						type: 'aggframeinfo',
						funcDef: funcDef,
						argIdx: argColIndex ?? -1,
						nArgs: winExpr.function.args.length
					};
					// compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `AggFrame ${winSortCursor} func ${functionName} start ${regFrameStartPtr} end ${regFrameEndPtr} arg_idx ${argColIndex} -> ${resultReg}`);
					compiler.emit(Opcode.AggFrame, winSortCursor, resultReg, regFrameStartPtr, p5Info, regFrameEndPtr, `AggFrame ${functionName} -> ${resultReg}`); // Correct: p4=p5Info, p5=frameEndPtrReg
					// compiler.emit(Opcode.Null, 0, resultReg, 1, null, 0, `Placeholder ${functionName}`); // Remove placeholder null
				}
				break;

			case 'first_value':
			case 'last_value':
				if (!frameDefinition) {
					compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `WARN: Default frame assumed for ${functionName}`);
					compiler.emit(Opcode.Null, 0, resultReg, 1, null, 0, `Placeholder ${functionName} (Default Frame)`);
				} else {
					const argColIndex = windowSorterInfo.exprToSorterIndex.get(expressionToString(winExpr.function.args[0]));
					if (argColIndex === undefined) throw new Error(`${functionName} argument expression not found in sorter: ${expressionToString(winExpr.function.args[0])}`);
					const targetPtrReg = (functionName === 'first_value') ? regFrameStartPtr : regFrameEndPtr;
					// Placeholder: Get value from specific row in frame
					// Need opcode like FrameValue(cursor, ptr_reg, value_col_idx, result_reg)
					// compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `FrameValue ${winSortCursor} ptr ${targetPtrReg} arg_idx ${argColIndex} -> ${resultReg}`);
					compiler.emit(Opcode.FrameValue, winSortCursor, resultReg, targetPtrReg, argColIndex, 0, `FrameValue ${functionName} -> ${resultReg}`); // p4=argColIndex, p5=0
					// compiler.emit(Opcode.Null, 0, resultReg, 1, null, 0, `Placeholder ${functionName}`); // Remove placeholder null
				}
				break;

			case 'nth_value':
				// Needs frame and Nth argument handling
				compiler.emit(Opcode.Null, 0, resultReg, 1, null, 0, `Placeholder ${functionName}`);
				break;

			case 'lag':
			case 'lead': {
				// LAG/LEAD ignore the frame clause and use offset relative to current row within partition
				const args = winExpr.function.args;
				const argExpr = args[0]; // Required argument
				const offsetExpr = args.length > 1 ? args[1] : null; // Optional offset
				const defaultExpr = args.length > 2 ? args[2] : null; // Optional default

				// Get sorter index for the main argument
				const argColIndex = windowSorterInfo.exprToSorterIndex.get(expressionToString(argExpr));
				if (argColIndex === undefined) {
					throw new Error(`${functionName} argument expression not found in sorter: ${expressionToString(argExpr)}`);
				}

				// Allocate registers and compile offset/default expressions
				let regOffset: number;
				if (offsetExpr) {
					regOffset = compiler.allocateMemoryCells(1);
					compiler.compileExpression(offsetExpr, regOffset);
					// TODO: Add check to ensure offset is a positive integer?
				} else {
					// Default offset is 1
					regOffset = compiler.allocateMemoryCells(1);
					compiler.emit(Opcode.Integer, 1, regOffset, 0, null, 0, "Default offset 1");
				}

				let regDefault: number;
				if (defaultExpr) {
					regDefault = compiler.allocateMemoryCells(1);
					compiler.compileExpression(defaultExpr, regDefault);
				} else {
					// Default default is NULL
					regDefault = compiler.allocateMemoryCells(1);
					compiler.emit(Opcode.Null, 0, regDefault, 0, null, 0, "Default default NULL");
				}

				// Emit the specific opcode
				const opcode = (functionName === 'lag') ? Opcode.Lag : Opcode.Lead;
				const lagLeadInfo: P4LagLeadInfo = {
					type: 'lagleadinfo',
					currRowPtrReg: regCurrentRowPtr, // Pass the current row pointer register
					argColIdx: argColIndex
				};
				//compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `Placeholder: Get ${functionName} value relative to current row -> reg ${resultReg}`);
				// compiler.emit(opcode, winSortCursor, resultReg, regOffset, regDefault, argColIndex, `${functionName} -> ${resultReg}`); // Old call
				compiler.emit(opcode, winSortCursor, resultReg, regOffset, lagLeadInfo, regDefault, `${functionName} -> ${resultReg}`); // Correct: p4=info, p5=defaultReg
				// compiler.emit(Opcode.Null, 0, resultReg, 1, null, 0, `Placeholder ${functionName}`); // Remove placeholder
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
