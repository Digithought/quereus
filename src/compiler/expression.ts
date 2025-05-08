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
	let regBase = -1;

	if (expr.baseExpr) {
		regBase = compiler.allocateMemoryCells(1);
		compiler.compileExpression(expr.baseExpr, regBase, correlation, havingContext, argumentMap);
	}

	for (let i = 0; i < expr.whenThenClauses.length; i++) {
		const clause = expr.whenThenClauses[i];
		const regWhen = compiler.allocateMemoryCells(1);
		const addrNextWhen = compiler.allocateAddress(`case_when_${i}_next`);

		compiler.compileExpression(clause.when, regWhen, correlation, havingContext, argumentMap);

		if (regBase !== -1) { // Simple CASE: CASE base WHEN val THEN ...
			const regCmpResult = compiler.allocateMemoryCells(1);
			// Compare regBase with regWhen. Assuming Opcode.Eq sets regCmpResult to 1 if equal, 0 otherwise.
			// Or use Compare and then If. For simplicity, let's assume an Eq-like opcode or a sequence.
			compiler.emit(Opcode.Eq, regBase, regWhen, regCmpResult, null, 0, `Compare CASE base with WHEN`);
			compiler.emit(Opcode.IfFalse, regCmpResult, addrNextWhen, 0, null, 0, 'If not equal, jump to next WHEN');
			// compiler.freeTempRegister(regCmpResult); // If using true temp registers
		} else { // Searched CASE: CASE WHEN cond THEN ...
			compiler.emit(Opcode.IfFalse, regWhen, addrNextWhen, 0, null, 0, 'If WHEN condition is false, jump to next WHEN');
		}

		// Condition was true, compile THEN expression and jump to end
		compiler.compileExpression(clause.then, targetReg, correlation, havingContext, argumentMap);
		compiler.emit(Opcode.Goto, 0, addrEndCase, 0, null, 0, 'Jump to END CASE');

		compiler.resolveAddress(addrNextWhen);
		// compiler.freeTempRegister(regWhen); // If using true temp registers
	}

	if (regBase !== -1) {
		// compiler.freeTempRegister(regBase); // If using true temp registers
	}

	// If all WHEN conditions were false
	if (expr.elseExpr) {
		compiler.compileExpression(expr.elseExpr, targetReg, correlation, havingContext, argumentMap);
	} else {
		compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, 'CASE result is NULL (no ELSE)');
	}

	compiler.resolveAddress(addrEndCase);
}

// No need to export handlers or utils directly from here, they are imported by this module or delegated by Compiler class.
