import type { Compiler } from './compiler.js';
import type { JoinLevelInfo } from './select.js'; // Assuming JoinLevelInfo is exported or moved
import type * as AST from '../parser/ast.js';
import { Opcode } from '../vdbe/opcodes.js';
import { analyzeSubqueryCorrelation } from './correlation.js';
import { expressionToString } from '../util/ddl-stringify.js';
import { compileUnhandledWhereConditions } from './where-verify.js'; // Keep dependency
import { compileJoinCondition, emitLeftJoinNullPadding } from './join.js'; // Import necessary functions
import { createLogger } from '../common/logger.js'; // Import logger
import type { ColumnResultInfo } from './structs.js'; // Added for coreColumnMap

const log = createLogger('compiler:select-loop'); // Create logger instance

// Define callback type for processing a row within the innermost loop
export type ProcessRowCallback = (
	compiler: Compiler,
	stmt: AST.SelectStmt,
	joinLevels: ReadonlyArray<JoinLevelInfo>,
	activeOuterCursors: ReadonlySet<number>,
	innermostWhereFailTarget: number | undefined // Pass this for AggStep/Direct Output logic
) => number; // Returns the address of the start of the processing logic

export function compileSelectLoop(
	compiler: Compiler,
	stmt: AST.SelectStmt,
	joinLevels: ReadonlyArray<JoinLevelInfo>,
	fromCursors: ReadonlyArray<number>, // Needed for compileUnhandledWhereConditions
	processRowCallback: ProcessRowCallback,
	coreColumnMap: ReadonlyArray<ColumnResultInfo> // Added parameter
): { innermostLoopStartAddr: number, innermostLoopEndAddrPlaceholder: number } {

	const activeOuterCursors = new Set<number>();
	const loopStartPlaceholders: number[] = []; // Array to store placeholders
	let innermostProcessStartAddr = 0;
	const innermostLoopEndAddrPlaceholder = compiler.allocateAddress('innermostLoopEnd'); // Placeholder for end of entire loop structure

	// Setup each join level with loops, filters, and join conditions
	joinLevels.forEach((level, index) => {
		// Allocate addresses that MUST be known before emitting the main opcodes for this level
		const placeholder = compiler.allocateAddress(`loopStart[${index}]`); // Placeholder for jumps TO the loop start
		loopStartPlaceholders.push(placeholder); // Store placeholder
		level.joinFailAddr = compiler.allocateAddress(`joinFail[${index}]`);

		// For LEFT JOIN, allocate a match register
		if (level.joinType === 'left') {
			level.matchReg = compiler.allocateMemoryCells(1);
			compiler.emit(Opcode.Integer, 0, level.matchReg, 0, null, 0, `Init LEFT JOIN Match Flag [${index}] = 0`);
		}

		const cursor = level.cursor;
		const schema = level.schema;

		// Store the *actual* address where the loop's execution begins (VFilter or first check)
		level.loopStartAddr = compiler.getCurrentAddress();

		// --- Integrate Subquery Execution/Materialization ---
		if (schema.subqueryAST) {
			// Placeholder logic remains for now
			log.extend('warn')(`Execution logic for subquery source '${schema.name}' (cursor ${cursor}) is not yet implemented.`);
			const vFilterEofAddr = compiler.allocateAddress(`vFilterEof[${index}]`);
			level.vFilterEofPlaceholder = vFilterEofAddr;
			compiler.emit(Opcode.VFilter, cursor, vFilterEofAddr, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, `Filter/Scan Subquery Cursor ${index} (IMPLEMENTATION NEEDED)`);
		} else {
			// Standard VFilter logic
			const planningInfo = compiler.cursorPlanningInfo.get(cursor);
			let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
			let regArgsStart = 0;
			if (planningInfo && planningInfo.idxNum !== 0) {
				// (Compile VFilter arguments as before)
				const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
				planningInfo.aConstraintUsage.forEach((usage, constraintIdx) => {
					if (usage.argvIndex > 0) {
						const expr = planningInfo.constraintExpressions?.get(constraintIdx);
						if (!expr) throw new Error(`Internal error: Missing expression for constraint ${constraintIdx}`);
						while (argsToCompile.length < usage.argvIndex) { argsToCompile.push(null as any); }
						argsToCompile[usage.argvIndex - 1] = { constraintIdx, expr };
					}
				});
				const finalArgsToCompile = argsToCompile.filter(a => a !== null);
				if (finalArgsToCompile.length > 0) {
					regArgsStart = compiler.allocateMemoryCells(finalArgsToCompile.length);
					finalArgsToCompile.forEach((argInfo, i) => {
						const correlation = analyzeSubqueryCorrelation(compiler, argInfo.expr, activeOuterCursors);
						compiler.compileExpression(argInfo.expr, regArgsStart + i, correlation);
					});
				}
				// Minimal P4 object for VFilter
				filterP4 = {
					idxNum: planningInfo.idxNum,
					idxStr: planningInfo.idxStr,
					nArgs: finalArgsToCompile.length,
					aConstraint: planningInfo.aConstraint, // Use aConstraint from plan
					aConstraintUsage: planningInfo.aConstraintUsage,
				};
			}
			const vFilterEofAddr = compiler.allocateAddress(`vFilterEof[${index}]`);
			level.vFilterEofPlaceholder = vFilterEofAddr;
			compiler.emit(Opcode.VFilter, cursor, vFilterEofAddr, regArgsStart, filterP4, 0, `Filter/Scan Cursor ${index}`);
		}

		// Verify constraints *after* VFilter but *before* resolving the loop start placeholder
		compiler.verifyWhereConstraints(cursor, level.joinFailAddr!); // This might emit jumps

		// Now resolve the placeholder. Any jumps (e.g., from VNext) targeting the start
		// will now point to the VFilter instruction (or the first verify check).
		compiler.resolveAddress(placeholder); // Resolve the placeholder for this level

		// Compile JOIN condition (checks happen after VFilter/Verify)
		if (index > 0) {
			if (level.joinType !== 'cross') {
				// Call the moved helper function
				compileJoinCondition(compiler, level, joinLevels, index, level.joinFailAddr!); // This might emit jumps
			}
		}

		// Set match flag for outer LEFT JOIN
		if (index > 0) {
			const outerLevel = joinLevels[index - 1];
			if (outerLevel.joinType === 'left' && outerLevel.matchReg !== undefined) {
				compiler.emit(Opcode.Integer, 1, outerLevel.matchReg, 0, null, 0, `Set LEFT JOIN Match Flag [${index - 1}] = 1`);
			}
		}
		activeOuterCursors.add(cursor);
	}); // End of loop setup

	// --- Innermost Processing Setup --- //
	innermostProcessStartAddr = compiler.getCurrentAddress(); // Use method from compiler
	let innermostWhereFailTarget: number | undefined = undefined;
	if (stmt.where) {
		innermostWhereFailTarget = compiler.allocateAddress('innermostWhereFail');
		compileUnhandledWhereConditions(compiler, stmt.where, [...fromCursors], innermostWhereFailTarget);
	}

	// --- Call the Row Processing Callback --- //
	const callbackStartAddr = processRowCallback(
		compiler,
		stmt,
		joinLevels,
		activeOuterCursors,
		innermostWhereFailTarget // Pass potentially undefined placeholder
	);
	// innermostProcessStartAddr should logically be callbackStartAddr now

	// --- Jump to Loop Closing --- //
	// Placeholder for jump from end of innermost processing to start of loop closing
	const placeholderGotoLoopClose = compiler.allocateAddress('gotoLoopClose');
	compiler.emit(Opcode.Goto, 0, placeholderGotoLoopClose, 0, null, 0, "Goto Loop Closing");

	// Resolve WHERE fail target (jumps past row processing)
	if (innermostWhereFailTarget !== undefined) {
		compiler.resolveAddress(innermostWhereFailTarget);
		compiler.emit(Opcode.Goto, 0, placeholderGotoLoopClose, 0, null, 0, "WHERE Failed, Goto Loop Closing");
	}

	// --- Generate Loop Closing --- //
	compiler.resolveAddress(placeholderGotoLoopClose); // Resolve the jump from end of processing

	for (let i = joinLevels.length - 1; i >= 0; i--) {
		const level = joinLevels[i];
		const loopStartPlaceholder = loopStartPlaceholders[i]; // Retrieve placeholder for this level

		// Resolve join/where failure address - jumps *past* this level's closing logic
		compiler.resolveAddress(level.joinFailAddr!); // This is where IfFalse jumps land

		// Allocate eofAddr placeholder just before VNext uses it
		const eofAddrPlaceholder = compiler.allocateAddress(`vNextEof[${i}]`);
		level.eofAddr = eofAddrPlaceholder;
		compiler.emit(Opcode.VNext, level.cursor, eofAddrPlaceholder, 0, null, 0, `VNext Cursor ${i}`);
		// Use the *placeholder* for the loop start address here, it will be patched
		compiler.emit(Opcode.Goto, 0, loopStartPlaceholder, 0, null, 0, `Goto LoopStart Placeholder ${i}`); // Use placeholder
		compiler.resolveAddress(eofAddrPlaceholder); // Resolves the VNext jump target

		// Resolve the dedicated VFilter jump target to the same address as VNext's EOF target.
		if (level.vFilterEofPlaceholder !== undefined) {
			compiler.resolveAddress(level.vFilterEofPlaceholder);
		}

		// LEFT JOIN EOF NULL Padding
		if (level.joinType === 'left' && level.matchReg !== undefined) {
			// Call the moved helper function
			emitLeftJoinNullPadding(compiler, level, joinLevels, i, coreColumnMap, callbackStartAddr); // Pass coreColumnMap
		}

		// Reset match flag for the next outer iteration
		if (level.matchReg !== undefined) {
			compiler.emit(Opcode.Integer, 0, level.matchReg, 0, null, 0, `Reset LEFT JOIN Match Flag [${i}] before outer VNext/EOF`);
		}
		activeOuterCursors.delete(level.cursor);
	} // --- End loop closing --- //

	// Return necessary info for the orchestrator
	return { innermostLoopStartAddr: callbackStartAddr, innermostLoopEndAddrPlaceholder };
}
