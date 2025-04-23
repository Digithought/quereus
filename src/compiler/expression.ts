import { Opcode, ConflictResolution } from '../common/constants';
import { StatusCode, type SqlValue } from '../common/types';
import { SqliteError } from '../common/errors';
import { createInstruction, type P4Vtab, type P4FuncDef } from '../vdbe/instruction';
import type { Compiler, HavingContext, SubroutineInfo } from './compiler';
import type * as AST from '../parser/ast';
import { analyzeSubqueryCorrelation, type SubqueryCorrelationResult, type CorrelatedColumnInfo } from './helpers';
import type { TableSchema } from '../schema/table';
// Note: Subquery compilation functions are now in subquery.ts

// New type for the argument map
export type ArgumentMap = ReadonlyMap<string, number>; // Key: "cursor.colIdx", Value: negative FP offset

export function compileExpression(compiler: Compiler, expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	switch (expr.type) {
		case 'literal': compiler.compileLiteral(expr, targetReg); break;
		case 'column': compiler.compileColumn(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'binary': compiler.compileBinary(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'unary': compiler.compileUnary(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'cast': compiler.compileCast(expr as AST.CastExpr, targetReg, correlation, havingContext, argumentMap); break;
		case 'function': compiler.compileFunction(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'parameter': compiler.compileParameter(expr, targetReg); break;
		case 'subquery': compiler.compileSubquery(expr, targetReg); break; // Calls wrapper in compiler.ts
		case 'identifier': compiler.compileColumn({ type: 'column', name: expr.name }, targetReg, correlation, havingContext, argumentMap); break;
		default:
			throw new SqliteError(`Unsupported expression type: ${(expr as any).type}`, StatusCode.ERROR);
	}
}

export function compileLiteral(compiler: Compiler, expr: AST.LiteralExpr, targetReg: number): void {
	const value = expr.value;
	if (value === null) {
		compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "NULL literal");
	} else if (typeof value === 'number') {
		if (Number.isSafeInteger(value)) {
			compiler.emit(Opcode.Integer, value, targetReg, 0, null, 0, `Integer literal: ${value}`);
		} else if (Number.isInteger(value)) {
			const constIdx = compiler.addConstant(BigInt(value));
			compiler.emit(Opcode.Int64, 0, targetReg, 0, constIdx, 0, `Large Integer literal: ${value}`);
		} else {
			const constIdx = compiler.addConstant(value);
			compiler.emit(Opcode.Real, 0, targetReg, 0, constIdx, 0, `Float literal: ${value}`);
		}
	} else if (typeof value === 'string') {
		const constIdx = compiler.addConstant(value);
		compiler.emit(Opcode.String8, 0, targetReg, 0, constIdx, 0, `String literal: '${value}'`);
	} else if (value instanceof Uint8Array) {
		const constIdx = compiler.addConstant(value);
		compiler.emit(Opcode.Blob, value.length, targetReg, 0, constIdx, 0, "BLOB literal");
	} else if (typeof value === 'bigint') { // Handle bigint literals explicitly
		const constIdx = compiler.addConstant(value);
		compiler.emit(Opcode.Int64, 0, targetReg, 0, constIdx, 0, `BigInt literal: ${value}`);
	}
	else {
		throw new SqliteError(`Unsupported literal type: ${typeof value}`, StatusCode.ERROR);
	}
}

export function compileColumn(compiler: Compiler, expr: AST.ColumnExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	// 1. Check if inside subroutine and if it matches a passed argument
	if (compiler.subroutineDepth > 0 && argumentMap) {
		const correlatedColInfo = correlation?.correlatedColumns.find(cc => {
			const outerSchema = compiler.tableSchemas.get(cc.outerCursor);
			const outerColName = outerSchema?.columns[cc.outerColumnIndex]?.name.toLowerCase();
			if (!outerColName) return false;

			if (expr.table) {
				const outerAlias = [...compiler.tableAliases.entries()].find(([_, cIdx]) => cIdx === cc.outerCursor)?.[0];
				const outerTableName = outerSchema?.name.toLowerCase();
				const exprTableLower = expr.table.toLowerCase();
				if (outerAlias?.toLowerCase() === exprTableLower || outerTableName === exprTableLower) {
					return outerColName === expr.name.toLowerCase();
				}
			} else {
				return outerColName === expr.name.toLowerCase();
			}
			return false;
		});

		if (correlatedColInfo) {
			const argKey = `${correlatedColInfo.outerCursor}.${correlatedColInfo.outerColumnIndex}`;
			const argOffset = argumentMap.get(argKey);
			if (argOffset !== undefined) {
				// Access argument using LoadOuterVar or direct FP offset?
				// Assuming direct FP offset for now (simpler, works if callee knows layout)
				compiler.emit(Opcode.SCopy, argOffset, targetReg, 0, null, 0, `Sub: Use outer arg ${expr.name} from FP[${argOffset}]`);
				return;
			} else {
				// This indicates a bug in correlation analysis or argument map creation
				console.warn(`Correlated column ${expr.name} identified but not found in argument map.`);
				// Fall through to normal resolution? Or throw error?
				// Throwing might be safer
				throw new SqliteError(`Internal error: Correlated column ${expr.name} not found in argument map.`);
			}
		}
	}

	// 2. Check HAVING context
	if (havingContext) {
		const colNameLower = expr.name.toLowerCase();
		// Correct check for alias: Access alias only if expr exists and has alias property
		const matchedCol = havingContext.finalColumnMap.find(info => {
			const exprAlias = (info.expr as any)?.alias?.toLowerCase(); // Check if alias exists
			return (exprAlias === colNameLower) ||
				(info.expr?.type === 'column' && !(info.expr as any)?.alias && info.expr.name.toLowerCase() === colNameLower); // Match unaliased name
		});

		if (matchedCol) {
			compiler.emit(Opcode.SCopy, matchedCol.targetReg, targetReg, 0, null, 0, `HAVING: Use grouped/aggregated col '${expr.name}' from reg ${matchedCol.targetReg}`);
			return;
		}
		throw new SqliteError(`Column "${expr.name}" must appear in the GROUP BY clause or be used in an aggregate function`, StatusCode.ERROR);
	}

	// 3. Default behavior (WHERE, SELECT list, non-correlated subquery part, etc.)
	let cursor = -1;
	let colIdx = -1;
	let tableSchema: TableSchema | undefined; // Added import type

	if (expr.table) {
		const aliasOrTableName = expr.table.toLowerCase();
		const foundCursor = compiler.tableAliases.get(aliasOrTableName);
		if (foundCursor === undefined) {
			throw new SqliteError(`Table or alias not found: ${expr.table}`, StatusCode.ERROR);
		}
		cursor = foundCursor;
		tableSchema = compiler.tableSchemas.get(cursor);
		if (!tableSchema) { throw new SqliteError(`Internal error: Schema not found for cursor ${cursor}`, StatusCode.INTERNAL); }
		const potentialColIdx = tableSchema.columnIndexMap.get(expr.name.toLowerCase());
		if (potentialColIdx === undefined) {
			if (expr.name.toLowerCase() === 'rowid' && tableSchema.primaryKeyDefinition.length === 0) {
				colIdx = -1;
			} else {
				throw new SqliteError(`Column not found in table ${expr.table}: ${expr.name}`, StatusCode.ERROR);
			}
		} else {
			colIdx = potentialColIdx;
		}

	} else {
		let foundCount = 0;
		let potentialCursor = -1;
		let potentialColIdx = -1;
		let potentialSchema: TableSchema | undefined;

		// Iterate through currently active aliases in the *compiler's* context
		for (const [alias, cursorId] of compiler.tableAliases.entries()) {
			// If inside a subroutine, we should only resolve against cursors
			// belonging to the subroutine's scope, not outer scopes.
			// However, compileSelectCore sets up aliases before calling compileExpression.
			// Assume compiler.tableAliases correctly represents the current scope.
			const schema = compiler.tableSchemas.get(cursorId);
			if (schema) {
				const idx = schema.columnIndexMap.get(expr.name.toLowerCase());
				if (idx !== undefined) {
					if (potentialCursor !== -1) {
						throw new SqliteError(`Ambiguous column name: ${expr.name}. Qualify with table name or alias.`, StatusCode.ERROR);
					}
					potentialCursor = cursorId;
					potentialColIdx = idx;
					potentialSchema = schema;
					foundCount++;
				} else if (expr.name.toLowerCase() === 'rowid' && schema.primaryKeyDefinition.length === 0) {
					if (potentialCursor !== -1) {
						throw new SqliteError(`Ambiguous column name: ${expr.name} (rowid). Qualify with table name or alias.`, StatusCode.ERROR);
					}
					potentialCursor = cursorId;
					potentialColIdx = -1;
					potentialSchema = schema;
					foundCount++;
				}
			}
		}

		if (potentialCursor === -1) {
			throw new SqliteError(`Column not found: ${expr.name}`, StatusCode.ERROR);
		}
		cursor = potentialCursor;
		colIdx = potentialColIdx;
		tableSchema = potentialSchema;
	}

	if (!tableSchema) { throw new Error("Internal: Schema resolution failed"); }

	if (tableSchema.isVirtual) {
		compiler.emit(Opcode.VColumn, cursor, colIdx, targetReg, 0, 0, `Get column: ${tableSchema.name}.${expr.name} (idx ${colIdx})`);
	} else {
		throw new SqliteError("Regular tables not implemented", StatusCode.ERROR);
	}
}

export function compileBinary(compiler: Compiler, expr: AST.BinaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	if (expr.right.type === 'subquery') {
		const subQuery = expr.right.query;
		switch (expr.operator.toUpperCase()) {
			case 'IN': compiler.compileInSubquery(expr.left, subQuery, targetReg, false /*, correlation, argumentMap*/); return; // Fix: Adjusted arguments
			case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				compiler.compileComparisonSubquery(expr.left, expr.operator, subQuery, targetReg /*, correlation, argumentMap*/); return; // Fix: Adjusted arguments
			default: throw new SqliteError(`Operator '${expr.operator}' cannot be used with a subquery on the right side.`, StatusCode.ERROR);
		}
	}
	const leftReg = compiler.allocateMemoryCells(1);
	const rightReg = compiler.allocateMemoryCells(1);
	compiler.compileExpression(expr.left, leftReg, correlation, havingContext, argumentMap);
	compiler.compileExpression(expr.right, rightReg, correlation, havingContext, argumentMap);
	switch (expr.operator.toUpperCase()) {
		case '+': compiler.emit(Opcode.Add, leftReg, rightReg, targetReg, null, 0, "Add"); break;
		case '-': compiler.emit(Opcode.Subtract, leftReg, rightReg, targetReg, null, 0, "Subtract"); break;
		case '*': compiler.emit(Opcode.Multiply, leftReg, rightReg, targetReg, null, 0, "Multiply"); break;
		case '/': compiler.emit(Opcode.Divide, leftReg, rightReg, targetReg, null, 0, "Divide"); break;
		case '%': compiler.emit(Opcode.Remainder, leftReg, rightReg, targetReg, null, 0, "Remainder"); break;
		case '||': compiler.emit(Opcode.Concat, leftReg, rightReg, targetReg, null, 0, "Concat"); break;
		case '&': compiler.emit(Opcode.BitAnd, leftReg, rightReg, targetReg, null, 0, "BitAnd"); break;
		case '|': compiler.emit(Opcode.BitOr, leftReg, rightReg, targetReg, null, 0, "BitOr"); break;
		case '<<': compiler.emit(Opcode.ShiftLeft, rightReg, leftReg, targetReg, null, 0, "ShiftLeft"); break;
		case '>>': compiler.emit(Opcode.ShiftRight, rightReg, leftReg, targetReg, null, 0, "ShiftRight"); break;
		case 'AND': {
			// AND: Evaluate left. If false/null, result is left. Otherwise, result is right.
			const addrIsRight = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();
			compiler.emit(Opcode.SCopy, leftReg, targetReg, 0, null, 0, "AND: Copy left initially");
			compiler.emit(Opcode.IfTrue, leftReg, addrIsRight, 0, null, 0, "AND: If left is true, evaluate right");
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0, "AND: Left is false/null, finish"); // Left is false/null, result is left
			compiler.resolveAddress(addrIsRight);
			compiler.emit(Opcode.SCopy, rightReg, targetReg, 0, null, 0, "AND: Copy right as result");
			compiler.resolveAddress(addrEnd);
			break;
		}
		case 'OR': {
			// OR: Evaluate left. If true, result is left. Otherwise, result is right.
			const addrIsRight = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();
			compiler.emit(Opcode.SCopy, leftReg, targetReg, 0, null, 0, "OR: Copy left initially");
			compiler.emit(Opcode.IfTrue, leftReg, addrEnd, 0, null, 0, "OR: If left is true, finish"); // Left is true, result is left
			compiler.resolveAddress(addrIsRight); // Only executed if left is false/null
			compiler.emit(Opcode.SCopy, rightReg, targetReg, 0, null, 0, "OR: Copy right as result");
			compiler.resolveAddress(addrEnd);
			break;
		}
		case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=': case 'IS': case 'IS NOT': {
			let compareOp: Opcode;
			let resultIfTrue = 1;
			let resultIfFalse = 0;
			let handleNull = false;
			let jumpOpcode: Opcode | null = null; // Opcode to jump if comparison is true

			switch (expr.operator.toUpperCase()) {
				case '=': case '==': compareOp = Opcode.Eq; jumpOpcode = Opcode.Eq; handleNull = true; break;
				case 'IS': compareOp = Opcode.Eq; jumpOpcode = Opcode.Eq; handleNull = false; break; // IS handles NULL differently
				case '!=': case '<>': compareOp = Opcode.Ne; jumpOpcode = Opcode.Ne; handleNull = true; break;
				case 'IS NOT': compareOp = Opcode.Ne; jumpOpcode = Opcode.Ne; handleNull = false; break; // IS NOT handles NULL differently
				case '<': compareOp = Opcode.Lt; jumpOpcode = Opcode.Lt; handleNull = true; break;
				case '<=': compareOp = Opcode.Le; jumpOpcode = Opcode.Le; handleNull = true; break;
				case '>': compareOp = Opcode.Gt; jumpOpcode = Opcode.Gt; handleNull = true; break;
				case '>=': compareOp = Opcode.Ge; jumpOpcode = Opcode.Ge; handleNull = true; break;
				default: throw new Error("Impossible operator");
			}

			const addrIsTrue = compiler.allocateAddress();
			const addrSetNull = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();

			// Handle NULL operands for operators other than IS/IS NOT
			if (handleNull) {
				compiler.emit(Opcode.IfNull, leftReg, addrSetNull, 0, null, 0, `Compare: If left NULL, jump to set NULL`);
				compiler.emit(Opcode.IfNull, rightReg, addrSetNull, 0, null, 0, `Compare: If right NULL, jump to set NULL`);
			}

			// Perform comparison and jump if true
			compiler.emit(jumpOpcode, leftReg, addrIsTrue, rightReg, null, 0, `Compare ${expr.operator}`);

			// Comparison is false
			compiler.emit(Opcode.Integer, resultIfFalse, targetReg, 0, null, 0, `Compare: Set result ${resultIfFalse}`);
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

			// Comparison is true
			compiler.resolveAddress(addrIsTrue);
			compiler.emit(Opcode.Integer, resultIfTrue, targetReg, 0, null, 0, `Compare: Set result ${resultIfTrue}`);
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

			// Set NULL result if needed
			if (handleNull) {
				compiler.resolveAddress(addrSetNull);
				compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Compare: Set result NULL`);
			}

			compiler.resolveAddress(addrEnd);
			break;
		}
		default:
			throw new SqliteError(`Unsupported binary operator: ${expr.operator}`, StatusCode.ERROR);
	}
}

export function compileUnary(compiler: Compiler, expr: AST.UnaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	if (expr.operator.toUpperCase() === 'NOT' && expr.expr.type === 'binary' && expr.expr.operator.toUpperCase() === 'IN' && expr.expr.right.type === 'subquery') {
		compiler.compileInSubquery(expr.expr.left, expr.expr.right.query, targetReg, true /*, correlation, argumentMap*/); // Fix: Adjusted arguments
		return;
	}
	if (expr.operator.toUpperCase() === 'NOT' && expr.expr.type === 'subquery') {
		// NOT EXISTS subquery
		compiler.compileExistsSubquery(expr.expr.query, targetReg /*, correlation, argumentMap*/); // Fix: Adjusted arguments
		// Invert the boolean result (0 -> 1, 1 -> 0, NULL remains NULL)
		const addrIsNull = compiler.allocateAddress();
		const addrEnd = compiler.allocateAddress();
		compiler.emit(Opcode.IfNull, targetReg, addrEnd, 0, null, 0, "NOT EXISTS: Skip if NULL");
		compiler.emit(Opcode.Not, targetReg, targetReg, 0, null, 0, "NOT EXISTS: Invert boolean"); // Requires Opcode.Not implementation
		compiler.resolveAddress(addrEnd);
		return;
	}
	// Handle EXISTS directly
	if (expr.operator.toUpperCase() === 'EXISTS' && expr.expr.type === 'subquery') {
		compiler.compileExistsSubquery(expr.expr.query, targetReg /*, correlation, argumentMap*/); // Fix: Adjusted arguments
		return;
	}
	// Handle IS NULL / IS NOT NULL (Note: 'is'/'is not' are binary in AST)
	if (expr.operator.toUpperCase() === 'IS NULL') {
		const operandReg = compiler.allocateMemoryCells(1);
		compiler.compileExpression(expr.expr, operandReg, correlation, havingContext, argumentMap);
		compiler.emit(Opcode.IsNull, operandReg, targetReg, 0, null, 0, "Check IS NULL");
		return;
	}
	if (expr.operator.toUpperCase() === 'IS NOT NULL') {
		const operandReg = compiler.allocateMemoryCells(1);
		compiler.compileExpression(expr.expr, operandReg, correlation, havingContext, argumentMap);
		compiler.emit(Opcode.NotNull, operandReg, targetReg, 0, null, 0, "Check IS NOT NULL");
		return;
	}

	// Standard unary operators
	const operandReg = compiler.allocateMemoryCells(1);
	compiler.compileExpression(expr.expr, operandReg, correlation, havingContext, argumentMap);
	switch (expr.operator.toUpperCase()) {
		case '-': compiler.emit(Opcode.Negative, operandReg, targetReg, 0, null, 0, "Unary Minus"); break;
		case '+': compiler.emit(Opcode.SCopy, operandReg, targetReg, 0, null, 0, "Unary Plus (no-op)"); break;
		case '~': compiler.emit(Opcode.BitNot, operandReg, targetReg, 0, null, 0, "Bitwise NOT"); break;
		case 'NOT':
			// Standard boolean NOT (handles NULL correctly)
			// Result = (operand == 0) ? 1 : (operand IS NULL ? NULL : 0)
			const addrIsNull = compiler.allocateAddress();
			const addrSetTrue = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();

			// Compile operand
			const notOperandReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(expr.expr, notOperandReg, correlation, havingContext, argumentMap);

			// Check for NULL operand -> NULL result
			compiler.emit(Opcode.IfNull, notOperandReg, addrIsNull, 0, null, 0, "NOT: Check if operand is NULL");

			// Check if operand is FALSE (0 or 0.0) -> TRUE result (1)
			compiler.emit(Opcode.IfZero, notOperandReg, addrSetTrue, 0, null, 0, "NOT: Check if operand is 0 (false)");

			// Operand was TRUE (non-zero) -> FALSE result (0)
			compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "NOT: Set result 0 (operand was true)");
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

			// Set TRUE result path
			compiler.resolveAddress(addrSetTrue);
			compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "NOT: Set result 1 (operand was false)");
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

			// Set NULL result path
			compiler.resolveAddress(addrIsNull);
			compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "NOT: Set result NULL (operand was NULL)");

			compiler.resolveAddress(addrEnd);
			break;
		default: throw new SqliteError(`Unsupported unary operator: ${expr.operator}`, StatusCode.ERROR);
	}
}

export function compileCast(compiler: Compiler, expr: AST.CastExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	compiler.compileExpression(expr.expr, targetReg, correlation, havingContext, argumentMap);
	const targetType = expr.targetType.toUpperCase();
	let affinityChar: string;
	if (targetType.includes('CHAR') || targetType.includes('CLOB') || targetType.includes('TEXT')) { affinityChar = 't'; }
	else if (targetType.includes('INT')) { affinityChar = 'i'; }
	else if (targetType.includes('BLOB')) { affinityChar = 'b'; }
	else if (targetType.includes('REAL') || targetType.includes('FLOA') || targetType.includes('DOUB')) { affinityChar = 'r'; }
	else { affinityChar = 'n'; } // NUMERIC/NONE
	compiler.emit(Opcode.Affinity, targetReg, 1, 0, affinityChar, 0, `CAST to ${targetType}`);
}

export function compileFunction(compiler: Compiler, expr: AST.FunctionExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	if (havingContext) {
		// Try to find a matching aggregate result column
		const matchedAgg = havingContext.finalColumnMap.find(info =>
			info.expr?.type === 'function' &&
			info.expr.name.toLowerCase() === expr.name.toLowerCase() &&
			JSON.stringify(info.expr.args) === JSON.stringify(expr.args) // Simple arg comparison
		);
		if (matchedAgg) {
			compiler.emit(Opcode.SCopy, matchedAgg.targetReg, targetReg, 0, null, 0, `HAVING: Use aggregated func '${expr.name}' from reg ${matchedAgg.targetReg}`);
			return;
		}
	}

	// Compile arguments first
	const argRegs = compiler.allocateMemoryCells(expr.args.length || 1); // Allocate at least 1 if no args
	for (let i = 0; i < expr.args.length; i++) {
		compiler.compileExpression(expr.args[i], argRegs + i, correlation, havingContext, argumentMap);
	}

	// Find the function definition
	const funcDef = compiler.db._findFunction(expr.name, expr.args.length);
	if (!funcDef) { throw new SqliteError(`Function not found: ${expr.name}/${expr.args.length}`, StatusCode.ERROR); }

	const isAggregate = !!(funcDef.xStep && funcDef.xFinal);

	// If called in a non-aggregate context (no havingContext) but is an aggregate function -> error
	if (isAggregate && !havingContext) {
		// Aggregates used as scalars outside of aggregate queries evaluate to NULL (or error depending on strictness)
		// Let's emit NULL for now, consistent with some SQL dialects
		compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Aggregate func ${expr.name} in scalar context -> NULL`);
		// Alternatively, throw an error:
		// throw new SqliteError(`Aggregate function ${expr.name} used in non-aggregate context`, StatusCode.ERROR);
	}
	// If it's a scalar function (or an aggregate called within HAVING where it references a computed value)
	else if (funcDef.xFunc) {
		const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: expr.args.length };
		compiler.emit(Opcode.Function, argRegs, funcDef.numArgs, targetReg, p4, 0, `Call func: ${expr.name}`); // Pass argRegs as P1?
	}
	else if (isAggregate && havingContext && !funcDef.xFunc) {
		// This case means an aggregate function was found in HAVING, but it wasn't pre-computed.
		// This shouldn't happen if the HAVING clause correctly references aggregate results.
		throw new SqliteError(`Aggregate function ${funcDef.name} used incorrectly in HAVING clause.`, StatusCode.ERROR);
	} else {
		// Should not be reachable if function definition is valid
		throw new SqliteError(`Invalid function call context for ${funcDef.name}`, StatusCode.INTERNAL);
	}
}

export function compileParameter(compiler: Compiler, expr: AST.ParameterExpr, targetReg: number): void {
	const key = expr.name || expr.index!;
	// Register parameter and its target register (absolute index)
	compiler.parameters.set(key, { memIdx: targetReg });
	// Emit placeholder - VDBE applyBindings will overwrite this before execution
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Parameter placeholder: ${key} -> R[${targetReg}]`);
}

export function compileSubquery(compiler: Compiler, expr: AST.SubqueryExpr, targetReg: number): void {
	// This function is usually called for subqueries used as expressions (scalar, comparison).
	// EXISTS and IN are typically handled by parent Unary/Binary expression compilers.
	console.warn("compileSubquery assuming scalar context. EXISTS/IN should be handled by parent expression compiler.");
	compiler.compileScalarSubquery(expr.query, targetReg);
}
