import type { Compiler } from './compiler.js';
import type { JoinLevelInfo } from './select.js';
import type { ColumnResultInfo } from './compiler.js';
import { Opcode } from '../vdbe/opcodes.js';
import { SqliteError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';

const warnLog = createLogger('compiler:join').extend('warn');

export function compileJoinCondition(
	compiler: Compiler,
	level: JoinLevelInfo,
	allJoinLevels: ReadonlyArray<JoinLevelInfo>,
	levelIndex: number,
	addrJoinFail: number      // Placeholder ID for the jump target
): void {
	if (!level.joinType || level.joinType === 'cross') return; // No condition for CROSS

	const rightCursor = level.cursor;

	// Get the left cursor - the previous level in the join sequence
	if (levelIndex <= 0) {
		throw new SqliteError(`Internal error: compileJoinCondition called with invalid level index ${levelIndex}`, StatusCode.INTERNAL);
	}

	const leftLevel = allJoinLevels[levelIndex - 1];
	const leftCursor = leftLevel.cursor;
	const leftSchema = leftLevel.schema;
	const rightSchema = level.schema;

	if (level.condition) {
		// Compile the ON expression
		const regJoinCondition = compiler.allocateMemoryCells(1);
		compiler.compileExpression(level.condition, regJoinCondition);
		// Emit the jump, using the placeholder ID
		compiler.emit(Opcode.IfFalse, regJoinCondition, addrJoinFail, 0, null, 0, `JOIN: Check ON Condition`);
	} else if (level.usingColumns) {
		// Compile the USING condition
		const regLeftCol = compiler.allocateMemoryCells(1);
		const regRightCol = compiler.allocateMemoryCells(1);

		for (const colName of level.usingColumns) {
			const leftColIdx = leftSchema.columnIndexMap.get(colName.toLowerCase());
			const rightColIdx = rightSchema.columnIndexMap.get(colName.toLowerCase());
			if (leftColIdx === undefined || rightColIdx === undefined) {
				throw new SqliteError(`Column '${colName}' specified in USING clause not found in both tables.`, StatusCode.ERROR);
			}

			compiler.emit(Opcode.VColumn, leftCursor, leftColIdx, regLeftCol, 0, 0, `USING(${colName}) Left`);
			compiler.emit(Opcode.VColumn, rightCursor, rightColIdx, regRightCol, 0, 0, `USING(${colName}) Right`);

			// Handle NULLs: If either is NULL, comparison fails (result 0 for JOIN)
			// Emit jumps using the placeholder ID
			compiler.emit(Opcode.IfNull, regLeftCol, addrJoinFail, 0, null, 0, `USING: Skip if left NULL`);
			compiler.emit(Opcode.IfNull, regRightCol, addrJoinFail, 0, null, 0, `USING: Skip if right NULL`);

			// Compare non-null values - Jump to fail if not equal
			// Emit jump using the placeholder ID
			compiler.emit(Opcode.Ne, regLeftCol, addrJoinFail, regRightCol, null, 0, `USING Compare ${colName}`);
			// If Ne doesn't jump, they are equal, continue to next column
		}
	}
	// Natural join would need to be implemented here
}

export function emitLeftJoinNullPadding(
	compiler: Compiler,
	level: JoinLevelInfo,
	allJoinLevels: ReadonlyArray<JoinLevelInfo>,
	levelIndex: number,
	coreColumnMap: ReadonlyArray<ColumnResultInfo>,
	innermostProcessStartAddr: number // Address to jump back to process the padded row
): void {
	if (level.joinType !== 'left' || !level.matchReg) {
		return; // Not a LEFT JOIN or matchReg not set
	}

	const addrSkipNullPadEof = compiler.allocateAddress(`skipLeftJoinNullPad[${levelIndex}]`);
	compiler.emit(Opcode.IfTrue, level.matchReg, addrSkipNullPadEof, 0, null, 0, `LEFT JOIN EOF: Skip NULL pad if match found [${levelIndex}]`);

	// If no match found, need to pad columns from this level and inner levels with NULL
	// TODO: Determine correct padding based on coreColumnMap and levels >= levelIndex
	warnLog(`LEFT JOIN NULL padding for level %d is not fully implemented.`, levelIndex);
	// Placeholder: Emit NULLs for columns directly from this level for now
	coreColumnMap.forEach(colInfo => {
		if (colInfo.sourceCursor === level.cursor) {
			compiler.emit(Opcode.Null, 0, colInfo.targetReg, 0, null, 0, `NULL Pad Col ${level.alias}.${colInfo.sourceColumnIndex}`);
		}
	});

	compiler.emit(Opcode.Goto, 0, innermostProcessStartAddr, 0, null, 0, `LEFT JOIN EOF: Process NULL-padded row [${levelIndex}]`);

	compiler.resolveAddress(addrSkipNullPadEof);
}
