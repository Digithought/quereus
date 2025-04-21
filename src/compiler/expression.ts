import { Opcode, ConflictResolution } from '../common/constants';
import { StatusCode, type SqlValue } from '../common/types';
import { SqliteError } from '../common/errors';
import { createInstruction, type P4Vtab, type P4FuncDef } from '../vdbe/instruction';
import type { Compiler, HavingContext, SubroutineInfo } from './compiler';
import type * as AST from '../parser/ast';
import type { TableSchema } from '../schema/table';
import { analyzeSubqueryCorrelation, type SubqueryCorrelationResult, type CorrelatedColumnInfo } from './helpers';

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
		case 'subquery': compiler.compileSubquery(expr, targetReg); break;
		case 'identifier': compiler.compileColumn({ type: 'column', name: expr.name }, targetReg, correlation, havingContext, argumentMap); break;
		default:
			const _exhaustiveCheck: never = expr;
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
				compiler.emit(Opcode.SCopy, argOffset, targetReg, 0, null, 0, `Sub: Use outer arg ${expr.name} from FP[${argOffset}]`);
				return;
			} else {
				console.warn(`Correlated column ${expr.name} identified but not found in argument map.`);
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
				(info.expr?.type === 'column' && !info.expr.alias && info.expr.name.toLowerCase() === colNameLower); // Match unaliased name
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
	let tableSchema: TableSchema | undefined;

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
			if (expr.name.toLowerCase() === 'rowid' && tableSchema.primaryKeyColumns.length === 0) {
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
				} else if (expr.name.toLowerCase() === 'rowid' && schema.primaryKeyColumns.length === 0) {
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
			case 'IN': compiler.compileInSubquery(expr.left, subQuery, targetReg, false); return;
			case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				compiler.compileComparisonSubquery(expr.left, expr.operator, subQuery, targetReg); return;
			default: throw new SqliteError(`Operator '${expr.operator}' cannot be used with a subquery on the right side.`, StatusCode.ERROR);
		}
	}
	const leftReg = compiler.allocateMemoryCells(1);
	const rightReg = compiler.allocateMemoryCells(1);
	compileExpression(compiler, expr.left, leftReg, correlation, havingContext, argumentMap);
	compileExpression(compiler, expr.right, rightReg, correlation, havingContext, argumentMap);
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
		case 'AND':
			compiler.emit(Opcode.SCopy, leftReg, targetReg, 0, null, 0, "AND: Copy left");
			compiler.emit(Opcode.SCopy, rightReg, targetReg, 0, null, 0, "AND: Copy right");
			break;
		case 'OR':
			compiler.emit(Opcode.SCopy, leftReg, targetReg, 0, null, 0, "OR: Copy left");
			compiler.emit(Opcode.SCopy, rightReg, targetReg, 0, null, 0, "OR: Copy right");
			break;
		case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=': case 'IS': case 'IS NOT':
			let compareOp: Opcode;
			switch (expr.operator.toUpperCase()) {
				case '=': case '==': case 'IS': compareOp = Opcode.Eq; break;
				case '!=': case '<>': case 'IS NOT': compareOp = Opcode.Ne; break;
				case '<': compareOp = Opcode.Lt; break;
				case '<=': compareOp = Opcode.Le; break;
				case '>': compareOp = Opcode.Gt; break;
				case '>=': compareOp = Opcode.Ge; break;
				default: throw new Error("Impossible operator");
			}
			compiler.emit(compareOp, leftReg, rightReg, targetReg, null, 0, `Compare ${expr.operator}`);
			break;
		default:
			throw new SqliteError(`Unsupported binary operator: ${expr.operator}`, StatusCode.ERROR);
	}
}

export function compileUnary(compiler: Compiler, expr: AST.UnaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	if (expr.operator.toUpperCase() === 'NOT' && expr.expr.type === 'binary' && expr.expr.operator.toUpperCase() === 'IN' && expr.expr.right.type === 'subquery') {
		compiler.compileInSubquery(expr.expr.left, expr.expr.right.query, targetReg, true);
		return;
	}
	if (expr.operator.toUpperCase() === 'NOT' && expr.expr.type === 'subquery') {
		compiler.compileExistsSubquery(expr.expr.query, targetReg);
		return;
	}
	// Handle EXISTS directly
	if (expr.operator.toUpperCase() === 'EXISTS' && expr.expr.type === 'subquery') {
		compiler.compileExistsSubquery(expr.expr.query, targetReg);
		return;
	}
	// Handle IS NULL / IS NOT NULL (Note: 'is'/'is not' are binary in AST)
	if (expr.operator.toUpperCase() === 'IS NULL') {
		const operandReg = compiler.allocateMemoryCells(1);
		compileExpression(compiler, expr.expr, operandReg, correlation, havingContext, argumentMap);
		compiler.emit(Opcode.IsNull, operandReg, targetReg, 0, null, 0, "Check IS NULL");
		return;
	}
	if (expr.operator.toUpperCase() === 'IS NOT NULL') {
		const operandReg = compiler.allocateMemoryCells(1);
		compileExpression(compiler, expr.expr, operandReg, correlation, havingContext, argumentMap);
		compiler.emit(Opcode.NotNull, operandReg, targetReg, 0, null, 0, "Check IS NOT NULL");
		return;
	}

	// Standard unary operators
	const operandReg = compiler.allocateMemoryCells(1);
	compileExpression(compiler, expr.expr, operandReg, correlation, havingContext, argumentMap);
	switch (expr.operator.toUpperCase()) {
		case '-': compiler.emit(Opcode.Negative, operandReg, targetReg, 0, null, 0, "Unary Minus"); break;
		case '+': compiler.emit(Opcode.SCopy, operandReg, targetReg, 0, null, 0, "Unary Plus (no-op)"); break;
		case '~': compiler.emit(Opcode.BitNot, operandReg, targetReg, 0, null, 0, "Bitwise NOT"); break;
		case 'NOT':
			// Standard boolean NOT (handles NULL correctly via IfFalse)
			const addrSetTrue_std = compiler.allocateAddress();
			const addrEnd_std = compiler.allocateAddress();
			compiler.emit(Opcode.IfFalse, operandReg, addrSetTrue_std, 0, null, 0, "NOT: If operand is false/null, jump to set true");
			compiler.emit(Opcode.Goto, 0, addrEnd_std, 0, null, 0);
			break;
		default: throw new SqliteError(`Unsupported unary operator: ${expr.operator}`, StatusCode.ERROR);
	}
}

export function compileCast(compiler: Compiler, expr: AST.CastExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	compileExpression(compiler, expr.expr, targetReg, correlation, havingContext, argumentMap);
	const targetType = expr.targetType.toUpperCase();
	let affinityChar: string;
	if (targetType.includes('CHAR') || targetType.includes('CLOB') || targetType.includes('TEXT')) { affinityChar = 't'; }
	else if (targetType.includes('INT')) { affinityChar = 'i'; }
	else if (targetType.includes('BLOB')) { affinityChar = 'b'; }
	else if (targetType.includes('REAL') || targetType.includes('FLOA') || targetType.includes('DOUB')) { affinityChar = 'r'; }
	else { affinityChar = 'n'; }
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
	const argRegs = compiler.allocateMemoryCells(expr.args.length || 1);
	for (let i = 0; i < expr.args.length; i++) {
		compileExpression(compiler, expr.args[i], argRegs + i, correlation, havingContext, argumentMap);
	}

	// Find the function definition
	const funcDef = compiler.db._findFunction(expr.name, expr.args.length);
	if (!funcDef) { throw new SqliteError(`Function not found: ${expr.name}/${expr.args.length}`, StatusCode.ERROR); }

	const isAggregate = !!(funcDef.xStep && funcDef.xFinal);

	// If called in a non-aggregate context (no havingContext) but is an aggregate function -> error
	if (isAggregate && !havingContext) {
		compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Placeholder for aggregate ${expr.name} result`);
	}
	// If it's a scalar function (or an aggregate called within HAVING)
	else if (funcDef.xFunc) {
		const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: expr.args.length };
		compiler.emit(Opcode.Function, 0, argRegs, targetReg, p4, 0, `Call func: ${expr.name}`);
	}
	else if (isAggregate && havingContext && !funcDef.xFunc) {
		throw new SqliteError(`Aggregate function ${funcDef.name} used incorrectly in HAVING clause.`, StatusCode.ERROR);
	} else {
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

// --- Uncorrelated version (mostly unchanged) ---
function compileUncorrelatedScalarSubquery(compiler: Compiler, subQuery: AST.SelectStmt, targetReg: number): void {
	if (subQuery.columns.length !== 1 || subQuery.columns[0].type === 'all') {
		throw new SqliteError("Scalar subquery must return exactly one column (cannot be *)", StatusCode.ERROR);
	}
	const regHasRow = compiler.allocateMemoryCells(1);
	const addrLoopStart = compiler.allocateAddress();
	const addrLoopEnd = compiler.allocateAddress();
	const addrErrorTooMany = compiler.allocateAddress();
	const addrFinalize = compiler.allocateAddress();
	const addrSetNull = compiler.allocateAddress();

	compiler.emit(Opcode.Integer, 0, regHasRow, 0, null, 0, "Init Subquery: hasRow=0");
	// --- Compile subquery core directly ---
	const subQueryCursors: number[] = [];
	const { resultBaseReg: subqueryResultBase, numCols } = compiler.compileSelectCore(subQuery, subQueryCursors, undefined, undefined);
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
		compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "Subquery: Loop");
	}

	compiler.closeCursorsUsedBySelect(subQueryCursors);

	// Final result check
	compiler.emit(Opcode.IfFalse, regHasRow, addrSetNull, 0, null, 0, "Subquery: Check if hasRow is false (0 rows)");
	compiler.emit(Opcode.Goto, 0, addrFinalize, 0, null, 0, "Subquery: Finish (1 row)");
	compiler.resolveAddress(addrErrorTooMany);
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "Set comparison NULL");
	compiler.resolveAddress(addrFinalize);
}
// -------------------------------------

// --- Correlated version (Updated for argument map & fixes) ---
function compileCorrelatedScalarSubquery(compiler: Compiler, subQuery: AST.SelectStmt, targetReg: number, correlation: SubqueryCorrelationResult): void {
	let subInfo: SubroutineInfo | undefined = compiler.subroutineDefs?.get(subQuery);

	if (!subInfo) {
		compiler.startSubroutineCompilation();
		const subStartAddress = compiler.getCurrentAddress();
		const regSubResult = compiler.allocateMemoryCells(1);
		const regSubHasRow = compiler.allocateMemoryCells(1);
		const regSubError = compiler.allocateMemoryCells(1);

		const argumentMap: Map<string, number> = new Map();
		correlation.correlatedColumns.forEach((cc, index) => {
			const argOffset = -(index + 1);
			argumentMap.set(`${cc.outerCursor}.${cc.outerColumnIndex}`, argOffset);
		});

		const subQueryCursors: number[] = [];
		const { resultBaseReg, numCols } = compiler.compileSelectCore(subQuery, subQueryCursors, undefined, undefined);
		if (numCols !== 1) throw new SqliteError("Correlated scalar subquery must return one column", StatusCode.INTERNAL);

		const addrSubLoopStart = compiler.allocateAddress();
		const addrSubLoopEnd = compiler.allocateAddress();
		const addrSubErrorTooMany = compiler.allocateAddress();
		const addrSubFinalize = compiler.allocateAddress();
		const addrSubSetNull = compiler.allocateAddress();
		const firstSubCursor = subQueryCursors[0];

		compiler.emit(Opcode.Integer, 0, regSubHasRow, 0, null, 0, "Sub: Init hasRow=0");
		compiler.emit(Opcode.Integer, 0, regSubError, 0, null, 0, "Sub: Init error=0");

		const vnextJumpTarget = compiler.allocateAddress();

		if (firstSubCursor !== undefined) {
			compiler.emit(Opcode.VFilter, firstSubCursor, addrSubLoopEnd, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "Sub: Start scan");
			compiler.resolveAddress(addrSubLoopStart);
			compiler.emit(Opcode.IfTrue, regSubError, vnextJumpTarget, 0, null, 0, "Sub: Skip if error already set");
			compiler.emit(Opcode.IfTrue, regSubHasRow, addrSubErrorTooMany, 0, null, 0, "Sub: Check if >1 row");
			compiler.emit(Opcode.Integer, 1, regSubHasRow, 0, null, 0, "Sub: Set hasRow=1");
			compiler.emit(Opcode.SCopy, resultBaseReg, regSubResult, 0, null, 0, "Sub: Copy first row result");
			compiler.emit(Opcode.Goto, 0, vnextJumpTarget, 0, null, 0);
			compiler.resolveAddress(addrSubErrorTooMany);
			compiler.emit(Opcode.Integer, 1, regSubError, 0, null, 0, "Sub: Set error=1 (>1 row)");
			compiler.emit(Opcode.Null, 0, regSubResult, 0, null, 0, "Sub: Set NULL on >1 row error");
			compiler.resolveAddress(vnextJumpTarget);
			compiler.emit(Opcode.VNext, firstSubCursor, addrSubLoopEnd, 0, null, 0, "Sub: VNext");
			compiler.emit(Opcode.Goto, 0, addrSubLoopStart, 0, null, 0, "Sub: Loop");
		} else {
			compiler.emit(Opcode.Integer, 1, regSubHasRow, 0, null, 0, "Sub: Set hasRow=1 (literal)");
			compiler.emit(Opcode.SCopy, resultBaseReg, regSubResult, 0, null, 0, "Sub: Copy literal result");
			compiler.emit(Opcode.Goto, 0, addrSubFinalize - 1, 0, null, 0);
		}
		compiler.resolveAddress(addrSubLoopEnd);
		compiler.closeCursorsUsedBySelect(subQueryCursors);

		compiler.resolveAddress(compiler.getCurrentAddress());
		compiler.emit(Opcode.IfTrue, regSubError, addrSubFinalize, 0, null, 0, "Sub: Jump if error flag set");
		compiler.emit(Opcode.IfFalse, regSubHasRow, addrSubSetNull, 0, null, 0, "Sub: Check if hasRow is false (0 rows)");
		compiler.emit(Opcode.Goto, 0, addrSubFinalize, 0, null, 0, "Sub: Finish (1 row, no error)");
		compiler.resolveAddress(addrSubSetNull);
		compiler.emit(Opcode.Null, 0, regSubResult, 0, null, 0, "Sub: Set NULL result (0 rows)");
		compiler.resolveAddress(addrSubFinalize);
		compiler.emit(Opcode.SCopy, regSubResult, -1, 0, null, 0, "Sub: Store result in Arg FP[-1]");
		compiler.emit(Opcode.SCopy, regSubError, -2, 0, null, 0, "Sub: Store error in Arg FP[-2]");
		compiler.emit(Opcode.FrameLeave, 0, 0, 0, null, 0, "Leave Subroutine Frame");
		compiler.emit(Opcode.Return, 0, 0, 0, null, 0, "Return from subquery");

		subInfo = { startAddress: subStartAddress, correlation };
		compiler.subroutineDefs?.set(subQuery, subInfo);
		compiler.endSubroutineCompilation();
	}

	// Call Site Logic
	const numArgsToPush = correlation.correlatedColumns.length;
	const callerResultReg = compiler.allocateMemoryCells(1);
	const callerErrorReg = compiler.allocateMemoryCells(1);

	correlation.correlatedColumns.forEach(cc => {
		const tempOuterValReg = compiler.allocateMemoryCells(1);
		const outerAlias = [...compiler.tableAliases.entries()].find(([_, cIdx]) => cIdx === cc.outerCursor)?.[0];
		const outerSchema = compiler.tableSchemas.get(cc.outerCursor);
		if (!outerSchema) throw new Error(`Internal: Schema for outer cursor ${cc.outerCursor} not found`);
		const outerColName = outerSchema.columns[cc.outerColumnIndex]?.name;
		if (!outerColName) throw new Error(`Internal: Column index ${cc.outerColumnIndex} not found for outer cursor ${cc.outerCursor}`);
		const outerColExpr: AST.ColumnExpr = { type: 'column', name: outerColName, table: outerAlias };
		compiler.compileExpression(outerColExpr, tempOuterValReg);
		compiler.emit(Opcode.Push, tempOuterValReg, 0, 0, null, 0, `Push outer val ${outerColName}`);
	});

	compiler.emit(Opcode.Push, 0, 0, 0, null, 0, "Push placeholder for Sub Error Status (Arg 1)");
	compiler.emit(Opcode.Push, 0, 0, 0, null, 0, "Push placeholder for Sub Result (Arg 0)");
	const totalArgsPushed = numArgsToPush + 2;

	compiler.emit(Opcode.Subroutine, totalArgsPushed, subInfo.startAddress, 0, null, 0, `Call correlated subquery`);

	compiler.emit(Opcode.SCopy, -1, callerResultReg, 0, null, 0, "Copy sub result from FP[-1]");
	compiler.emit(Opcode.SCopy, -2, callerErrorReg, 0, null, 0, "Copy sub error from FP[-2]");

	const addrSubroutineErrorCheck = compiler.allocateAddress();
	const addrSubroutineEnd = compiler.allocateAddress();
	compiler.emit(Opcode.IfZero, callerErrorReg, addrSubroutineErrorCheck, 0, null, 0, "Check subquery error flag");
	compiler.emit(Opcode.Halt, StatusCode.ERROR, 0, 0, "Correlated scalar subquery returned multiple rows", 0, "Error: Subquery >1 row");
	compiler.resolveAddress(addrSubroutineErrorCheck);
	compiler.emit(Opcode.SCopy, callerResultReg, targetReg, 0, null, 0, "Copy final subquery result");
	compiler.resolveAddress(addrSubroutineEnd);
}
// -----------------------------------

// ... (compileInSubquery, compileComparisonSubquery, compileExistsSubquery remain largely the same,
//      but they might need adjustments if they internally call compileScalarSubquery for correlated cases)

export function compileInSubquery(
	compiler: Compiler,
	leftExpr: AST.Expression,
	subQuery: AST.SelectStmt,
	targetReg: number,
	invert: boolean
): void {
	if (subQuery.columns.length !== 1 || subQuery.columns[0].type === 'all') {
		throw new SqliteError("Subquery for IN operator must return exactly one column (cannot be *)", StatusCode.ERROR);
	}

	const correlation = analyzeSubqueryCorrelation(compiler, subQuery, new Set(compiler.tableAliases.values()));
	if (correlation.isCorrelated) {
		compileCorrelatedInSubquery(compiler, leftExpr, subQuery, targetReg, invert, correlation);
	} else {
		compileUncorrelatedInSubquery(compiler, leftExpr, subQuery, targetReg, invert);
	}
}

export function compileComparisonSubquery(
	compiler: Compiler,
	leftExpr: AST.Expression,
	op: string,
	subQuery: AST.SelectStmt,
	targetReg: number
): void {
	const correlation = analyzeSubqueryCorrelation(compiler, subQuery, new Set(compiler.tableAliases.values()));
	if (correlation.isCorrelated) {
		compileCorrelatedComparisonSubquery(compiler, leftExpr, op, subQuery, targetReg, correlation);
	} else {
		compileUncorrelatedComparisonSubquery(compiler, leftExpr, op, subQuery, targetReg);
	}
}

export function compileExistsSubquery(
	compiler: Compiler,
	subQuery: AST.SelectStmt,
	targetReg: number
): void {
	const correlation = analyzeSubqueryCorrelation(compiler, subQuery, new Set(compiler.tableAliases.values()));
	if (correlation.isCorrelated) {
		compileCorrelatedExistsSubquery(compiler, subQuery, targetReg, correlation);
	} else {
		compileUncorrelatedExistsSubquery(compiler, subQuery, targetReg);
	}
}

// --- Uncorrelated Implementations (remain the same) ---
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
	const { resultBaseReg: subResultReg, numCols } = compiler.compileSelectCore(subQuery, subQueryCursors, undefined, undefined);
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
	compiler.compileScalarSubquery(subQuery, regSubResult); // Handles 0 or >1 row errors
	compiler.emit(Opcode.IfNull, regSubResult, addrSkipCompare, 0, null, 0, "Skip compare if subquery is NULL");

	switch (op.toUpperCase()) {
		case '=': case '==': case 'IS': compareOpcode = Opcode.Eq; break;
		case '!=': case '<>': case 'IS NOT': compareOpcode = Opcode.Ne; break;
		case '<': compareOpcode = Opcode.Lt; break;
		case '<=': compareOpcode = Opcode.Le; break;
		case '>': compareOpcode = Opcode.Gt; break;
		case '>=': compareOpcode = Opcode.Ge; break;
		default: throw new SqliteError(`Unsupported comparison operator with subquery: ${op}`);
	}

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
		if (subQuery.where) {
			const constWhereReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(subQuery.where, constWhereReg);
			compiler.emit(Opcode.IfFalse, constWhereReg, addrSetFalse, 0, null, 0, "EXISTS: Check constant WHERE");
		}
		compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "EXISTS: Literal/No-FROM subquery is TRUE");
		compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);
		compiler.resolveAddress(addrSetFalse);
		compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "EXISTS: Set FALSE (constant WHERE failed)");
		compiler.resolveAddress(addrEnd);
		return;
	}

	compiler.emit(Opcode.VFilter, firstSubCursor, addrSetFalse, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "EXISTS: Start scan");
	compiler.resolveAddress(addrLoopStart);
	if (subQuery.where) {
		const whereReg = compiler.allocateMemoryCells(1);
		compiler.compileExpression(subQuery.where, whereReg);
		compiler.emit(Opcode.IfFalse, whereReg, addrContinueLoop, 0, null, 0, "EXISTS: Check WHERE, jump to VNext if false");
	}
	compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "EXISTS: Set TRUE (found row)");
	compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0, "EXISTS: Finish (found row)");

	compiler.resolveAddress(addrContinueLoop);
	compiler.emit(Opcode.VNext, firstSubCursor, addrSetFalse, 0, null, 0, "EXISTS: VNext");
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "EXISTS: Loop back");

	compiler.resolveAddress(addrSetFalse);
	compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "EXISTS: Set FALSE (no rows found)");

	compiler.resolveAddress(addrEnd);
	compiler.closeCursorsUsedBySelect(subQueryCursors);
}

// --- Correlated IN Subquery Implementation ---
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

		// Locals: Match Flag(R[2]), Has Null Flag(R[3]), Subquery Value(R[4])
		const regSubMatch = 2;
		const regSubNull = 3;
		const regSubValue = 4;
		const regArgLeft = -1; // Argument: Left expression value at FP[-1]

		// Argument Map for inner compilation
		const argumentMap: Map<string, number> = new Map();
		correlation.correlatedColumns.forEach((cc, index) => {
			argumentMap.set(`${cc.outerCursor}.${cc.outerColumnIndex}`, -(index + 2)); // Outer args start at FP[-2]
		});

		// Compile subquery core
		const subQueryCursors: number[] = [];
		const { resultBaseReg, numCols } = compiler.compileSelectCore(subQuery, subQueryCursors, undefined, undefined);
		if (numCols !== 1) throw new SqliteError("Correlated IN subquery requires 1 column", StatusCode.INTERNAL);

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
			compiler.emit(Opcode.Eq, regArgLeft, addrSubMatchFound, regSubValue, null, 0, "SubIN: Compare with Arg (Jump if EQ)");
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
			compiler.emit(Opcode.Eq, regArgLeft, addrLitMatch, regSubValue, null, 0);
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

		// Determine final result (True=1, False=0, Null=NULL) and store in FP[-1]
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
		compiler.emit(Opcode.Goto, 0, addrSetSubNull + 1, 0, null, 0); // Jump past set NULL
		// Set TRUE (or FALSE if NOT IN)
		compiler.resolveAddress(addrSetSubTrue);
		compiler.emit(Opcode.Integer, trueResult, -1, 0, null, 0, "SubIN: Set Final True/False");
		compiler.emit(Opcode.Goto, 0, addrSetSubNull + 1, 0, null, 0); // Jump past set NULL
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

	// --- Call Site for Correlated IN ---
	const regLeftValue = compiler.allocateMemoryCells(1);
	const addrIsNull = compiler.allocateAddress();
	const addrEnd = compiler.allocateAddress();

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
		compiler.compileExpression({ type: 'column', name: outerColName, table: outerAlias }, tempOuterValReg);
		compiler.emit(Opcode.Push, tempOuterValReg, 0, 0, null, 0, `Push outer val ${outerColName}`);
		totalArgsPushed++;
	});

	// Push Left Value (Arg 0 at FP[-1])
	compiler.emit(Opcode.Push, regLeftValue, 0, 0, null, 0, "Push Left Value for SubIN"); totalArgsPushed++;

	compiler.emit(Opcode.Subroutine, totalArgsPushed, subInfo.startAddress, 0, null, 0, "Call SubIN");
	compiler.emit(Opcode.SCopy, -1, targetReg, 0, null, 0, "Copy SubIN result from FP[-1]");
	compiler.emit(Opcode.StackPop, totalArgsPushed, 0, 0, null, 0, "Pop SubIN args");
	compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

	compiler.resolveAddress(addrIsNull);
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "IN: Set NULL Result");

	compiler.resolveAddress(addrEnd);
}

// --- Correlated Comparison Subquery Implementation ---
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

	// --- Call Site ---
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
	compiler.emit(Opcode.SCopy, -1, regSubResult, 0, null, 0, "Copy sub result from FP[-1]");
	compiler.emit(Opcode.SCopy, -2, regSubError, 0, null, 0, "Copy sub error from FP[-2]");
	compiler.emit(Opcode.StackPop, totalArgsPushed, 0, 0, null, 0, "Pop subquery args/results");

	// Check subquery error or NULL result
	compiler.emit(Opcode.IfTrue, regSubError, addrSkipCompare, 0, null, 0, "Skip compare if subquery had error");
	compiler.emit(Opcode.IfNull, regSubResult, addrSkipCompare, 0, null, 0, "Skip compare if subquery result is NULL");

	// Determine comparison opcode
	let compareOpcode: Opcode;
	switch (op.toUpperCase()) {
		case '=': case '==': case 'IS': compareOpcode = Opcode.Eq; break;
		case '!=': case '<>': case 'IS NOT': compareOpcode = Opcode.Ne; break;
		case '<': compareOpcode = Opcode.Lt; break;
		case '<=': compareOpcode = Opcode.Le; break;
		case '>': compareOpcode = Opcode.Gt; break;
		case '>=': compareOpcode = Opcode.Ge; break;
		default: throw new SqliteError(`Unsupported comparison operator with subquery: ${op}`);
	}

	// Compare regLeftValue with retrieved subquery result
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

// --- Correlated EXISTS Subquery Implementation ---
function compileCorrelatedExistsSubquery(
	compiler: Compiler,
	subQuery: AST.SelectStmt,
	targetReg: number,
	correlation: SubqueryCorrelationResult
): void {
	let subInfo: SubroutineInfo | undefined = compiler.subroutineDefs?.get(subQuery);

	if (!subInfo) {
		// --- Compile Subroutine ---
		compiler.startSubroutineCompilation();
		const subStartAddress = compiler.getCurrentAddress();
		const regSubResult = compiler.allocateMemoryCells(1); // Local R[2] = result (0 or 1)

		const argumentMap: Map<string, number> = new Map();
		correlation.correlatedColumns.forEach((cc, index) => {
			argumentMap.set(`${cc.outerCursor}.${cc.outerColumnIndex}`, -(index + 1)); // Args start at FP[-1]
		});

		const subQueryCursors: number[] = compiler.compileFromCore(subQuery.from);
		const firstSubCursor = subQueryCursors[0];
		const addrSubLoopStart = compiler.allocateAddress();
		const addrSubEndScan = compiler.allocateAddress();
		// addrSubFoundRow removed, jump directly to end scan
		const addrSubContinueLoop = compiler.allocateAddress();

		compiler.emit(Opcode.Integer, 0, regSubResult, 0, null, 0, "SubEXISTS: Init result=0");

		if (firstSubCursor === undefined) { // No FROM
			if (subQuery.where) {
				const constWhereReg = compiler.allocateMemoryCells(1);
				compiler.compileExpression(subQuery.where, constWhereReg, correlation, undefined, argumentMap);
				compiler.emit(Opcode.IfFalse, constWhereReg, addrSubEndScan, 0, null, 0, "SubEXISTS: Check const WHERE");
			}
			compiler.emit(Opcode.Integer, 1, regSubResult, 0, null, 0, "SubEXISTS: Set result=1 (const)");
		} else { // Has FROM
			compiler.emit(Opcode.VFilter, firstSubCursor, addrSubEndScan, 0, { idxNum: 0, idxStr: null, nArgs: 0 }, 0, "SubEXISTS: Start scan");
			compiler.resolveAddress(addrSubLoopStart);
			if (subQuery.where) {
				const whereReg = compiler.allocateMemoryCells(1);
				compiler.compileExpression(subQuery.where, whereReg, correlation, undefined, argumentMap);
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
		// Write result to argument slot FP[-1]
		compiler.emit(Opcode.SCopy, regSubResult, -1, 0, null, 0, "SubEXISTS: Store result in Arg FP[-1]");
		compiler.emit(Opcode.FrameLeave, 0, 0, 0, null, 0, "Leave SubEXISTS Frame");
		compiler.emit(Opcode.Return, 0, 0, 0, null, 0, "Return from SubEXISTS");
		// --- End Subroutine ---

		subInfo = { startAddress: subStartAddress, correlation };
		compiler.subroutineDefs?.set(subQuery, subInfo);
		compiler.endSubroutineCompilation();
	}

	// --- Call Site ---
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
	compiler.emit(Opcode.Push, 0, 0, 0, null, 0, "Push placeholder for Sub EXISTS Result (Arg 0)"); totalArgsPushed++;

	compiler.emit(Opcode.Subroutine, totalArgsPushed, subInfo.startAddress, 0, null, 0, "Call SubEXISTS");
	compiler.emit(Opcode.SCopy, -1, targetReg, 0, null, 0, "Copy SubEXISTS result from FP[-1]");
	compiler.emit(Opcode.StackPop, totalArgsPushed, 0, 0, null, 0, "Pop SubEXISTS args");
}
