import { StatusCode } from '../common/types.js';
import { SqliteError } from '../common/errors.js';
import type { Compiler } from './compiler.js';
import type { HavingContext } from './structs.js';
import type * as AST from '../parser/ast.js';
import { type SubqueryCorrelationResult } from './correlation.js';
import type { ArgumentMap } from './handlers.js';
import { Opcode } from '../vdbe/opcodes.js';
// Import specific handlers
import { compileColumn, compileBinary, compileUnary, compileCast, compileFunction, compileParameter, compileCollate } from './handlers.js';
import { compileLiteralValue } from './utils.js';
// Subquery compilation is delegated differently in Compiler class, handled there.
// No need to import subquery handlers here.

/**
 * Main dispatcher for compiling any expression AST node.
 * Delegates to specific handlers in ./expression/handlers.ts
 *
 * @param compiler The compiler instance
 * @param expr The expression to compile
 * @param targetReg The register to store the result
 * @param correlation Optional correlation info for subqueries
 * @param havingContext Optional HAVING clause context
 * @param argumentMap Optional mapping of argument names to registers
 */
export function compileExpression(compiler: Compiler, expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	switch (expr.type) {
		case 'literal': compileLiteralValue(compiler, expr.value, targetReg); break;
		case 'identifier': compileColumn(compiler, { type: 'column', name: expr.name, alias: expr.name }, targetReg, correlation, havingContext, argumentMap); break; // Treat identifier as column
		case 'column': compileColumn(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'binary': compileBinary(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'unary': compileUnary(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'cast': compileCast(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'function': compileFunction(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'parameter': compileParameter(compiler, expr, targetReg); break;
		case 'subquery': compiler.compileSubquery(expr, targetReg); break; // Delegate subquery via compiler instance method
		case 'collate': compileCollate(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'case': compileCaseExpression(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		default:
			throw new SqliteError(`Unsupported expression type: ${(expr as any).type}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	}
}

function compileCaseExpression(
	compiler: Compiler,
	expr: AST.CaseExpr,
	targetReg: number,
	correlation?: SubqueryCorrelationResult,
	havingContext?: HavingContext,
	argumentMap?: ArgumentMap
): void {
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

// No need to export handlers or utils directly from here, they are imported by this module or delegated by Compiler class.
