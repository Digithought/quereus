import type * as AST from '../parser/ast';
import { Opcode } from '../vdbe/opcodes';
import type { Compiler } from './compiler';
import type { SubqueryCorrelationResult } from './correlation';
import type { ArgumentMap } from './handlers';
import type { HavingContext } from './structs';

export function compileCaseExpression(
	compiler: Compiler,
	expr: AST.CaseExpr,
	targetReg: number,
	correlation?: SubqueryCorrelationResult,
	havingContext?: HavingContext,
	argumentMap?: ArgumentMap): void {
	const addrEndCase = compiler.allocateAddress('case_end');

	if (expr.baseExpr) {
		// --- Simple CASE: CASE baseExpr WHEN ... ---
		const regBase = compiler.allocateMemoryCells(1);
		compiler.compileExpression(expr.baseExpr, regBase, correlation, havingContext, argumentMap);

		for (let i = 0; i < expr.whenThenClauses.length; i++) {
			const clause = expr.whenThenClauses[i];
			const regWhen = compiler.allocateMemoryCells(1);
			const addrMatch = compiler.allocateAddress(`case_simple_${i}_match`);
			const addrNext = compiler.allocateAddress(`case_simple_${i}_next`);

			compiler.compileExpression(clause.when, regWhen, correlation, havingContext, argumentMap);
			// Compare base (p1) and when (p3), jump to addrMatch (p2) if equal
			compiler.emit(Opcode.Eq, regBase, addrMatch, regWhen, null, 0, `Compare CASE base EQ WHEN`);

			// Not equal, jump to check next WHEN clause
			compiler.emit(Opcode.Goto, 0, addrNext, 0, null, 0);

			// --- Match Found --- //
			compiler.resolveAddress(addrMatch);
			compiler.compileExpression(clause.then, targetReg, correlation, havingContext, argumentMap);
			compiler.emit(Opcode.Goto, 0, addrEndCase, 0, null, 0, 'Jump to END CASE (match)'); // Jump to end after THEN

			compiler.resolveAddress(addrNext); // Address to check the next WHEN

			// compiler.freeTempRegister(regWhen);
		}
		// compiler.freeTempRegister(regBase);
	} else {
		// --- Searched CASE: CASE WHEN ... ---
		for (let i = 0; i < expr.whenThenClauses.length; i++) {
			const clause = expr.whenThenClauses[i];
			const regWhenCond = compiler.allocateMemoryCells(1);
			const addrMatch = compiler.allocateAddress(`case_search_${i}_match`);
			const addrNext = compiler.allocateAddress(`case_search_${i}_next`);

			compiler.compileExpression(clause.when, regWhenCond, correlation, havingContext, argumentMap);
			// Check condition (p1), jump to addrMatch (p2) if true
			compiler.emit(Opcode.IfTrue, regWhenCond, addrMatch, 0, null, 0, 'Check WHEN condition');

			// Condition false, jump to check next WHEN clause
			compiler.emit(Opcode.Goto, 0, addrNext, 0, null, 0);

			// --- Match Found --- //
			compiler.resolveAddress(addrMatch);
			compiler.compileExpression(clause.then, targetReg, correlation, havingContext, argumentMap);
			compiler.emit(Opcode.Goto, 0, addrEndCase, 0, null, 0, 'Jump to END CASE (match)'); // Jump to end after THEN

			compiler.resolveAddress(addrNext); // Address to check the next WHEN

			// compiler.freeTempRegister(regWhenCond);
		}
	}

	// --- ELSE Clause or NULL --- //
	// If no WHEN condition was met, execution reaches here.
	if (expr.elseExpr) {
		compiler.compileExpression(expr.elseExpr, targetReg, correlation, havingContext, argumentMap);
	} else {
		compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, 'CASE result is NULL (no ELSE)');
	}

	// Resolve the final end address. All successful WHEN branches jump here.
	compiler.resolveAddress(addrEndCase);
}
