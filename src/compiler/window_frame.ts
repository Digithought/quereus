import { Compiler } from './compiler.js';
import type { WindowSorterInfo } from './window.js';
import { Opcode } from '../vdbe/opcodes.js';
import { SqliteError } from '../common/errors.js';
import type * as AST from '../parser/ast.js';
import { expressionToString } from '../util/ddl-stringify.js';
import type { P4FuncDef } from '../vdbe/instruction.js';
import { StatusCode } from '../common/types.js';

/**
 * Helper function to compute a frame boundary (start or end).
 * This generates VDBE code to position the cursor at the appropriate frame boundary.
 * It assumes the original position has already been saved by the caller.
 *
 * @param compiler The compiler instance
 * @param cursorIdx The window sorter cursor index
 * @param bound The frame bound definition (e.g., "CURRENT ROW", "3 PRECEDING")
 * @param isFrameStart Whether this is the start bound (true) or end bound (false)
 * @param regOriginalRowid Register holding the rowid of the row for which the frame is being calculated
 * @param regBoundaryRowid Output register: This register will hold the rowid of the calculated boundary row.
 * @param boundValueReg Optional register with the bound value (for N PRECEDING/FOLLOWING)
 * @param partitionStartRowidReg Optional register with info about partition start
 * @param isRangeFrame Whether this is a RANGE frame (vs ROWS frame)
 * @param orderByInfo Optional information about ORDER BY keys (required for RANGE frames)
 * @param numPartitionKeys Number of partition keys
 * @param partitionKeyIndices Indices of partition keys in sorter
 * @param regOriginalPartKeys Register holding original partition keys for the *current* row
 * @returns The jump address to continue execution after boundary computation is *attempted*. The cursor may be left invalid if the boundary is outside the partition.
 */
export function compileFrameBoundary(
	compiler: Compiler,
	cursorIdx: number,
	bound: AST.WindowFrameBound,
	isFrameStart: boolean,
	regOriginalRowid: number, // Added: Original row position
	regBoundaryRowid: number, // Added: Output register for boundary rowid
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
	const addrContinue = compiler.allocateAddress(); // Address to jump to when done
	const addrSeekFailed = compiler.allocateAddress(); // Address if a seek goes out of bounds
	const addrRewindFailed = compiler.allocateAddress(); // Address if rewind fails (empty partition?)

	// Initialize boundary rowid to null
	compiler.emit(Opcode.Null, 0, regBoundaryRowid, 0, null, 0, `Init boundary rowid for ${isFrameStart ? 'start' : 'end'}`);

	// --- Restore cursor to original position before calculating boundary ---
	// The caller should save the position BEFORE calling this function multiple times.
	// We restore to the *original* row for which the frame is being calculated.
	compileRestoreCursorPosition(compiler, cursorIdx, regOriginalRowid, partitionStartRowidReg);

	if (isRangeFrame) {
		if (!orderByInfo || orderByInfo.keyIndices.length === 0) {
			throw new SqliteError("RANGE frames require an ORDER BY clause.", StatusCode.ERROR);
		}
		// ===============================================
		// --- RANGE Frame Boundary Logic ---
		// ===============================================

		switch (bound.type) {
			case 'unboundedPreceding':
				// Same as ROWS UNBOUNDED PRECEDING: Go to the start of the partition
				if (partitionStartRowidReg) {
					compiler.emit(Opcode.SeekRowid, cursorIdx, addrSeekFailed, partitionStartRowidReg, null, 1,
						`RANGE UNBOUNDED PRECEDING: Seek partition start ${partitionStartRowidReg}`);
					compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, `Save boundary rowid`);
					compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				} else {
					compiler.emit(Opcode.Rewind, cursorIdx, addrRewindFailed, 0, null, 0, "RANGE UNBOUNDED PRECEDING: Rewind");
					compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, `Save boundary rowid`);
					compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				}
				break;

			case 'currentRow':
				// Find the first (for start bound) or last (for end bound) peer row
				const regCurrentOrderByKeys = compiler.allocateMemoryCells(orderByInfo.keyIndices.length);
				const regPeerOrderByKeys = compiler.allocateMemoryCells(orderByInfo.keyIndices.length);
				const addrPeerLoopStart = compiler.allocateAddress();
				const addrPeerLoopEnd = compiler.allocateAddress();
				const savedPeerPosReg = compiler.allocateMemoryCells(1); // Save pos *before* seeking peer
				const seekOffset = isFrameStart ? -1 : 1; // Seek backwards for start, forwards for end
				const seekOffsetReg = compiler.allocateMemoryCells(1);
				compiler.emit(Opcode.Integer, seekOffset, seekOffsetReg, 0, null, 0, `RANGE CUR ROW: Set peer seek offset ${seekOffset}`);

				// Get ORDER BY keys for the original row
				for (let i = 0; i < orderByInfo.keyIndices.length; i++) {
					compiler.emit(Opcode.VColumn, cursorIdx, orderByInfo.keyIndices[i], regCurrentOrderByKeys + i, null, 0,
						"RANGE CUR ROW: Get original ORDER BY key");
				}

				// --- Peer Seek Loop ---
				compiler.resolveAddress(addrPeerLoopStart);

				// Save position before attempting seek
				compileSaveCursorPosition(compiler, cursorIdx, savedPeerPosReg);

				// Attempt to seek to the next potential peer
				compiler.emit(Opcode.SeekRelative, cursorIdx, addrPeerLoopEnd, seekOffsetReg, null, 1 /* jump on fail */,
					"RANGE CUR ROW: Seek potential peer");

				// --- Peer Check ---
				// Check 1: Partition Boundary (implicitly handled by SeekRelative failure, but good to be explicit if SeekRelative isn't perfect)
				// Optional explicit check:
				// if (numPartitionKeys && numPartitionKeys > 0 && partitionKeyIndices && regOriginalPartKeys) { ... compare keys ... jump to addrPeerLoopEnd if different }

				// Check 2: Compare ORDER BY keys
				for (let i = 0; i < orderByInfo.keyIndices.length; i++) {
					compiler.emit(Opcode.VColumn, cursorIdx, orderByInfo.keyIndices[i], regPeerOrderByKeys + i, null, 0,
						"RANGE CUR ROW: Get peer ORDER BY key");
					const coll = orderByInfo.collations?.[i];
					const p4Coll = coll ? { type: 'coll' as const, name: coll } : null;
					// If keys are different, the previous position (savedPeerPosReg) was the edge.
					compiler.emit(Opcode.Ne, regCurrentOrderByKeys + i, addrPeerLoopEnd, regPeerOrderByKeys + i, p4Coll, 0x01,
						"RANGE CUR ROW: Check if peer keys differ");
				}

				// Keys match, it's a peer. Continue the loop.
				compiler.emit(Opcode.Goto, 0, addrPeerLoopStart, 0, null, 0, "RANGE CUR ROW: Peer found, continue seek");

				// --- Peer Loop End ---
				compiler.resolveAddress(addrPeerLoopEnd);
				// Seek failed OR keys differed. The boundary is the row at savedPeerPosReg.
				compileRestoreCursorPosition(compiler, cursorIdx, savedPeerPosReg, partitionStartRowidReg);
				compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, "RANGE CUR ROW: Save boundary rowid");
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				break;

			case 'preceding':
			case 'following':
				// --- RANGE N PRECEDING / N FOLLOWING ---
				if (orderByInfo.keyIndices.length !== 1) {
					throw new SqliteError("RANGE with offset requires exactly one ORDER BY clause", StatusCode.ERROR);
				}
				if (!boundValueReg) {
					throw new SqliteError(`Missing bound value register for RANGE ${bound.type}`, StatusCode.INTERNAL);
				}

				const regCurrentOrderByKey = compiler.allocateMemoryCells(1);
				const regTargetValue = compiler.allocateMemoryCells(1);
				const regIterOrderByKey = compiler.allocateMemoryCells(1);
				if (numPartitionKeys === undefined) {
					throw new SqliteError("Internal error: numPartitionKeys is undefined in RANGE N boundary calc", StatusCode.INTERNAL);
				}
				const regIterPartKeys = compiler.allocateMemoryCells(numPartitionKeys > 0 ? numPartitionKeys : 1);
				const addrValueSeekLoopEnd = compiler.allocateAddress();
				const addrValueFoundPeersStart = compiler.allocateAddress();
				const savedValueSeekPosReg = compiler.allocateMemoryCells(1); // Save pos *before* check
				const seekOffsetVal = bound.type === 'preceding' ? -1 : 1;
				const seekOffsetValReg = compiler.allocateMemoryCells(1);
				compiler.emit(Opcode.Integer, seekOffsetVal, seekOffsetValReg, 0, null, 0, `Set seek offset ${seekOffsetVal}`);

				const orderByColIdx = orderByInfo.keyIndices[0];
				const coll = orderByInfo.collations?.[0];
				const p4Coll = coll ? { type: 'coll' as const, name: coll } : null;

				// 1. Get the ORDER BY key for the original row
				compiler.emit(Opcode.VColumn, cursorIdx, orderByColIdx, regCurrentOrderByKey, null, 0,
					`RANGE N: Get original ORDER BY key (col ${orderByColIdx})`);

				// 2. Calculate the target value (current +/- N)
				// TODO: Check affinity, handle potential errors if not numeric?
				if (bound.type === 'preceding') {
					compiler.emit(Opcode.Subtract, boundValueReg, regCurrentOrderByKey, regTargetValue, null, 0, "RANGE N: target = current_key - N");
				} else { // following
					compiler.emit(Opcode.Add, boundValueReg, regCurrentOrderByKey, regTargetValue, null, 0, "RANGE N: target = current_key + N");
				}

				// 3. Loop: Seek towards boundary, comparing values
				const comparisonOp = bound.type === 'preceding' ? Opcode.Le : Opcode.Ge;
				const addrValueSeekLoopCheck = compiler.allocateAddress();
				compiler.resolveAddress(addrValueSeekLoopCheck);

				// Save position before getting key and comparing
				compileSaveCursorPosition(compiler, cursorIdx, savedValueSeekPosReg);

				// Get current iteration row's ORDER BY key
				compiler.emit(Opcode.VColumn, cursorIdx, orderByColIdx, regIterOrderByKey, null, 0,
					"RANGE N: Get iter ORDER BY key");

				// Compare iteration key with target value
				// Preceding: Seek backward until iter_key <= target_value
				// Following: Seek forward until iter_key >= target_value
				compiler.emit(comparisonOp, regIterOrderByKey, addrValueFoundPeersStart, regTargetValue, p4Coll, 0x01,
					`RANGE N: Check if iter_key ${Opcode[comparisonOp]} target`);

				// Value not yet met. Check partition boundary before seeking further.
				if (numPartitionKeys && numPartitionKeys > 0 && partitionKeyIndices && regOriginalPartKeys) {
					for (let i = 0; i < numPartitionKeys; i++) {
						compiler.emit(Opcode.VColumn, cursorIdx, partitionKeyIndices[i], regIterPartKeys + i, null, 0, `RANGE N: Read Part Key ${i}`);
						// If partition key differs, we've gone past the boundary. Jump to end.
						compiler.emit(Opcode.Ne, regIterPartKeys + i, addrValueSeekLoopEnd, regOriginalPartKeys + i, null, 0x01,
							`RANGE N: Check Part Key ${i} != Original`);
					}
				}

				// Seek one step further. Jump to end if seek fails.
				compiler.emit(Opcode.SeekRelative, cursorIdx, addrValueSeekLoopEnd, seekOffsetValReg, null, 1,
					"RANGE N: Seek next row");

				// Seek succeeded, loop again
				compiler.emit(Opcode.Goto, 0, addrValueSeekLoopCheck, 0, null, 0, "RANGE N: Loop seek");

				// --- Found a row matching value condition OR hit boundary ---
				compiler.resolveAddress(addrValueFoundPeersStart);
				// The cursor is currently on the first row that satisfies the value condition (iter_key <= target or iter_key >= target).
				// Now we need to find the *first* peer (for PRECEDING) or *last* peer (for FOLLOWING) of *this* row.

				// Restore position to the row where the value condition was met
				compileRestoreCursorPosition(compiler, cursorIdx, savedValueSeekPosReg, partitionStartRowidReg);

				// Call the RANGE CURRENT ROW logic to find the boundary peer
				// We reuse the logic, but it starts from the row identified by savedValueSeekPosReg
				const regBoundaryPeerKey = compiler.allocateMemoryCells(1);
				const regPeerCheckKey = compiler.allocateMemoryCells(1);
				const addrPeerCheckLoopStart = compiler.allocateAddress();
				const addrPeerCheckLoopEnd = compiler.allocateAddress();
				const savedPeerCheckPosReg = compiler.allocateMemoryCells(1);
				// Seek direction depends on finding first (PRECEDING -> seek backward) or last (FOLLOWING -> seek forward) peer
				const peerSeekOffset = bound.type === 'preceding' ? -1 : 1;
				const peerSeekOffsetReg = compiler.allocateMemoryCells(1);
				compiler.emit(Opcode.Integer, peerSeekOffset, peerSeekOffsetReg, 0, null, 0, `Set peer seek offset ${peerSeekOffset}`);

				// Get the ORDER BY key of the row that met the value condition
				compiler.emit(Opcode.VColumn, cursorIdx, orderByColIdx, regBoundaryPeerKey, null, 0,
					"RANGE N: Get boundary ORDER BY key");

				// Peer Seek Loop
				compiler.resolveAddress(addrPeerCheckLoopStart);
				compileSaveCursorPosition(compiler, cursorIdx, savedPeerCheckPosReg); // Save before seek
				compiler.emit(Opcode.SeekRelative, cursorIdx, addrPeerCheckLoopEnd, peerSeekOffsetReg, null, 1 /* jump on fail */,
					"RANGE N: Seek potential peer");

				// Check partition boundary (optional, SeekRelative might handle)

				// Compare peer key
				compiler.emit(Opcode.VColumn, cursorIdx, orderByColIdx, regPeerCheckKey, null, 0,
					"RANGE N: Get peer ORDER BY key");
				// If keys differ, the previous position was the edge peer
				compiler.emit(Opcode.Ne, regBoundaryPeerKey, addrPeerCheckLoopEnd, regPeerCheckKey, p4Coll, 0x01,
					"RANGE N: Check if peer keys differ");

				// Peer found, continue loop
				compiler.emit(Opcode.Goto, 0, addrPeerCheckLoopStart, 0, null, 0, "RANGE N: Peer found, continue seek");

				// Peer Loop End
				compiler.resolveAddress(addrPeerCheckLoopEnd);
				compileRestoreCursorPosition(compiler, cursorIdx, savedPeerCheckPosReg, partitionStartRowidReg);
				compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, "RANGE N: Save boundary rowid");
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);

				// --- Seek Loop End (Value not found / partition boundary hit) ---
				compiler.resolveAddress(addrValueSeekLoopEnd);
				// We hit the partition boundary before finding a value match.
				// Restore position to the last valid row within the partition during the seek.
				compileRestoreCursorPosition(compiler, cursorIdx, savedValueSeekPosReg, partitionStartRowidReg);

				// Determine boundary based on direction:
				if (bound.type === 'preceding') {
					// If seeking backward and hit partition start, the boundary is the start.
					// (We might already be there from restore, but VRowid is safe)
					compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, "RANGE PRECEDING N: Hit partition start, boundary is start");
				} else { // following
					// If seeking forward and hit partition end, the boundary is the end.
					compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, "RANGE FOLLOWING N: Hit partition end, boundary is end");
				}
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				break;

			case 'unboundedFollowing':
				// Same as ROWS UNBOUNDED FOLLOWING: Loop forward to the end
				const addrEofLoop = compiler.allocateAddress();
				const addrEofLoopCheck = compiler.allocateAddress();
				const savedEofLoopPos = compiler.allocateMemoryCells(1);
				compiler.resolveAddress(addrEofLoopCheck);
				compiler.emit(Opcode.VRowid, cursorIdx, savedEofLoopPos, 0, null, 0, "RANGE UNBOUNDED FOLLOWING: Save current rowid");
				compiler.emit(Opcode.VNext, cursorIdx, addrEofLoop, 0, null, 0, `RANGE UNBOUNDED FOLLOWING: Seek EOF`);
				compiler.emit(Opcode.Goto, 0, addrEofLoopCheck, 0, null, 0);
				compiler.resolveAddress(addrEofLoop);
				compiler.emit(Opcode.SCopy, savedEofLoopPos, regBoundaryRowid, 0, null, 0, "RANGE UNBOUNDED FOLLOWING: Set boundary to last valid row");
				compileRestoreCursorPosition(compiler, cursorIdx, regBoundaryRowid, partitionStartRowidReg);
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				break;

			default:
				// This case should be unreachable due to exhaustive bound type checking
				// If it occurs, it indicates an issue with the AST or frame definition logic.
				const exhaustiveCheck: never = bound;
				throw new SqliteError(`Unhandled RANGE bound: ${JSON.stringify(exhaustiveCheck)}`, StatusCode.INTERNAL);
		}

		// compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `RANGE boundary calculation NYI in refactor`);
		// // TODO: Implement RANGE logic here using loops, VColumn, SeekRelative, comparisons.
		// // Needs careful handling of peers and partition boundaries.
		// compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0, "Jump to continue (RANGE NYI)");

	} else { // --- ROWS Frame Logic ---
		switch (bound.type) {
			case 'unboundedPreceding':
				// Go to the start of the partition
				if (partitionStartRowidReg) {
					// Try seeking to the known partition start rowid
					compiler.emit(Opcode.SeekRowid, cursorIdx, addrSeekFailed, partitionStartRowidReg, null, 1 /* jump on fail */,
						`ROWS UNBOUNDED PRECEDING: Seek partition start ${partitionStartRowidReg}`);
					// Seek succeeded, get the rowid and jump to continue
					compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, `Save boundary rowid`);
					compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				} else {
					// No known partition start, so rewind the whole cursor
					compiler.emit(Opcode.Rewind, cursorIdx, addrRewindFailed, 0, null, 0, "ROWS UNBOUNDED PRECEDING: Rewind");
					// Rewind succeeded, get the rowid and jump to continue
					compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, `Save boundary rowid`);
					compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				}
				break;
			case 'preceding':
				if (!boundValueReg) throw new SqliteError("Missing bound value register for PRECEDING", StatusCode.INTERNAL);
				const negatedOffsetReg = compiler.allocateMemoryCells(1);
				compiler.emit(Opcode.Negative, boundValueReg, negatedOffsetReg, 0, null, 0, "Negate PRECEDING offset");
				// Seek backward. P5=1 jumps to addrSeekFailed if seek goes out of bounds/partition.
				compiler.emit(Opcode.SeekRelative, cursorIdx, addrSeekFailed, negatedOffsetReg, null, 1,
					`ROWS PRECEDING: Seek relative ${negatedOffsetReg}`);
				// Seek succeeded
				compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, `Save boundary rowid`);
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				break;
			case 'currentRow':
				// Boundary is the original row itself. Cursor is already restored there.
				compiler.emit(Opcode.SCopy, regOriginalRowid, regBoundaryRowid, 0, null, 0, "ROWS CURRENT ROW: Boundary is original row");
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				break;
			case 'following':
				if (!boundValueReg) throw new SqliteError("Missing bound value register for FOLLOWING", StatusCode.INTERNAL);
				// Seek forward. P5=1 jumps to addrSeekFailed if seek goes out of bounds/partition.
				compiler.emit(Opcode.SeekRelative, cursorIdx, addrSeekFailed, boundValueReg, null, 1,
					`ROWS FOLLOWING: Seek relative ${boundValueReg}`);
				// Seek succeeded
				compiler.emit(Opcode.VRowid, cursorIdx, regBoundaryRowid, 0, null, 0, `Save boundary rowid`);
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				break;
			case 'unboundedFollowing':
				// Loop forward to the end of the partition/cursor
				const addrEofLoop = compiler.allocateAddress();
				const addrEofLoopCheck = compiler.allocateAddress();
				const savedLoopPos = compiler.allocateMemoryCells(1); // To store the last *valid* rowid

				// Start loop check
				compiler.resolveAddress(addrEofLoopCheck);
				// Save current (potentially valid) position before trying VNext
				compiler.emit(Opcode.VRowid, cursorIdx, savedLoopPos, 0, null, 0, "ROWS UNBOUNDED FOLLOWING: Save current rowid");
				// Optional: Check partition boundary here if needed, though VNext should handle EOF
				// Advance cursor. Jump to addrEofLoop (loop end) if VNext fails (EOF).
				compiler.emit(Opcode.VNext, cursorIdx, addrEofLoop, 0, null, 0, `ROWS UNBOUNDED FOLLOWING: Seek EOF`);
				// VNext succeeded, loop again
				compiler.emit(Opcode.Goto, 0, addrEofLoopCheck, 0, null, 0);

				// Loop finished (VNext failed)
				compiler.resolveAddress(addrEofLoop);
				// The last valid rowid is in savedLoopPos
				compiler.emit(Opcode.SCopy, savedLoopPos, regBoundaryRowid, 0, null, 0, "ROWS UNBOUNDED FOLLOWING: Set boundary to last valid row");
				// Restore cursor to this last valid row (SeekRowid should work)
				compileRestoreCursorPosition(compiler, cursorIdx, regBoundaryRowid, partitionStartRowidReg);
				compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);
				break;
			default:
				throw new SqliteError(`Unsupported frame bound type: ${(bound as any).type}`, StatusCode.INTERNAL);
		}
	} // --- End ROWS/RANGE Logic ---

	// --- Seek/Rewind Failure Handling ---
	compiler.resolveAddress(addrSeekFailed);
	// A SeekRelative or SeekRowid failed, meaning the boundary is outside the partition.
	// Leave the cursor invalid and boundary rowid as NULL.
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `Boundary seek failed (out of partition/EOF)`);
	compiler.emit(Opcode.Goto, 0, addrContinue, 0, null, 0);

	compiler.resolveAddress(addrRewindFailed);
	// Rewind failed (e.g., empty sorter/partition?). Leave boundary rowid as NULL.
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `Rewind failed`);
	// Fall through to addrContinue

	// --- Boundary Calculation Done ---
	compiler.resolveAddress(addrContinue);
	// Leave the cursor positioned at the calculated boundary (or invalid if seek failed)
	// The boundary rowid is in regBoundaryRowid (or NULL if failed)
	return addrContinue; // Might not be needed if we don't branch *within* this function
}

/**
 * Helper function to calculate an aggregate function over a window frame.
 * Uses cursor navigation to iterate over the frame, applying aggregate steps.
 *
 * @param compiler The compiler instance
 * @param cursor The cursor index
 * @param funcName The aggregate function name (lowercase)
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
export function compileFrameAggregate(
	compiler: Compiler,
	cursor: number,
	funcName: string, // Assumed lowercase
	winExpr: AST.WindowFunctionExpr, // Pass the expression
	resultReg: number,
	frameDef: AST.WindowFrame,
	startBoundReg: number, // Reg for start bound value (e.g., N in N PRECEDING)
	endBoundReg: number,   // Reg for end bound value
	partStartRowidReg: number, // Reg holding rowid of partition start
	numPartitionKeys: number,
	partitionKeyIndices: number[],
	regOriginalPartKeys: number, // Reg holding partition keys of the *original* row
	regOriginalRowid: number, // Reg holding rowid of the *original* row
	orderByInfo: { keyIndices: number[]; directions: boolean[]; collations?: (string | undefined)[] } | undefined,
	sorterInfo: WindowSorterInfo // Need sorter info for arg mapping
): void {
	// --- Basic Setup ---
	// const savedPosReg = compiler.allocateMemoryCells(1); // No longer saving original pos *here*
	const argReg = compiler.allocateMemoryCells(1); // Holds the argument value for the current row
	const regAggContext = compiler.allocateMemoryCells(1); // Holds the aggregate function context
	const regOne = compiler.allocateMemoryCells(1);
	compiler.emit(Opcode.Integer, 1, regOne, 0, null, 0, "Load constant 1");
	const regZero = compiler.allocateMemoryCells(1);
	compiler.emit(Opcode.Integer, 0, regZero, 0, null, 0, "Load 0");

	// Registers to store the calculated frame boundary rowids
	const regFrameStartRowid = compiler.allocateMemoryCells(1);
	const regFrameEndRowid = compiler.allocateMemoryCells(1);
	// Registers to store ORDER BY keys of the end boundary (for RANGE check)
	const regFrameEndKeys = compiler.allocateMemoryCells(orderByInfo ? orderByInfo.keyIndices.length : 1);

	// Get argument column index from sorter info
	const argExpr = winExpr.function.args?.[0];
	const argColIndex = argExpr
		? sorterInfo.exprToSorterIndex.get(expressionToString(argExpr)) ?? -1
		: -1; // -1 if no args (e.g., COUNT(*))

	// Find the aggregate function definition
	const funcDef = compiler.db._findFunction(funcName, winExpr.function.args?.length ?? 0);
	if (!funcDef || !funcDef.xStep || !funcDef.xFinal) {
		throw new SqliteError(`Aggregate function '${funcName}' not found or incomplete`, StatusCode.ERROR);
	}
	const p4Func: P4FuncDef = { type: 'funcdef', funcDef: funcDef, nArgs: winExpr.function.args?.length ?? 0 };

	// --- Frame Boundary Calculation ---

	// 1. Calculate Start Boundary
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `--- Calculate Frame Start (${frameDef.type}) ---`);
	compileFrameBoundary(
		compiler, cursor, frameDef.start, true /* isFrameStart */,
		regOriginalRowid, regFrameStartRowid, startBoundReg,
		partStartRowidReg, frameDef.type === 'range', orderByInfo,
		numPartitionKeys, partitionKeyIndices, regOriginalPartKeys
	);
	// At this point, cursor is at the frame start, regFrameStartRowid has its rowid (or null)

	// 2. Calculate End Boundary
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `--- Calculate Frame End (${frameDef.type}) ---`);
	const endBound = frameDef.end ?? { type: 'currentRow' }; // Default end is current row
	compileFrameBoundary(
		compiler, cursor, endBound, false /* isFrameStart */,
		regOriginalRowid, regFrameEndRowid, endBoundReg, // Use endBoundReg here
		partStartRowidReg, frameDef.type === 'range', orderByInfo,
		numPartitionKeys, partitionKeyIndices, regOriginalPartKeys
	);
	// At this point, cursor is at the frame end, regFrameEndRowid has its rowid (or null)
	// For RANGE frames, we also need the ORDER BY keys of the end boundary for the loop check
	if (frameDef.type === 'range' && orderByInfo) {
		const addrSkipEndKeyRead = compiler.allocateAddress();
		compiler.emit(Opcode.IfNull, regFrameEndRowid, addrSkipEndKeyRead, 0, null, 0, "Skip reading end keys if end boundary is NULL");
		for (let i = 0; i < orderByInfo.keyIndices.length; i++) {
			compiler.emit(Opcode.VColumn, cursor, orderByInfo.keyIndices[i], regFrameEndKeys + i, null, 0,
				"RANGE Agg: Save end boundary ORDER BY key");
		}
		compiler.resolveAddress(addrSkipEndKeyRead);
	}

	// --- Aggregation Loop ---

	// 3. Initialize Aggregate Context
	compiler.emit(Opcode.Null, 0, regAggContext, 1, null, 0, `Init Agg Context for ${funcName}`);

	// 4. Position cursor at Frame Start for iteration
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `--- Begin Frame Aggregation Loop ---`);
	const addrLoopStart = compiler.allocateAddress();
	const addrLoopEnd = compiler.allocateAddress();
	const addrSkipAggregateStep = compiler.allocateAddress();
	const addrStartBoundaryIsNull = compiler.allocateAddress();

	// Check if start boundary is NULL (frame is empty or starts outside partition)
	compiler.emit(Opcode.IfNull, regFrameStartRowid, addrStartBoundaryIsNull, 0, null, 0, "Skip loop if start boundary is NULL");

	// Seek to the calculated frame start rowid
	compileRestoreCursorPosition(compiler, cursor, regFrameStartRowid, partStartRowidReg);
	// compileRestoreCursorPosition might jump on failure - add check?
	// Let's assume restore works if regFrameStartRowid is not NULL.

	// -- Loop Start --
	compiler.resolveAddress(addrLoopStart);

	// 5. Check if current row is past the end boundary
	const addrPastEnd = addrLoopEnd; // Reuse loop end address
	const regCurrentIterRowid = compiler.allocateMemoryCells(1);
	compiler.emit(Opcode.VRowid, cursor, regCurrentIterRowid, 0, null, 0, "Agg Loop: Get current rowid");

	// Check 1: Is end boundary NULL? If yes, we can't be past it.
	const addrEndNotNull = compiler.allocateAddress();
	compiler.emit(Opcode.IfNull, regFrameEndRowid, addrEndNotNull, 0, null, 0, "Continue loop if end boundary is NULL");
	// End boundary is NOT NULL, proceed with comparison
	if (frameDef.type === 'rows') {
		// For ROWS, simply compare rowids. If current > end, exit.
		// Need a reliable way to compare rowids (potentially large numbers/strings)
		// Assuming simple comparison works for now.
		// NOTE: This assumes rowids are monotonically increasing with VNext, which is true for MemoryTable.
		compiler.emit(Opcode.Gt, regCurrentIterRowid, addrPastEnd, regFrameEndRowid, null, 0x01,
			"ROWS Agg: Check if current rowid > end rowid");
	} else { // RANGE
		// For RANGE, compare ORDER BY keys
		if (orderByInfo) {
			const regCurrentIterKeys = compiler.allocateMemoryCells(orderByInfo.keyIndices.length);
			for (let i = 0; i < orderByInfo.keyIndices.length; i++) {
				compiler.emit(Opcode.VColumn, cursor, orderByInfo.keyIndices[i], regCurrentIterKeys + i, null, 0,
					"RANGE Agg: Get current ORDER BY key");
				const coll = orderByInfo.collations?.[i];
				const p4Coll = coll ? { type: 'coll' as const, name: coll } : null;
				// Determine comparison op based on sort direction
				// If ASC (dir=false), exit if current > end
				// If DESC (dir=true), exit if current < end
				const comparisonOp = orderByInfo.directions[i] ? Opcode.Lt : Opcode.Gt;
				compiler.emit(comparisonOp, regCurrentIterKeys + i, addrPastEnd, regFrameEndKeys + i, p4Coll, 0x01,
					`RANGE Agg: Check if current key past end key (col ${i}, dir ${orderByInfo.directions[i] ? 'DESC' : 'ASC'})`);
			}
		}
	}
	compiler.resolveAddress(addrEndNotNull); // Rejoin flow if end boundary was NULL

	// 6. Check Partition Boundary (Optional but safer? SeekRelative/VNext should handle)
	// if (numPartitionKeys > 0) { ... compare regOriginalPartKeys ... jump to addrLoopEnd if mismatch }

	// 7. Perform Aggregate Step
	if (argColIndex >= 0) {
		// Read argument value
		compiler.emit(Opcode.VColumn, cursor, argColIndex, argReg, null, 0, "Agg Loop: Get value");
		// Skip step if arg is NULL (standard SQL aggregate behavior)
		// COUNT(*) is handled below
		if (funcName !== 'count') {
			compiler.emit(Opcode.IfNull, argReg, addrSkipAggregateStep, 0, null, 0, "Skip step if arg is NULL");
		}
	} else {
		// Handle COUNT(*) - always step
		// For other 0-arg aggregates, they would step here too.
		// We set argReg for consistency if Function opcode needs it, but it's unused.
		compiler.emit(Opcode.Integer, 1, argReg, 0, null, 0, "Agg Loop: Dummy arg for COUNT(*) or 0-arg func");
	}

	// Call aggregate function's xStep
	// P1=ArgStartReg, P2=ContextReg (In/Out), P3=NumArgs, P4=FuncDef
	// Assuming Function opcode writes context back to P2
	compiler.emit(Opcode.Function, argReg, regAggContext, p4Func.nArgs, p4Func, 0,
		`Agg Loop: Call ${funcName} xStep`);

	compiler.resolveAddress(addrSkipAggregateStep); // Jump here if arg was NULL and skipped step

	// 8. Advance Cursor
	// Jump to loop end if VNext fails (EOF or partition boundary)
	compiler.emit(Opcode.VNext, cursor, addrLoopEnd, 0, null, 0, "Agg Loop: Advance to next frame row");
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "Agg Loop: Loop to next frame row");

	// -- Loop End --
	compiler.resolveAddress(addrStartBoundaryIsNull); // Jump here if start was NULL
	compiler.resolveAddress(addrLoopEnd); // Jump here if loop completes or terminates early
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `--- End Frame Aggregation Loop ---`);

	// --- Finalize & Restore ---

	// 9. Call Aggregate Finalize
	// P1=DummyArg, P2=ContextReg, P3=ResultReg, P4=FuncDef
	// Assuming Function opcode writes result to P3 when P4 is Agg
	compiler.emit(Opcode.Function, 0 /* Dummy Arg Start */, regAggContext, resultReg, p4Func, 0,
		`Call ${funcName} xFinal`);

	// 10. Restore Original Cursor Position (before returning result)
	// Crucial so subsequent window functions start from the correct row.
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `--- Restore Original Cursor Position ---`);
	compileRestoreCursorPosition(compiler, cursor, regOriginalRowid, partStartRowidReg);
}

/** Helper to convert frame bound to relative offset register for ROWS */
export function compileBoundToRelativeOffset(
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
export function compileSaveCursorPosition(
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
 * Tries SeekRowid first, then falls back to a scan if necessary.
 * Assumes the target rowid is still present in the cursor's result set within the current partition.
 *
 * @param compiler The compiler instance.
 * @param cursorIdx The index of the cursor.
 * @param regSavedRowid The register containing the target rowid to seek to.
 * @param regPartitionStartRowid Optional: Register with the rowid of the partition start. If provided, rewinds only to partition start for fallback scan.
 */
export function compileRestoreCursorPosition(
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

	// --- Fallback Scan Logic ---
	compiler.resolveAddress(addrRestoreFailed);
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `INFO: SeekRowid failed, falling back to scan for cursor ${cursorIdx}`);

	const regCurrentRowid = compiler.allocateMemoryCells(1);
	const addrScanLoopStart = compiler.allocateAddress();
	const addrScanNotFound = compiler.allocateAddress(); // Jump here if scan finishes without finding

	// Rewind cursor: Use partition start if available, otherwise full rewind
	if (regPartitionStartRowid) {
		// Attempt to seek to partition start first (might also fail, but worth trying)
		const addrRewindFallback = compiler.allocateAddress();
		compiler.emit(Opcode.SeekRowid, cursorIdx, addrRewindFallback, regPartitionStartRowid, null, 1, `Restore Pos: Fallback - Seek partition start ${regPartitionStartRowid}`);
		// If partition seek fails, do a full rewind
		const addrRewindDone = compiler.allocateAddress();
		compiler.emit(Opcode.Goto, 0, addrRewindDone, 0, null, 0); // Skip full rewind if partition seek worked
		compiler.resolveAddress(addrRewindFallback);
	} else {
		compiler.emit(Opcode.Rewind, cursorIdx, addrScanNotFound, 0, null, 0, "Restore Pos: Fallback - Full Rewind");
	}


	// Start the scan loop
	compiler.resolveAddress(addrScanLoopStart);

	// Get current rowid in the loop
	compiler.emit(Opcode.VRowid, cursorIdx, regCurrentRowid, 0, null, 0, "Restore Pos: Fallback - Get current rowid");

	// Compare current rowid with the saved target rowid
	compiler.emit(Opcode.Eq, regCurrentRowid, addrRestoreDone, regSavedRowid, null, 0, "Restore Pos: Fallback - Check if rowid matches target"); // Jump to Done if equal

	// Not found yet, advance cursor
	compiler.emit(Opcode.VNext, cursorIdx, addrScanNotFound, 0, null, 0, "Restore Pos: Fallback - Advance cursor"); // Jump to NotFound on EOF
	compiler.emit(Opcode.Goto, 0, addrScanLoopStart, 0, null, 0, "Restore Pos: Fallback - Continue scan loop");

	// Handle case where scan finished without finding the rowid
	compiler.resolveAddress(addrScanNotFound);
	// Row not found - this might indicate a problem if the row was expected to exist.
	// Keep the cursor at EOF state (result of Rewind or VNext failing).
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `WARN: Cursor ${cursorIdx} position restore fallback scan did not find rowid in reg ${regSavedRowid}`);
	// Proceed to Done, leaving cursor potentially invalid/EOF

	// Restore successful (either via SeekRowid or Fallback Scan)
	compiler.resolveAddress(addrRestoreDone);
}
