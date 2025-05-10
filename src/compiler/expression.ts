import { StatusCode } from '../common/types.js';
import { SqliterError } from '../common/errors.js';
import type { Compiler } from './compiler.js';
import type { HavingContext } from './structs.js';
import type * as AST from '../parser/ast.js';
import { type SubqueryCorrelationResult } from './correlation.js';
import type { ArgumentMap } from './handlers.js';
// Import specific handlers
import { compileColumn, compileBinary, compileUnary, compileCast, compileFunction, compileParameter, compileCollate as compileCollateHandler } from './handlers.js';
import { compileLiteralValue } from './utils.js';
import { compileCaseExpression } from './case.js';
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
 * @param overrideCollation Optional collation to force for this expression and its children (used by COLLATE operator)
 */
export function compileExpression(
	compiler: Compiler,
	expr: AST.Expression,
	targetReg: number,
	correlation?: SubqueryCorrelationResult,
	havingContext?: HavingContext,
	argumentMap?: ArgumentMap,
	overrideCollation?: string
): void {
	switch (expr.type) {
		case 'literal': compileLiteralValue(compiler, expr.value, targetReg); break;
		case 'identifier': compileColumn(compiler, { type: 'column', name: expr.name, alias: expr.name }, targetReg, correlation, havingContext, argumentMap); break;
		case 'column': compileColumn(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'binary': compileBinary(compiler, expr, targetReg, correlation, havingContext, argumentMap, overrideCollation); break;
		case 'unary': compileUnary(compiler, expr, targetReg, correlation, havingContext, argumentMap, overrideCollation); break;
		case 'cast': compileCast(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'function': compileFunction(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'parameter': compileParameter(compiler, expr, targetReg); break;
		case 'subquery': compiler.compileSubquery(expr, targetReg); break;
		case 'collate': compileCollateHandler(compiler, expr, targetReg, correlation, havingContext, argumentMap, expr.collation.toUpperCase()); break;
		case 'case': compileCaseExpression(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		default:
			throw new SqliterError(`Unsupported expression type: ${(expr as any).type}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	}
}
