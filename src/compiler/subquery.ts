import { Opcode, ConflictResolution } from '../common/constants';
import { StatusCode, type SqlValue } from '../common/types';
import { SqliteError } from '../common/errors';
import { type P4Vtab, type P4FuncDef } from '../vdbe/instruction';
import type { Compiler, SubroutineInfo, ColumnResultInfo } from './compiler'; // Added ColumnResultInfo
import type * as AST from '../parser/ast';
import { analyzeSubqueryCorrelation, type SubqueryCorrelationResult, type CorrelatedColumnInfo } from './helpers';
import type { ArgumentMap } from './expression';
import type { TableSchema } from '../schema/table'; // Added TableSchema

// --- Subquery Compilation Functions --- //

export function compileSubquery(compiler: Compiler, expr: AST.SubqueryExpr, targetReg: number): void {
	// This function is usually called for subqueries used as expressions (scalar, comparison).
	// EXISTS and IN are typically handled by parent Unary/Binary expression compilers.
	console.warn("compileSubquery assuming scalar context. EXISTS/IN should be handled by parent expression compiler.");
	compiler.compileScalarSubquery(expr.query, targetReg);
}

export function compileScalarSubquery(compiler: Compiler, subQuery: AST.SelectStmt, targetReg: number): void {
	// --- Analyze Correlation ---
	const activeOuterCursors = new Set(compiler.tableAliases.values());
	const correlation = analyzeSubqueryCorrelation(compiler, subQuery, activeOuterCursors);
	// -------------------------

	if (correlation.isCorrelated) {
		compileCorrelatedScalarSubquery(compiler, subQuery, targetReg, correlation);
	} else {
		compileUncorrelatedScalarSubquery(compiler, subQuery, targetReg);
	}
}

// --- Uncorrelated Scalar Subquery --- //
function compileUncorrelatedScalarSubquery(compiler: Compiler, subQuery: AST.SelectStmt, targetReg: number): void {
	if (subQuery.columns.length !== 1 || subQuery.columns[0].type === 'all') {
		throw new SqliteError("Scalar subquery must return exactly one column (cannot be *)", StatusCode.ERROR, undefined, subQuery.loc?.start.line, subQuery.loc?.start.column);
	}
	const regHasRow = compiler.allocateMemoryCells(1);
	const addrLoopStart = compiler.allocateAddress(); // Re-add loop start address
	const addrLoopEnd = compiler.allocateAddress();
	const addrErrorTooMany = compiler.allocateAddress();
	const addrFinalize = compiler.allocateAddress();
	const addrSetNull = compiler.allocateAddress();

	compiler.emit(Opcode.Integer, 0, regHasRow, 0, null, 0, "Init Subquery: hasRow=0");
	// --- Compile subquery core directly ---
	const subQueryCursors: number[] = [];
	const { resultBaseReg: subqueryResultBase, numCols } = compiler.compileSelectCore(subQuery, subQueryCursors);
	if (numCols !== 1) throw new Error("Scalar Subquery core compile error: Expected 1 column");
	// --------------------------------------

	const firstSubCursor = subQueryCursors[0];
	if (firstSubCursor === undefined) {
		// Subquery has no FROM clause (e.g., SELECT 1)
		compiler.emit(Opcode.Integer, 1, regHasRow, 0, null, 0, "Subquery: Set hasRow=1 (literal)");
		compiler.emit(Opcode.SCopy, subqueryResultBase, targetReg, 0, null, 0, "Subquery: Copy literal result");
		compiler.emit(Opcode.Goto, 0, addrFinalize, 0, null, 0, "Subquery: Finish (literal)");
	} else {
		// Subquery has FROM clause, use VFilter/VNext
		compiler.emit(Opcode.VFilter, firstSubCursor, addrLoopEnd, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "Subquery: Start scan");
		compiler.resolveAddress(addrLoopStart);
		compiler.emit(Opcode.IfTrue, regHasRow, addrErrorTooMany, 0, null, 0, "Subquery: Check if >1 row");
		compiler.emit(Opcode.Integer, 1, regHasRow, 0, null, 0, "Subquery: Set hasRow=1");
		// Need to copy the result inside the loop for the first row
		compiler.emit(Opcode.SCopy, subqueryResultBase, targetReg, 0, null, 0, "Subquery: Copy row result");
		compiler.emit(Opcode.VNext, firstSubCursor, addrLoopEnd, 0, null, 0, "Subquery: VNext");
		compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "Subquery: Loop");
		// Address after loop (where VFilter jumps on empty or VNext jumps on EOF)
		compiler.resolveAddress(addrLoopEnd); // Add resolution for loop end
	}

	compiler.closeCursorsUsedBySelect(subQueryCursors);

	// Final result check
	compiler.emit(Opcode.IfFalse, regHasRow, addrSetNull, 0, null, 0, "Subquery: Check if hasRow is false (0 rows)");
	compiler.emit(Opcode.Goto, 0, addrFinalize, 0, null, 0, "Subquery: Finish (1 row)");
	compiler.resolveAddress(addrErrorTooMany);
	compiler.emit(Opcode.Halt, StatusCode.ERROR, 0, 0, "Scalar subquery returned more than one row", 0, "Error: Subquery >1 row"); // Halt instead of setting NULL?
	// Or maybe just set NULL? SQLite seems to error.
	// compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "Set comparison NULL");
	compiler.resolveAddress(addrSetNull); // Added resolution for set null
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "Subquery: Set NULL Result (0 rows)");
	compiler.resolveAddress(addrFinalize);
}

// --- Correlated Scalar Subquery --- //
function compileCorrelatedScalarSubquery(
	compiler: Compiler,
	subQuery: AST.SelectStmt,
	targetReg: number,
	correlation: SubqueryCorrelationResult
): void {
	let subInfo: SubroutineInfo | undefined = compiler.subroutineDefs?.get(subQuery);

	if (!subInfo) {
		compiler.startSubroutineCompilation();
		const subStartAddress = compiler.getCurrentAddress();
		// Locals in the subroutine frame: R[2]=result, R[3]=hasRow, R[4]=error
		const regSubResult = 2;
		const regSubHasRow = 3;
		const regSubError = 4;
		const numLocals = 4; // Result, hasRow, error + control info slots

		// Argument Map: Outer args start at FP[-1], FP[-2], ...
		const argumentMap: Map<string, number> = new Map();
		correlation.correlatedColumns.forEach((cc, index) => {
			const argOffset = -(index + 1);
			argumentMap.set(`${cc.outerCursor}.${cc.outerColumnIndex}`, argOffset);
		});

		// Compile subquery core inside the subroutine context
		const subQueryCursors: number[] = [];
		const { resultBaseReg, numCols } = compiler.compileSelectCore(subQuery, subQueryCursors, correlation, argumentMap);
		if (numCols !== 1) throw new SqliteError("Correlated scalar subquery must return one column", StatusCode.INTERNAL, undefined, subQuery.loc?.start.line, subQuery.loc?.start.column);

		const addrSubLoopStart = compiler.allocateAddress();
		const addrSubLoopEnd = compiler.allocateAddress();
		const addrSubErrorTooMany = compiler.allocateAddress();
		const addrSubFinalize = compiler.allocateAddress();
		const addrSubSetNull = compiler.allocateAddress();
		const firstSubCursor = subQueryCursors[0];

		// Init local flags
		compiler.emit(Opcode.Integer, 0, regSubHasRow, 0, null, 0, "Sub: Init hasRow=0");
		compiler.emit(Opcode.Integer, 0, regSubError, 0, null, 0, "Sub: Init error=0");

		const vnextJumpTarget = compiler.allocateAddress(); // Target for jumps to VNext

		if (firstSubCursor !== undefined) {
			// Start scan
			compiler.emit(Opcode.VFilter, firstSubCursor, addrSubLoopEnd, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "Sub: Start scan");
			compiler.resolveAddress(addrSubLoopStart);

			// Check if error already occurred
			compiler.emit(Opcode.IfTrue, regSubError, vnextJumpTarget, 0, null, 0, "Sub: Skip if error already set");

			// Check if this is the second row (hasRow already set)
			compiler.emit(Opcode.IfTrue, regSubHasRow, addrSubErrorTooMany, 0, null, 0, "Sub: Check if >1 row");

			// First row logic
			compiler.emit(Opcode.Integer, 1, regSubHasRow, 0, null, 0, "Sub: Set hasRow=1");
			compiler.emit(Opcode.SCopy, resultBaseReg, regSubResult, 0, null, 0, "Sub: Copy first row result");
			compiler.emit(Opcode.Goto, 0, vnextJumpTarget, 0, null, 0); // Jump to VNext after processing first row

			// Error path for more than one row
			compiler.resolveAddress(addrSubErrorTooMany);
			compiler.emit(Opcode.Integer, 1, regSubError, 0, null, 0, "Sub: Set error=1 (>1 row)");
			compiler.emit(Opcode.Null, 0, regSubResult, 0, null, 0, "Sub: Set NULL on >1 row error");
			// Fall through to VNext

			// VNext jump target
			compiler.resolveAddress(vnextJumpTarget);
			compiler.emit(Opcode.VNext, firstSubCursor, addrSubLoopEnd, 0, null, 0, "Sub: VNext");
			compiler.emit(Opcode.Goto, 0, addrSubLoopStart, 0, null, 0, "Sub: Loop");
		} else {
			// No FROM clause case (literal)
			compiler.emit(Opcode.Integer, 1, regSubHasRow, 0, null, 0, "Sub: Set hasRow=1 (literal)");
			compiler.emit(Opcode.SCopy, resultBaseReg, regSubResult, 0, null, 0, "Sub: Copy literal result");
			// No loop, jump directly towards finalization
			compiler.emit(Opcode.Goto, 0, addrSubFinalize - 1, 0, null, 0); // Adjust jump slightly before finalize
		}

		compiler.resolveAddress(addrSubLoopEnd);
		compiler.closeCursorsUsedBySelect(subQueryCursors);

		// Subroutine Finalization Logic
		compiler.resolveAddress(compiler.getCurrentAddress()); // Ensure landing pad before checks
		compiler.emit(Opcode.IfTrue, regSubError, addrSubFinalize, 0, null, 0, "Sub: Jump if error flag set");
		compiler.emit(Opcode.IfFalse, regSubHasRow, addrSubSetNull, 0, null, 0, "Sub: Check if hasRow is false (0 rows)");
		compiler.emit(Opcode.Goto, 0, addrSubFinalize, 0, null, 0, "Sub: Finish (1 row, no error)");

		compiler.resolveAddress(addrSubSetNull);
		compiler.emit(Opcode.Null, 0, regSubResult, 0, null, 0, "Sub: Set NULL result (0 rows)");

		compiler.resolveAddress(addrSubFinalize);
		// Store results in caller's argument slots (negative FP offsets)
		// Caller pushed Result then Error placeholder, so Result is FP[-1], Error is FP[-2]
		compiler.emit(Opcode.SCopy, regSubResult, -1, 0, null, 0, "Sub: Store result in Arg FP[-1]");
		compiler.emit(Opcode.SCopy, regSubError, -2, 0, null, 0, "Sub: Store error in Arg FP[-2]");

		// Leave subroutine frame and return
		compiler.emit(Opcode.FrameLeave, 0, 0, 0, null, 0, "Leave Subroutine Frame");
		compiler.emit(Opcode.Return, 0, 0, 0, null, 0, "Return from subquery");

		subInfo = { startAddress: subStartAddress, correlation };
		compiler.subroutineDefs?.set(subQuery, subInfo);
		compiler.endSubroutineCompilation();
	}

	// --- Call Site Logic --- //
	const numArgsToPush = correlation.correlatedColumns.length;
	const callerResultReg = compiler.allocateMemoryCells(1); // Temp reg for result in caller frame
	const callerErrorReg = compiler.allocateMemoryCells(1);  // Temp reg for error in caller frame

	// 1. Push Correlated Outer Values
	correlation.correlatedColumns.forEach(cc => {
		const tempOuterValReg = compiler.allocateMemoryCells(1);
		// Resolve outer column name and alias correctly
		const outerAlias = [...compiler.tableAliases.entries()].find(([_, cIdx]) => cIdx === cc.outerCursor)?.[0];
		const outerSchema = compiler.tableSchemas.get(cc.outerCursor);
		if (!outerSchema) throw new Error(`Internal: Schema for outer cursor ${cc.outerCursor} not found`);
		const outerColName = outerSchema.columns[cc.outerColumnIndex]?.name;
		if (!outerColName) throw new Error(`Internal: Column index ${cc.outerColumnIndex} not found for outer cursor ${cc.outerCursor}`);

		// Compile outer expression in the *caller's* context
		const outerColExpr: AST.ColumnExpr = { type: 'column', name: outerColName, table: outerAlias };
		compiler.compileExpression(outerColExpr, tempOuterValReg); // No correlation/argMap needed here
		compiler.emit(Opcode.Push, tempOuterValReg, 0, 0, null, 0, `Push outer val ${outerColName}`);
	});

	// 2. Push Placeholders for Return Values (Error then Result)
	// Error status goes to FP[-2] in callee, Result to FP[-1]
	compiler.emit(Opcode.Push, 0, 0, 0, null, 0, "Push placeholder for Sub Error Status");
	compiler.emit(Opcode.Push, 0, 0, 0, null, 0, "Push placeholder for Sub Result");
	const totalArgsPushed = numArgsToPush + 2;

	// 3. Call Subroutine
	compiler.emit(Opcode.Subroutine, totalArgsPushed, subInfo.startAddress, 0, null, 0, `Call correlated subquery`);

	// 4. Copy Results from Stack (negative FP offsets are relative to caller's FP AFTER call)
	// These locations on the stack were where we pushed the placeholders.
	// Need to calculate absolute stack indices based on current SP.
	const resultStackIdx = compiler.stackPointer - 1; // Absolute index of result
	const errorStackIdx = compiler.stackPointer - 2; // Absolute index of error status
	compiler.emit(Opcode.SCopy, resultStackIdx, callerResultReg, 0, null, 0, `Copy sub result from stack[${resultStackIdx}]`);
	compiler.emit(Opcode.SCopy, errorStackIdx, callerErrorReg, 0, null, 0, `Copy sub error from stack[${errorStackIdx}]`);

	// 5. Pop Arguments and Return Values
	compiler.emit(Opcode.StackPop, totalArgsPushed, 0, 0, null, 0, `Pop subquery args/results`);

	// 6. Check Error Status
	const addrSubroutineErrorCheck = compiler.allocateAddress();
	const addrSubroutineEnd = compiler.allocateAddress();
	compiler.emit(Opcode.IfZero, callerErrorReg, addrSubroutineErrorCheck, 0, null, 0, "Check subquery error flag");
	compiler.emit(Opcode.Halt, StatusCode.ERROR, 0, 0, "Correlated scalar subquery returned multiple rows", 0, "Error: Subquery >1 row");
	compiler.resolveAddress(addrSubroutineErrorCheck);

	// 7. Copy Final Result to Target Register
	compiler.emit(Opcode.SCopy, callerResultReg, targetReg, 0, null, 0, "Copy final subquery result");
	compiler.resolveAddress(addrSubroutineEnd);
}


// --- IN Subquery --- //
export function compileInSubquery(
	compiler: Compiler,
	leftExpr: AST.Expression,
	subQuery: AST.SelectStmt,
	targetReg: number,
	invert: boolean
): void {
	if (subQuery.columns.length !== 1 || subQuery.columns[0].type === 'all') {
		throw new SqliteError("Subquery for IN operator must return exactly one column (cannot be *)", StatusCode.ERROR, undefined, subQuery.loc?.start.line, subQuery.loc?.start.column);
	}

	const subqueryCorrelation = analyzeSubqueryCorrelation(compiler, subQuery, new Set(compiler.tableAliases.values()));
	if (subqueryCorrelation.isCorrelated) {
		compileCorrelatedInSubquery(compiler, leftExpr, subQuery, targetReg, invert, subqueryCorrelation);
	} else {
		compileUncorrelatedInSubquery(compiler, leftExpr, subQuery, targetReg, invert);
	}
}

function compileUncorrelatedInSubquery(
	compiler: Compiler,
	leftExpr: AST.Expression,
	subQuery: AST.SelectStmt,
	targetReg: number,
	invert: boolean
): void {
	// --- Uncorrelated IN logic (using ephemeral table) ---
	const regLeftValue = compiler.allocateMemoryCells(1);
	const regSubValue = compiler.allocateMemoryCells(1);
	const regHasNull = compiler.allocateMemoryCells(1);
	const regMatchFound = compiler.allocateMemoryCells(1);
	const ephCursor = compiler.allocateCursor();
	const addrScanLoop = compiler.allocateAddress();
	const addrCompareJump = compiler.allocateAddress(); // Corrected jump target
	const addrMatch = compiler.allocateAddress();
	const addrScanEnd = compiler.allocateAddress();
	const addrFinal = compiler.allocateAddress();
	const addrSetNull = compiler.allocateAddress();
	const addrSubqueryItemIsNull = compiler.allocateAddress();
	const addrSkipInsert = compiler.allocateAddress();

	compiler.emit(Opcode.Integer, 0, regHasNull, 0, null, 0, "IN: Init hasNull=0");
	compiler.emit(Opcode.Integer, 0, regMatchFound, 0, null, 0, "IN: Init matchFound=0");

	// Compile left expression *once* before building the ephemeral table
	compiler.compileExpression(leftExpr, regLeftValue);
	compiler.emit(Opcode.IfNull, regLeftValue, addrSetNull, 0, null, 0, "IN: Check if Left Expr is NULL (early exit)");

	// Build Ephemeral Table
	compiler.emit(Opcode.OpenEphemeral, ephCursor, 1, 0, null, 0, "IN: Open Ephemeral Table");
	const ephSchema = compiler.createEphemeralSchema(ephCursor, 1);

	const subQueryCursors: number[] = [];
	const { resultBaseReg: subResultReg, numCols } = compiler.compileSelectCore(subQuery, subQueryCursors);
	if (numCols !== 1) throw new Error("IN Subquery core compile error");

	const firstSubCursor = subQueryCursors[0];
	const addrSubLoopStart = compiler.allocateAddress();
	const addrSubLoopEnd = compiler.allocateAddress();
	const regInsertData = compiler.allocateMemoryCells(2); // rowid, value

	if (firstSubCursor === undefined) { // Subquery is literal (e.g., SELECT 1 UNION SELECT 2)
		compiler.emit(Opcode.IfNull, subResultReg, addrSubqueryItemIsNull, 0, null, 0, "IN: Check literal NULL");
		compiler.emit(Opcode.Null, 0, regInsertData, 0, null, 0); // Rowid for eph insert
		compiler.emit(Opcode.SCopy, subResultReg, regInsertData + 1, 0, null, 0); // Value for eph insert
		compiler.emit(Opcode.VUpdate, 2, regInsertData, 0, { table: ephSchema }, 0, "IN: Insert literal");
		compiler.emit(Opcode.Goto, 0, addrSkipInsert, 0, null, 0);
		compiler.resolveAddress(addrSubqueryItemIsNull);
		compiler.emit(Opcode.Integer, 1, regHasNull, 0, null, 0, "IN: Set hasNull=1 (literal)");
		compiler.resolveAddress(addrSkipInsert);
	} else { // Subquery involves table scan
		compiler.emit(Opcode.VFilter, firstSubCursor, addrSubLoopEnd, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "IN: Subquery Scan Start");
		compiler.resolveAddress(addrSubLoopStart);
		compiler.emit(Opcode.IfNull, subResultReg, addrSubqueryItemIsNull, 0, null, 0, "IN: Check subquery NULL");
		// Insert non-null value
		compiler.emit(Opcode.Null, 0, regInsertData, 0, null, 0, "IN: Prep Insert Rowid");
		compiler.emit(Opcode.SCopy, subResultReg, regInsertData + 1, 0, null, 0, "IN: Prep Insert Value");
		compiler.emit(Opcode.VUpdate, 2, regInsertData, 0, { table: ephSchema }, 0, "IN: Insert subquery result");
		compiler.emit(Opcode.Goto, 0, addrSkipInsert, 0, null, 0); // Jump over hasNull set
		// Handle null value
		compiler.resolveAddress(addrSubqueryItemIsNull);
		compiler.emit(Opcode.Integer, 1, regHasNull, 0, null, 0, "IN: Set hasNull=1");
		// Continue loop
		compiler.resolveAddress(addrSkipInsert);
		compiler.emit(Opcode.VNext, firstSubCursor, addrSubLoopEnd, 0, null, 0, "IN: Subquery VNext");
		compiler.emit(Opcode.Goto, 0, addrSubLoopStart, 0, null, 0, "IN: Subquery Loop");
		compiler.resolveAddress(addrSubLoopEnd);
	}
	compiler.closeCursorsUsedBySelect(subQueryCursors);

	// Scan Ephemeral Table for Match
	compiler.emit(Opcode.Rewind, ephCursor, addrScanEnd, 0, null, 0, "IN: Rewind Ephemeral Table");
	compiler.resolveAddress(addrScanLoop);
	compiler.emit(Opcode.VColumn, ephCursor, 0, regSubValue, 0, 0, "IN: Get value from Ephemeral");

	// Compare Left Value with Ephemeral Value
	// Use Eq opcode which handles NULL correctly (NULL == NULL is NULL/false in WHERE/JOIN)
	compiler.emit(Opcode.Eq, regLeftValue, addrMatch, regSubValue, null, 0, "IN: Compare values (jump if EQ)");
	// If not equal, continue loop
	compiler.resolveAddress(addrCompareJump); // Corrected jump target
	compiler.emit(Opcode.VNext, ephCursor, addrScanEnd, 0, null, 0, "IN: VNext Ephemeral");
	compiler.emit(Opcode.Goto, 0, addrScanLoop, 0, null, 0, "IN: Loop Ephemeral Scan");

	// Match found (or potential NULL match)
	compiler.resolveAddress(addrMatch);
	// If the match was NULL = NULL, the result should be NULL, not TRUE
	compiler.emit(Opcode.IfNull, regLeftValue, addrSetNull, 0, null, 0, "IN: If left was NULL, result is NULL");
	compiler.emit(Opcode.IfNull, regSubValue, addrSetNull, 0, null, 0, "IN: If matching eph val was NULL, result is NULL");
	// If neither was NULL, it's a definite match
	compiler.emit(Opcode.Integer, 1, regMatchFound, 0, null, 0, "IN: Set matchFound=1");
	compiler.emit(Opcode.Goto, 0, addrScanEnd, 0, null, 0, "IN: Jump to end (match found)");

	// Scan finished
	compiler.resolveAddress(addrScanEnd);
	compiler.closeCursorsUsedBySelect([ephCursor]);

	// Determine final result based on matchFound and hasNull
	const trueVal = invert ? 0 : 1;
	const falseVal = invert ? 1 : 0;
	const addrResultFalse = compiler.allocateAddress();
	const addrResultSetTrue = compiler.allocateAddress(); // Added distinct addr for true result

	compiler.emit(Opcode.IfTrue, regMatchFound, addrResultSetTrue, 0, null, 0); // Jump to set TRUE/FALSE if definite match
	// No definite match: check if NULL was present in subquery results
	compiler.emit(Opcode.IfTrue, regHasNull, addrSetNull, 0, null, 0, "IN: Check if NULL present (no match)");
	// No match, no NULL -> definite FALSE (or TRUE if inverted)
	compiler.resolveAddress(addrResultFalse);
	compiler.emit(Opcode.Integer, falseVal, targetReg, 0, null, 0, `IN: Set Final Result (${falseVal})`);
	compiler.emit(Opcode.Goto, 0, addrFinal, 0, null, 0, "IN: Jump to final");

	// Set TRUE (or FALSE if inverted)
	compiler.resolveAddress(addrResultSetTrue); // Target for definite match jump
	compiler.emit(Opcode.Integer, trueVal, targetReg, 0, null, 0, `IN: Set Final Result (${trueVal})`);
	compiler.emit(Opcode.Goto, 0, addrFinal, 0, null, 0);

	// Set NULL result (either left expr was NULL, or no match found and NULL was present)
	compiler.resolveAddress(addrSetNull);
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "IN: Set NULL Result");

	compiler.resolveAddress(addrFinal);
}

function compileCorrelatedInSubquery(
	compiler: Compiler,
	leftExpr: AST.Expression,
	subQuery: AST.SelectStmt,
	targetReg: number,
	invert: boolean,
	correlation: SubqueryCorrelationResult
): void {
	let subInfo: SubroutineInfo | undefined = compiler.subroutineDefs?.get(subQuery);

	if (!subInfo) {
		// --- Compile Subroutine ---
		compiler.startSubroutineCompilation();
		const subStartAddress = compiler.getCurrentAddress();

		// Locals: R[2]=Match Flag, R[3]=Has Null Flag, R[4]=Subquery Value
		const regSubMatch = 2;
		const regSubNull = 3;
		const regSubValue = 4;

		// Argument Map for inner compilation
		// Left expression value is at FP[-1] (pushed by caller)
		// Outer args start at FP[-2]
		const subArgumentMap: Map<string, number> = new Map();
		subArgumentMap.set("_caller_left_expr_", -1); // Special key for left expr?
		correlation.correlatedColumns.forEach((cc, index) => {
			subArgumentMap.set(`${cc.outerCursor}.${cc.outerColumnIndex}`, -(index + 2));
		});

		// Compile subquery core
		const subQueryCursors: number[] = [];
		const { resultBaseReg, numCols } = compiler.compileSelectCore(subQuery, subQueryCursors, correlation, subArgumentMap);
		if (numCols !== 1) throw new SqliteError("Correlated IN subquery requires 1 column", StatusCode.INTERNAL, undefined, subQuery.loc?.start.line, subQuery.loc?.start.column);

		// --- Subroutine Logic ---
		const addrSubLoopStart = compiler.allocateAddress();
		const addrSubLoopEnd = compiler.allocateAddress();
		const addrSubMatchFound = compiler.allocateAddress();
		const addrSubIsNull = compiler.allocateAddress();
		const addrSubCompare = compiler.allocateAddress();
		const addrSubFinalize = compiler.allocateAddress();
		const firstSubCursor = subQueryCursors[0];

		compiler.emit(Opcode.Integer, 0, regSubMatch, 0, null, 0, "SubIN: Init match=0");
		compiler.emit(Opcode.Integer, 0, regSubNull, 0, null, 0, "SubIN: Init hasNull=0");

		if (firstSubCursor !== undefined) {
			compiler.emit(Opcode.VFilter, firstSubCursor, addrSubLoopEnd, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "SubIN: Start scan");
			compiler.resolveAddress(addrSubLoopStart);
			// Optimization: If match found and no null encountered yet, can we stop?
			// No, because a later NULL could change the result from TRUE to NULL. Must scan all rows.
			compiler.emit(Opcode.SCopy, resultBaseReg, regSubValue, 0, null, 0, "SubIN: Get subquery value");
			compiler.emit(Opcode.IfNull, regSubValue, addrSubIsNull, 0, null, 0, "SubIN: Check if subquery value is NULL");
			// Compare non-NULL subquery value with left expression argument (at FP[-1])
			compiler.emit(Opcode.Eq, -1, addrSubMatchFound, regSubValue, null, 0, "SubIN: Compare with Arg (Jump if EQ)"); // Use FP[-1]
			compiler.emit(Opcode.Goto, 0, addrSubCompare, 0, null, 0); // Not equal
			compiler.resolveAddress(addrSubIsNull);
			compiler.emit(Opcode.Integer, 1, regSubNull, 0, null, 0, "SubIN: Set hasNull=1");
			compiler.emit(Opcode.Goto, 0, addrSubCompare, 0, null, 0);
			compiler.resolveAddress(addrSubMatchFound);
			compiler.emit(Opcode.Integer, 1, regSubMatch, 0, null, 0, "SubIN: Set match=1");
			// Fall through to VNext after match
			compiler.resolveAddress(addrSubCompare);
			compiler.emit(Opcode.VNext, firstSubCursor, addrSubLoopEnd, 0, null, 0, "SubIN: VNext");
			compiler.emit(Opcode.Goto, 0, addrSubLoopStart, 0, null, 0, "SubIN: Loop");
		} else { // No FROM clause - compare against literal result
			compiler.emit(Opcode.SCopy, resultBaseReg, regSubValue, 0, null, 0, "SubIN: Get literal subquery value");
			const addrLitIsNull = compiler.allocateAddress();
			const addrLitMatch = compiler.allocateAddress();
			compiler.emit(Opcode.IfNull, regSubValue, addrLitIsNull, 0, null, 0);
			compiler.emit(Opcode.Eq, -1, addrLitMatch, regSubValue, null, 0); // Use FP[-1]
			compiler.emit(Opcode.Goto, 0, addrSubLoopEnd, 0, null, 0); // No match
			compiler.resolveAddress(addrLitMatch);
			compiler.emit(Opcode.Integer, 1, regSubMatch, 0, null, 0); // Match
			compiler.emit(Opcode.Goto, 0, addrSubLoopEnd, 0, null, 0);
			compiler.resolveAddress(addrLitIsNull);
			compiler.emit(Opcode.Integer, 1, regSubNull, 0, null, 0);
			// Fall through to finalize (addrSubLoopEnd)
		}

		compiler.resolveAddress(addrSubLoopEnd);
		compiler.closeCursorsUsedBySelect(subQueryCursors);

		// Determine final result (True=1, False=0, Null=NULL) and store in FP[-1] (overwriting input arg)
		const trueResult = invert ? 0 : 1;
		const falseResult = invert ? 1 : 0;
		const addrSetSubFalse = compiler.allocateAddress();
		const addrSetSubNull = compiler.allocateAddress();
		const addrSetSubTrue = compiler.allocateAddress();

		compiler.emit(Opcode.IfTrue, regSubMatch, addrSetSubTrue, 0, null, 0); // Jump if definite match
		compiler.emit(Opcode.IfTrue, regSubNull, addrSetSubNull, 0, null, 0); // If no match, check for NULL
		// No match, no NULL -> set FALSE (or TRUE if NOT IN)
		compiler.resolveAddress(addrSetSubFalse);
		compiler.emit(Opcode.Integer, falseResult, -1, 0, null, 0, "SubIN: Set Final False/True");
		compiler.emit(Opcode.Goto, 0, addrSetSubNull + 1, 0, null, 0); // Jump past set NULL (relative jump?) - Check this address calc
		// Set TRUE (or FALSE if NOT IN)
		compiler.resolveAddress(addrSetSubTrue);
		compiler.emit(Opcode.Integer, trueResult, -1, 0, null, 0, "SubIN: Set Final True/False");
		compiler.emit(Opcode.Goto, 0, addrSetSubNull, 0, null, 0); // Jump past set NULL
		// Set NULL
		compiler.resolveAddress(addrSetSubNull);
		compiler.emit(Opcode.Null, 0, -1, 0, null, 0, "SubIN: Set Final NULL");

		compiler.resolveAddress(compiler.getCurrentAddress()); // Final landing pad
		compiler.emit(Opcode.FrameLeave, 0, 0, 0, null, 0, "Leave SubIN Frame");
		compiler.emit(Opcode.Return, 0, 0, 0, null, 0, "Return from SubIN");

		subInfo = { startAddress: subStartAddress, correlation };
		compiler.subroutineDefs?.set(subQuery, subInfo);
		compiler.endSubroutineCompilation();
	}

	// --- Call Site for Correlated IN --- //
	const regLeftValue = compiler.allocateMemoryCells(1);
	const addrIsNull = compiler.allocateAddress();
	const addrEnd = compiler.allocateAddress();

	// Compile left expression using the *caller's* context
	compiler.compileExpression(leftExpr, regLeftValue);
	compiler.emit(Opcode.IfNull, regLeftValue, addrIsNull, 0, null, 0, "IN: Check if Left Expr is NULL");

	let totalArgsPushed = 0;
	// Push Outer Values first (Args start at FP[-2])
	correlation.correlatedColumns.forEach((cc, index) => {
		const tempOuterValReg = compiler.allocateMemoryCells(1);
		const outerAlias = [...compiler.tableAliases.entries()].find(([_, cIdx]) => cIdx === cc.outerCursor)?.[0];
		const outerSchema = compiler.tableSchemas.get(cc.outerCursor);
		if (!outerSchema) throw new Error(`Schema ${cc.outerCursor} not found`);
		const outerColName = outerSchema.columns[cc.outerColumnIndex]?.name;
		if (!outerColName) throw new Error(`Col ${cc.outerColumnIndex} not found`);
		// Compile outer value expression using the *caller's* context
		compiler.compileExpression({ type: 'column', name: outerColName, table: outerAlias }, tempOuterValReg);
		compiler.emit(Opcode.Push, tempOuterValReg, 0, 0, null, 0, `Push outer val ${outerColName}`);
		totalArgsPushed++;
	});

	// Push Left Value (Arg 0 at FP[-1])
	compiler.emit(Opcode.Push, regLeftValue, 0, 0, null, 0, "Push Left Value for SubIN"); totalArgsPushed++;

	// Call Subroutine
	compiler.emit(Opcode.Subroutine, totalArgsPushed, subInfo.startAddress, 0, null, 0, "Call SubIN");

	// Result is returned in the stack slot where the left value was pushed.
	// Copy it to the target register.
	const resultStackIdx = compiler.stackPointer - 1;
	compiler.emit(Opcode.SCopy, resultStackIdx, targetReg, 0, null, 0, "Copy SubIN result from stack");

	// Pop Args + Result
	compiler.emit(Opcode.StackPop, totalArgsPushed, 0, 0, null, 0, "Pop SubIN args");
	compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

	// Handle case where left expression was NULL
	compiler.resolveAddress(addrIsNull);
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "IN: Set NULL Result");

	compiler.resolveAddress(addrEnd);
}

// --- Comparison Subquery (=, !=, <, <=, >, >=) --- //
export function compileComparisonSubquery(
	compiler: Compiler,
	leftExpr: AST.Expression,
	op: string,
	subQuery: AST.SelectStmt,
	targetReg: number
): void {
	const subqueryCorrelation = analyzeSubqueryCorrelation(compiler, subQuery, new Set(compiler.tableAliases.values()));
	if (subqueryCorrelation.isCorrelated) {
		compileCorrelatedComparisonSubquery(compiler, leftExpr, op, subQuery, targetReg, subqueryCorrelation);
	} else {
		compileUncorrelatedComparisonSubquery(compiler, leftExpr, op, subQuery, targetReg);
	}
}

function compileUncorrelatedComparisonSubquery(
	compiler: Compiler,
	leftExpr: AST.Expression,
	op: string,
	subQuery: AST.SelectStmt,
	targetReg: number
): void {
	const regLeft = compiler.allocateMemoryCells(1);
	const regSubResult = compiler.allocateMemoryCells(1);
	const addrSkipCompare = compiler.allocateAddress();
	const addrIsTrue = compiler.allocateAddress();
	const addrIsEnd = compiler.allocateAddress();
	let compareOpcode: Opcode;

	compiler.compileExpression(leftExpr, regLeft);
	compiler.emit(Opcode.IfNull, regLeft, addrSkipCompare, 0, null, 0, "Skip compare if left is NULL");
	// Compile scalar subquery (handles 0 or >1 row errors internally now)
	compiler.compileScalarSubquery(subQuery, regSubResult);
	compiler.emit(Opcode.IfNull, regSubResult, addrSkipCompare, 0, null, 0, "Skip compare if subquery is NULL");

	switch (op.toUpperCase()) {
		case '=': case '==': case 'IS': compareOpcode = Opcode.Eq; break;
		case '!=': case '<>': case 'IS NOT': compareOpcode = Opcode.Ne; break;
		case '<': compareOpcode = Opcode.Lt; break;
		case '<=': compareOpcode = Opcode.Le; break;
		case '>': compareOpcode = Opcode.Gt; break;
		case '>=': compareOpcode = Opcode.Ge; break;
		default: throw new SqliteError(`Unsupported comparison operator with subquery: ${op}`, StatusCode.ERROR, undefined, subQuery.loc?.start.line, subQuery.loc?.start.column);
	}

	// Use correct comparison order: compare(regSubResult, regLeft)
	compiler.emit(compareOpcode, regSubResult, addrIsTrue, regLeft, null, 0, `Compare Subquery Result`);
	compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "Set comparison FALSE");
	compiler.emit(Opcode.Goto, 0, addrIsEnd, 0, null, 0);
	compiler.resolveAddress(addrIsTrue);
	compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "Set comparison TRUE");
	compiler.emit(Opcode.Goto, 0, addrIsEnd, 0, null, 0);

	compiler.resolveAddress(addrSkipCompare);
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "Set comparison NULL");
	compiler.resolveAddress(addrIsEnd);
}

function compileCorrelatedComparisonSubquery(
	compiler: Compiler,
	leftExpr: AST.Expression,
	op: string,
	subQuery: AST.SelectStmt,
	targetReg: number,
	correlation: SubqueryCorrelationResult
): void {
	// Reuse the scalar subquery subroutine logic
	let subInfo = compiler.subroutineDefs?.get(subQuery);
	if (!subInfo) {
		const tempReg = compiler.allocateMemoryCells(1); // Dummy target register
		compileCorrelatedScalarSubquery(compiler, subQuery, tempReg, correlation);
		subInfo = compiler.subroutineDefs?.get(subQuery);
		if (!subInfo) throw new Error("Internal: Failed to compile correlated scalar subquery subroutine.");
	}

	// --- Call Site --- //
	const regLeftValue = compiler.allocateMemoryCells(1);
	const regSubResult = compiler.allocateMemoryCells(1); // To store result from subroutine
	const regSubError = compiler.allocateMemoryCells(1); // To store error status from subroutine
	const addrSkipCompare = compiler.allocateAddress();
	const addrIsTrue = compiler.allocateAddress();
	const addrIsEnd = compiler.allocateAddress();

	compiler.compileExpression(leftExpr, regLeftValue);
	compiler.emit(Opcode.IfNull, regLeftValue, addrSkipCompare, 0, null, 0, "Skip compare if left is NULL");

	// Push outer args, error placeholder, result placeholder
	let totalArgsPushed = 0;
	correlation.correlatedColumns.forEach(cc => {
		const tempOuterValReg = compiler.allocateMemoryCells(1);
		const outerAlias = [...compiler.tableAliases.entries()].find(([_, cIdx]) => cIdx === cc.outerCursor)?.[0];
		const outerSchema = compiler.tableSchemas.get(cc.outerCursor);
		if (!outerSchema) throw new Error(`Schema ${cc.outerCursor} not found`);
		const outerColName = outerSchema.columns[cc.outerColumnIndex]?.name;
		if (!outerColName) throw new Error(`Col ${cc.outerColumnIndex} not found`);
		compiler.compileExpression({ type: 'column', name: outerColName, table: outerAlias }, tempOuterValReg);
		compiler.emit(Opcode.Push, tempOuterValReg, 0, 0, null, 0, `Push outer val ${outerColName}`);
		totalArgsPushed++;
	});
	compiler.emit(Opcode.Push, 0, 0, 0, null, 0, "Push placeholder for Sub Error Status"); totalArgsPushed++;
	compiler.emit(Opcode.Push, 0, 0, 0, null, 0, "Push placeholder for Sub Result"); totalArgsPushed++;

	// Call the scalar subroutine
	compiler.emit(Opcode.Subroutine, totalArgsPushed, subInfo.startAddress, 0, null, 0, "Call correlated subquery for comparison");

	// Retrieve result/error from stack
	const resultStackIdx = compiler.stackPointer - 1; // Absolute index of result
	const errorStackIdx = compiler.stackPointer - 2; // Absolute index of error status
	compiler.emit(Opcode.SCopy, resultStackIdx, regSubResult, 0, null, 0, `Copy sub result from stack[${resultStackIdx}]`);
	compiler.emit(Opcode.SCopy, errorStackIdx, regSubError, 0, null, 0, `Copy sub error from stack[${errorStackIdx}]`);

	// Pop args/results
	compiler.emit(Opcode.StackPop, totalArgsPushed, 0, 0, null, 0, "Pop subquery args/results");

	// Check subquery error or NULL result
	compiler.emit(Opcode.IfTrue, regSubError, addrSkipCompare, 0, null, 0, "Skip compare if subquery had error (>1 row)");
	compiler.emit(Opcode.IfNull, regSubResult, addrSkipCompare, 0, null, 0, "Skip compare if subquery result is NULL (0 rows)");

	// Determine comparison opcode
	let compareOpcode: Opcode;
	switch (op.toUpperCase()) {
		case '=': case '==': case 'IS': compareOpcode = Opcode.Eq; break;
		case '!=': case '<>': case 'IS NOT': compareOpcode = Opcode.Ne; break;
		case '<': compareOpcode = Opcode.Lt; break;
		case '<=': compareOpcode = Opcode.Le; break;
		case '>': compareOpcode = Opcode.Gt; break;
		case '>=': compareOpcode = Opcode.Ge; break;
		default: throw new SqliteError(`Unsupported comparison operator with subquery: ${op}`, StatusCode.ERROR, undefined, subQuery.loc?.start.line, subQuery.loc?.start.column);
	}

	// Compare regLeftValue with retrieved subquery result (note order: compare(sub, left))
	compiler.emit(compareOpcode, regSubResult, addrIsTrue, regLeftValue, null, 0, `Compare Left Expr with Sub Result`);
	compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "Set comparison FALSE");
	compiler.emit(Opcode.Goto, 0, addrIsEnd, 0, null, 0);
	compiler.resolveAddress(addrIsTrue);
	compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "Set comparison TRUE");
	compiler.emit(Opcode.Goto, 0, addrIsEnd, 0, null, 0);

	// Set NULL if comparison was skipped
	compiler.resolveAddress(addrSkipCompare);
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "Set comparison NULL");
	compiler.resolveAddress(addrIsEnd);
}

// --- EXISTS Subquery --- //
export function compileExistsSubquery(
	compiler: Compiler,
	subQuery: AST.SelectStmt,
	targetReg: number
): void {
	const subqueryCorrelation = analyzeSubqueryCorrelation(compiler, subQuery, new Set(compiler.tableAliases.values()));
	if (subqueryCorrelation.isCorrelated) {
		compileCorrelatedExistsSubquery(compiler, subQuery, targetReg, subqueryCorrelation);
	} else {
		compileUncorrelatedExistsSubquery(compiler, subQuery, targetReg);
	}
}

function compileUncorrelatedExistsSubquery(
	compiler: Compiler,
	subQuery: AST.SelectStmt,
	targetReg: number
): void {
	const addrSetTrue = compiler.allocateAddress();
	const addrSetFalse = compiler.allocateAddress();
	const addrEnd = compiler.allocateAddress();
	const addrLoopStart = compiler.allocateAddress();
	const addrContinueLoop = compiler.allocateAddress();

	const subQueryCursors: number[] = compiler.compileFromCore(subQuery.from);
	const firstSubCursor = subQueryCursors[0];

	if (firstSubCursor === undefined) {
		// No FROM clause - EXISTS depends only on constant WHERE
		if (subQuery.where) {
			const constWhereReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(subQuery.where, constWhereReg);
			compiler.emit(Opcode.IfFalse, constWhereReg, addrSetFalse, 0, null, 0, "EXISTS: Check constant WHERE");
		}
		// If no WHERE or WHERE is true
		compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "EXISTS: Literal/No-FROM subquery is TRUE");
		compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);
		// If WHERE was false
		compiler.resolveAddress(addrSetFalse);
		compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "EXISTS: Set FALSE (constant WHERE failed)");
		compiler.resolveAddress(addrEnd);
		return;
	}

	// Has FROM clause - use VFilter to check for *any* row
	compiler.emit(Opcode.VFilter, firstSubCursor, addrSetFalse, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "EXISTS: Start scan");
	compiler.resolveAddress(addrLoopStart);
	if (subQuery.where) {
		const whereReg = compiler.allocateMemoryCells(1);
		compiler.compileExpression(subQuery.where, whereReg);
		compiler.emit(Opcode.IfFalse, whereReg, addrContinueLoop, 0, null, 0, "EXISTS: Check WHERE, jump to VNext if false");
	}
	// Row found matching WHERE (or no WHERE) - EXISTS is TRUE
	compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "EXISTS: Set TRUE (found row)");
	compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0, "EXISTS: Finish (found row)");

	// Continue loop if WHERE failed
	compiler.resolveAddress(addrContinueLoop);
	compiler.emit(Opcode.VNext, firstSubCursor, addrSetFalse, 0, null, 0, "EXISTS: VNext"); // Jump to SetFalse on EOF
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "EXISTS: Loop back");

	// Set FALSE if VFilter found no rows initially or VNext reached EOF
	compiler.resolveAddress(addrSetFalse);
	compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "EXISTS: Set FALSE (no rows found)");

	compiler.resolveAddress(addrEnd);
	compiler.closeCursorsUsedBySelect(subQueryCursors);
}

function compileCorrelatedExistsSubquery(
	compiler: Compiler,
	subQuery: AST.SelectStmt,
	targetReg: number,
	correlation: SubqueryCorrelationResult
): void {
	let subInfo: SubroutineInfo | undefined = compiler.subroutineDefs?.get(subQuery);

	if (!subInfo) {
		// --- Compile Subroutine --- //
		compiler.startSubroutineCompilation();
		const subStartAddress = compiler.getCurrentAddress();
		const regSubResult = 2; // Local R[2] = result (0 or 1)

		// Argument Map for inner compilation (Outer args start at FP[-1])
		const subArgumentMap: Map<string, number> = new Map();
		correlation.correlatedColumns.forEach((cc, index) => {
			subArgumentMap.set(`${cc.outerCursor}.${cc.outerColumnIndex}`, -(index + 1));
		});

		// Compile FROM and WHERE inside subroutine
		const subQueryCursors: number[] = compiler.compileFromCore(subQuery.from);
		const firstSubCursor = subQueryCursors[0];
		const addrSubLoopStart = compiler.allocateAddress();
		const addrSubEndScan = compiler.allocateAddress();
		const addrSubContinueLoop = compiler.allocateAddress();

		compiler.emit(Opcode.Integer, 0, regSubResult, 0, null, 0, "SubEXISTS: Init result=0");

		if (firstSubCursor === undefined) { // No FROM
			if (subQuery.where) {
				const constWhereReg = compiler.allocateMemoryCells(1);
				compiler.compileExpression(subQuery.where, constWhereReg, correlation, undefined, subArgumentMap);
				compiler.emit(Opcode.IfFalse, constWhereReg, addrSubEndScan, 0, null, 0, "SubEXISTS: Check const WHERE");
			}
			compiler.emit(Opcode.Integer, 1, regSubResult, 0, null, 0, "SubEXISTS: Set result=1 (const)");
		} else { // Has FROM
			compiler.emit(Opcode.VFilter, firstSubCursor, addrSubEndScan, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "SubEXISTS: Start scan");
			compiler.resolveAddress(addrSubLoopStart);
			if (subQuery.where) {
				const whereReg = compiler.allocateMemoryCells(1);
				compiler.compileExpression(subQuery.where, whereReg, correlation, undefined, subArgumentMap);
				compiler.emit(Opcode.IfFalse, whereReg, addrSubContinueLoop, 0, null, 0, "SubEXISTS: Check WHERE");
			}
			// Row found matching WHERE
			compiler.emit(Opcode.Integer, 1, regSubResult, 0, null, 0, "SubEXISTS: Set result=1 (row found)");
			compiler.emit(Opcode.Goto, 0, addrSubEndScan, 0, null, 0, "SubEXISTS: Exit loop early");
			// Continue loop if WHERE failed
			compiler.resolveAddress(addrSubContinueLoop);
			compiler.emit(Opcode.VNext, firstSubCursor, addrSubEndScan, 0, null, 0, "SubEXISTS: VNext");
			compiler.emit(Opcode.Goto, 0, addrSubLoopStart, 0, null, 0, "SubEXISTS: Loop back");
		}

		compiler.resolveAddress(addrSubEndScan);
		compiler.closeCursorsUsedBySelect(subQueryCursors);
		// Write result to argument slot FP[-1] (pushed by caller)
		compiler.emit(Opcode.SCopy, regSubResult, -1, 0, null, 0, "SubEXISTS: Store result in Arg FP[-1]");
		compiler.emit(Opcode.FrameLeave, 0, 0, 0, null, 0, "Leave SubEXISTS Frame");
		compiler.emit(Opcode.Return, 0, 0, 0, null, 0, "Return from SubEXISTS");
		// --- End Subroutine --- //

		subInfo = { startAddress: subStartAddress, correlation };
		compiler.subroutineDefs?.set(subQuery, subInfo);
		compiler.endSubroutineCompilation();
	}

	// --- Call Site --- //
	let totalArgsPushed = 0;
	// Push Outer Values
	correlation.correlatedColumns.forEach(cc => {
		const tempOuterValReg = compiler.allocateMemoryCells(1);
		const outerAlias = [...compiler.tableAliases.entries()].find(([_, cIdx]) => cIdx === cc.outerCursor)?.[0];
		const outerSchema = compiler.tableSchemas.get(cc.outerCursor);
		if (!outerSchema) throw new Error(`Schema ${cc.outerCursor} not found`);
		const outerColName = outerSchema.columns[cc.outerColumnIndex]?.name;
		if (!outerColName) throw new Error(`Col ${cc.outerColumnIndex} not found`);
		compiler.compileExpression({ type: 'column', name: outerColName, table: outerAlias }, tempOuterValReg);
		compiler.emit(Opcode.Push, tempOuterValReg, 0, 0, null, 0, `Push outer val ${outerColName}`);
		totalArgsPushed++;
	});
	// Push Placeholder for Result
	compiler.emit(Opcode.Push, 0, 0, 0, null, 0, "Push placeholder for Sub EXISTS Result (Arg 0)"); totalArgsPushed++;

	// Call Subroutine
	compiler.emit(Opcode.Subroutine, totalArgsPushed, subInfo.startAddress, 0, null, 0, "Call SubEXISTS");

	// Copy result from stack
	const resultStackIdx = compiler.stackPointer - 1;
	compiler.emit(Opcode.SCopy, resultStackIdx, targetReg, 0, null, 0, "Copy SubEXISTS result from stack");

	// Pop Args + Result
	compiler.emit(Opcode.StackPop, totalArgsPushed, 0, 0, null, 0, "Pop SubEXISTS args");
}
