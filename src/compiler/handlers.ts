import { SqlDataType } from '../common/constants.js';
import { Opcode } from '../vdbe/opcodes.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import { SqliteError } from '../common/errors.js';
import { type P4FuncDef } from '../vdbe/instruction.js';
import type { Compiler, HavingContext } from './compiler.js';
import type * as AST from '../parser/ast.js';
import { type SubqueryCorrelationResult, type CorrelatedColumnInfo } from './correlation.js';
import type { TableSchema } from '../schema/table.js';
import { getAffinityForType } from '../schema/schema.js';
import { getExpressionAffinity, getExpressionCollation, compileLiteralValue } from './utils.js';
import { safeJsonStringify } from '../util/serialization.js';

/** Map column name/alias to register holding its value */
export type ArgumentMap = ReadonlyMap<string, number>;

export function compileColumn(compiler: Compiler, expr: AST.ColumnExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	// --- Row-constraint alias lookup (NEW/OLD) or Contextual Value (CHECK) ---
	if (argumentMap) {
		const colNameLower = expr.name.toLowerCase();
		const aliasLower = expr.table?.toLowerCase();

		// 1. Check for explicit "new.<col>" or "old.<col>"
		if (aliasLower && (aliasLower === 'new' || aliasLower === 'old')) {
			const key = `${aliasLower}.${colNameLower}`;
			const sourceReg = argumentMap.get(key);
			if (sourceReg !== undefined) {
				compiler.emit(Opcode.SCopy, sourceReg, targetReg, 0, null, 0, `RowChk: ${aliasLower.toUpperCase()}.${expr.name} from r${sourceReg}`);
				return; // Found explicit NEW/OLD value
			}
		}

		// 2. Check for unqualified name ("<col_name>") - default depends on context (filled by caller)
		// Caller (INSERT/UPDATE/DELETE) should populate this key appropriately.
		const unqualifiedKey = colNameLower;
		const sourceRegUnqualified = argumentMap.get(unqualifiedKey);
		if (sourceRegUnqualified !== undefined) {
			compiler.emit(Opcode.SCopy, sourceRegUnqualified, targetReg, 0, null, 0, `RowChk/Set: ${expr.name} (Default Context) from r${sourceRegUnqualified}`);
			return; // Found default contextual value
		}

		// 3. Check for CHECK constraint context using column index "<col_index>"
		// This path is mainly for the original INSERT CHECK implementation, might be superseded
		// by the unqualified name lookup, but kept for safety/potential specific uses.
		let resolvedColIdx = -99;
		let resolvedCursor = -1;
		if (expr.table) {
			const aliasOrTableName = expr.table.toLowerCase();
			const foundCursor = compiler.tableAliases.get(aliasOrTableName);
			if (foundCursor !== undefined) {
				resolvedCursor = foundCursor;
				const resolvedTableSchema = compiler.tableSchemas.get(resolvedCursor);
				if (resolvedTableSchema) {
					resolvedColIdx = resolvedTableSchema.columnIndexMap.get(expr.name.toLowerCase()) ?? -99;
					if (resolvedColIdx === -99 && expr.name.toLowerCase() === 'rowid') resolvedColIdx = -1;
				}
			}
		} else {
			let foundCount = 0;
			for (const [_, cursorId] of compiler.tableAliases.entries()) {
				const schema = compiler.tableSchemas.get(cursorId);
				if (schema) {
					const idx = schema.columnIndexMap.get(expr.name.toLowerCase());
					if (idx !== undefined) {
						if (foundCount > 0) { resolvedCursor = -2; break; }
						resolvedCursor = cursorId;
						resolvedColIdx = idx;
						foundCount++;
					} else if (expr.name.toLowerCase() === 'rowid') {
						if (foundCount > 0) { resolvedCursor = -2; break; }
						resolvedCursor = cursorId;
						resolvedColIdx = -1;
						foundCount++;
					}
				}
			}
			if (resolvedCursor === -2) resolvedColIdx = -99; // Ambiguous
		}

		if (resolvedColIdx !== -99 && resolvedCursor >= 0) {
			const indexKey = `${resolvedColIdx}`; // Key is stringified column index
			const sourceRegFromIndex = argumentMap.get(indexKey);
			if (sourceRegFromIndex !== undefined) {
				compiler.emit(Opcode.SCopy, sourceRegFromIndex, targetReg, 0, null, 0, `CHECK: Use new val ${expr.name} from index key ${indexKey} (reg ${sourceRegFromIndex})`);
				return; // Value obtained via index key
			}
		}
	}
	// --- End Row-constraint / Contextual Lookup ---

	// --- Correlated Subquery / HAVING clause Lookup --- (Existing logic, check argumentMap first)
	if (compiler.subroutineDepth > 0 && argumentMap) {
		const correlatedColInfo = correlation?.correlatedColumns.find((cc: CorrelatedColumnInfo) => {
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
				throw new SqliteError(`Internal error: Correlated column ${expr.name} not found in argument map.`, StatusCode.INTERNAL, undefined, expr.loc?.start.line, expr.loc?.start.column);
			}
		}
	}

	if (havingContext) {
		const colNameLower = expr.name.toLowerCase();
		const matchedCol = havingContext.finalColumnMap.find(info => {
			const exprAlias = (info.expr as any)?.alias?.toLowerCase();
			return (exprAlias === colNameLower) ||
				(info.expr?.type === 'column' && !(info.expr as any)?.alias && (info.expr as AST.ColumnExpr).name.toLowerCase() === colNameLower);
		});

		if (matchedCol) {
			compiler.emit(Opcode.SCopy, matchedCol.targetReg, targetReg, 0, null, 0, `HAVING: Use grouped/aggregated col '${expr.name}' from reg ${matchedCol.targetReg}`);
			return;
		}
		throw new SqliteError(`Column "${expr.name}" must appear in the GROUP BY clause or be used in an aggregate function`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	}

	let cursor = -1;
	let colIdx = -1;
	let tableSchema: TableSchema | undefined;

	if (expr.table) {
		const aliasOrTableName = expr.table.toLowerCase();
		const foundCursor = compiler.tableAliases.get(aliasOrTableName);
		if (foundCursor === undefined) {
			throw new SqliteError(`Table or alias not found: ${expr.table}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
		}
		cursor = foundCursor;
		tableSchema = compiler.tableSchemas.get(cursor);
		if (!tableSchema) { throw new SqliteError(`Internal error: Schema not found for cursor ${cursor}`, StatusCode.INTERNAL); }
		const potentialColIdx = tableSchema.columnIndexMap.get(expr.name.toLowerCase());
		if (potentialColIdx === undefined) {
			// Rowid is implicitly supported by virtual tables unless specified otherwise
			if (expr.name.toLowerCase() === 'rowid') {
				colIdx = -1;
			} else {
				throw new SqliteError(`Column not found in table ${expr.table}: ${expr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
			}
		} else {
			colIdx = potentialColIdx;
		}
	} else {
		let foundCount = 0;
		let potentialCursor = -1;
		let potentialColIdx = -1;
		let potentialSchema: TableSchema | undefined;

		for (const [alias, cursorId] of compiler.tableAliases.entries()) {
			const schema = compiler.tableSchemas.get(cursorId);
			if (schema) {
				const idx = schema.columnIndexMap.get(expr.name.toLowerCase());
				if (idx !== undefined) {
					if (potentialCursor !== -1) {
						throw new SqliteError(`Ambiguous column name: ${expr.name}. Qualify with table name or alias.`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
					}
					potentialCursor = cursorId;
					potentialColIdx = idx;
					potentialSchema = schema;
					foundCount++;
				} else if (expr.name.toLowerCase() === 'rowid') {
					if (potentialCursor !== -1) {
						throw new SqliteError(`Ambiguous column name: ${expr.name} (rowid). Qualify with table name or alias.`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
					}
					potentialCursor = cursorId;
					potentialColIdx = -1;
					potentialSchema = schema;
					foundCount++;
				}
			}
		}

		if (potentialCursor === -1) {
			throw new SqliteError(`Column not found: ${expr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
		}
		cursor = potentialCursor;
		colIdx = potentialColIdx;
		tableSchema = potentialSchema;
	}

	if (!tableSchema) { throw new Error("Internal: Schema resolution failed"); }

	compiler.emit(Opcode.VColumn, cursor, colIdx, targetReg, 0, 0, `Get column: ${tableSchema.name}.${expr.name} (idx ${colIdx})`);
}

export function compileBinary(compiler: Compiler, expr: AST.BinaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	if (expr.right.type === 'subquery' && [
		'=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IN'
	].includes(expr.operator.toUpperCase())) {
		const subQuery = expr.right.query;
		switch (expr.operator.toUpperCase()) {
			case 'IN': compiler.compileInSubquery(expr.left, subQuery, targetReg, false); return;
			case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				compiler.compileComparisonSubquery(expr.left, expr.operator, subQuery, targetReg); return;
			default:
				throw new SqliteError(`Operator '${expr.operator}' cannot be used with a subquery on the right side.`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
		}
	}
	if (expr.left.type === 'subquery' && [
		'=', '==', '!=', '<>', '<', '<=', '>', '>='
	].includes(expr.operator.toUpperCase())) {
		const subQuery = expr.left.query;
		switch (expr.operator.toUpperCase()) {
			case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				compiler.compileComparisonSubquery(expr.left, expr.operator, subQuery, targetReg); return;
			default:
				throw new SqliteError(`Operator '${expr.operator}' cannot be used with a subquery on the left side.`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
		}
	}

	const leftReg = compiler.allocateMemoryCells(1);
	const rightReg = compiler.allocateMemoryCells(1);
	compiler.compileExpression(expr.left, leftReg, correlation, havingContext, argumentMap);
	compiler.compileExpression(expr.right, rightReg, correlation, havingContext, argumentMap);

	let collationName: string | undefined;
	const isComparison = ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT', 'LIKE', 'GLOB'].includes(expr.operator.toUpperCase());

	if (isComparison) {
		if (expr.left.type === 'collate') {
			collationName = expr.left.collation.toUpperCase();
		} else if (expr.right.type === 'collate') {
			collationName = expr.right.collation.toUpperCase();
		} else {
			const leftColl = getExpressionCollation(compiler, expr.left, correlation);
			const rightColl = getExpressionCollation(compiler, expr.right, correlation);
			if (leftColl !== 'BINARY' && rightColl === 'BINARY') collationName = leftColl;
			else if (rightColl !== 'BINARY' && leftColl === 'BINARY') collationName = rightColl;
			else if (leftColl !== 'BINARY' && rightColl !== 'BINARY' && leftColl !== rightColl) collationName = 'BINARY';
			else collationName = leftColl;
		}
	}

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
		case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=': case 'IS': case 'IS NOT': {
			let jumpOpcode: Opcode;
			let handleNull = true;
			let p4: any = null;

			if (isComparison && collationName && collationName !== 'BINARY') {
				p4 = { type: 'coll', name: collationName };
			}

			switch (expr.operator.toUpperCase()) {
				case '=': case '==': jumpOpcode = Opcode.Eq; handleNull = true; break;
				case 'IS': jumpOpcode = Opcode.Eq; handleNull = false; break;
				case '!=': case '<>': jumpOpcode = Opcode.Ne; handleNull = true; break;
				case 'IS NOT': jumpOpcode = Opcode.Ne; handleNull = false; break;
				case '<': jumpOpcode = Opcode.Lt; handleNull = true; break;
				case '<=': jumpOpcode = Opcode.Le; handleNull = true; break;
				case '>': jumpOpcode = Opcode.Gt; handleNull = true; break;
				case '>=': jumpOpcode = Opcode.Ge; handleNull = true; break;
				default: throw new Error("Impossible operator");
			}

			const leftAffinity = getExpressionAffinity(compiler, expr.left, correlation);
			const rightAffinity = getExpressionAffinity(compiler, expr.right, correlation);
			const leftIsNum = [SqlDataType.INTEGER, SqlDataType.REAL, SqlDataType.NUMERIC].includes(leftAffinity);
			const rightIsNum = [SqlDataType.INTEGER, SqlDataType.REAL, SqlDataType.NUMERIC].includes(rightAffinity);
			const leftIsTextBlob = [SqlDataType.TEXT, SqlDataType.BLOB].includes(leftAffinity);
			const rightIsTextBlob = [SqlDataType.TEXT, SqlDataType.BLOB].includes(rightAffinity);

			if (leftIsNum && rightIsTextBlob) {
				compiler.emit(Opcode.Affinity, rightReg, 1, 0, 'NUMERIC', 0, `Apply NUMERIC affinity to RHS`);
			} else if (rightIsNum && leftIsTextBlob) {
				compiler.emit(Opcode.Affinity, leftReg, 1, 0, 'NUMERIC', 0, `Apply NUMERIC affinity to LHS`);
			}

			const addrIsTrue = compiler.allocateAddress();
			const addrSetNull = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();

			if (handleNull) {
				compiler.emit(Opcode.IfNull, leftReg, addrSetNull, 0, null, 0, `Compare: If left NULL`);
				compiler.emit(Opcode.IfNull, rightReg, addrSetNull, 0, null, 0, `Compare: If right NULL`);
			}

			compiler.emit(jumpOpcode!, leftReg, addrIsTrue, rightReg, p4, 0, `Compare ${expr.operator}${p4 ? ` (${p4.name})` : ''}`);

			compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, `Load 0 (false result)`);
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

			compiler.resolveAddress(addrIsTrue);
			compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, `Load 1 (true result)`);
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

			if (handleNull) {
				compiler.resolveAddress(addrSetNull);
				compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Null comparison result`);
			}

			compiler.resolveAddress(addrEnd);
			break;
		}
		case 'LIKE': case 'GLOB': {
			throw new SqliteError(`Operator ${expr.operator} not fully implemented yet with collation support.`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
		}
		case 'AND': {
			const addrIsRight = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();
			compiler.emit(Opcode.SCopy, leftReg, targetReg, 0, null, 0, "AND: Copy left initially");
			compiler.emit(Opcode.IfTrue, leftReg, addrIsRight, 0, null, 0, "AND: If left is true, evaluate right");
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0, "AND: Left is false/null, finish");
			compiler.resolveAddress(addrIsRight);
			compiler.emit(Opcode.SCopy, rightReg, targetReg, 0, null, 0, "AND: Copy right as result");
			compiler.resolveAddress(addrEnd);
			break;
		}
		case 'OR': {
			const addrIsRight = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();
			compiler.emit(Opcode.SCopy, leftReg, targetReg, 0, null, 0, "OR: Copy left initially");
			compiler.emit(Opcode.IfTrue, leftReg, addrEnd, 0, null, 0, "OR: If left is true, finish");
			compiler.resolveAddress(addrIsRight);
			compiler.emit(Opcode.SCopy, rightReg, targetReg, 0, null, 0, "OR: Copy right as result");
			compiler.resolveAddress(addrEnd);
			break;
		}
		default:
			throw new SqliteError(`Unsupported binary operator: ${expr.operator}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	}
}

export function compileUnary(compiler: Compiler, expr: AST.UnaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	if (expr.operator.toUpperCase() === 'NOT' && expr.expr.type === 'binary' && expr.expr.operator.toUpperCase() === 'IN' && expr.expr.right.type === 'subquery') {
		compiler.compileInSubquery(expr.expr.left, expr.expr.right.query, targetReg, true);
		return;
	}
	if (expr.operator.toUpperCase() === 'NOT' && expr.expr.type === 'subquery') {
		compiler.compileExistsSubquery(expr.expr.query, targetReg);
		const addrIsNull = compiler.allocateAddress();
		const addrEnd = compiler.allocateAddress();
		compiler.emit(Opcode.IfNull, targetReg, addrEnd, 0, null, 0, "NOT EXISTS: Skip if NULL");
		compiler.emit(Opcode.Not, targetReg, targetReg, 0, null, 0, "NOT EXISTS: Invert boolean");
		compiler.resolveAddress(addrEnd);
		return;
	}
	if (expr.operator.toUpperCase() === 'EXISTS' && expr.expr.type === 'subquery') {
		compiler.compileExistsSubquery(expr.expr.query, targetReg);
		return;
	}
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

	const operandReg = compiler.allocateMemoryCells(1);
	compiler.compileExpression(expr.expr, operandReg, correlation, havingContext, argumentMap);
	switch (expr.operator.toUpperCase()) {
		case '-': compiler.emit(Opcode.Negative, operandReg, targetReg, 0, null, 0, "Unary Minus"); break;
		case '+': compiler.emit(Opcode.SCopy, operandReg, targetReg, 0, null, 0, "Unary Plus (no-op)"); break;
		case '~': compiler.emit(Opcode.BitNot, operandReg, targetReg, 0, null, 0, "Bitwise NOT"); break;
		case 'NOT':
			const addrIsNull = compiler.allocateAddress();
			const addrSetTrue = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();

			compiler.emit(Opcode.IfNull, operandReg, addrIsNull, 0, null, 0, "NOT: Check if operand is NULL");
			compiler.emit(Opcode.IfZero, operandReg, addrSetTrue, 0, null, 0, "NOT: Check if operand is 0 (false)");

			compiler.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "NOT: Set result 0 (operand was true)");
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

			compiler.resolveAddress(addrSetTrue);
			compiler.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "NOT: Set result 1 (operand was false)");
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0);

			compiler.resolveAddress(addrIsNull);
			compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "NOT: Set result NULL (operand was NULL)");

			compiler.resolveAddress(addrEnd);
			break;
		default: throw new SqliteError(`Unsupported unary operator: ${expr.operator}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	}
}

export function compileCast(compiler: Compiler, expr: AST.CastExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	compiler.compileExpression(expr.expr, targetReg, correlation, havingContext, argumentMap);
	const targetType = expr.targetType.toUpperCase();
	const affinity = getAffinityForType(targetType);
	let affinityStr: string;
	switch (affinity) {
		case SqlDataType.INTEGER: affinityStr = 'INTEGER'; break;
		case SqlDataType.REAL: affinityStr = 'REAL'; break;
		case SqlDataType.TEXT: affinityStr = 'TEXT'; break;
		case SqlDataType.BLOB: affinityStr = 'BLOB'; break;
		case SqlDataType.NUMERIC: affinityStr = 'NUMERIC'; break;
		default: affinityStr = 'BLOB';
	}
	compiler.emit(Opcode.Affinity, targetReg, 1, 0, affinityStr, 0, `CAST to ${targetType}`);
}

export function compileFunction(compiler: Compiler, expr: AST.FunctionExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	if (havingContext) {
		const matchedAgg = havingContext.finalColumnMap.find(info =>
			info.expr?.type === 'function' &&
			(info.expr as AST.FunctionExpr).name.toLowerCase() === expr.name.toLowerCase() &&
			safeJsonStringify((info.expr as AST.FunctionExpr).args) === safeJsonStringify(expr.args)
		);
		if (matchedAgg) {
			compiler.emit(Opcode.SCopy, matchedAgg.targetReg, targetReg, 0, null, 0, `HAVING: Use aggregated func '${expr.name}' from reg ${matchedAgg.targetReg}`);
			return;
		}
	}

	const argRegs = compiler.allocateMemoryCells(expr.args.length || 1);
	for (let i = 0; i < expr.args.length; i++) {
		compiler.compileExpression(expr.args[i], argRegs + i, correlation, havingContext, argumentMap);
	}

	const funcDef = compiler.db._findFunction(expr.name, expr.args.length);
	if (!funcDef) { throw new SqliteError(`Function not found: ${expr.name}/${expr.args.length}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column); }

	const isAggregate = !!(funcDef.xStep && funcDef.xFinal);

	if (isAggregate && !havingContext) {
		compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Aggregate func ${expr.name} in scalar context -> NULL`);
	}
	else if (funcDef.xFunc) {
		const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: expr.args.length };
		compiler.emit(Opcode.Function, argRegs, expr.args.length, targetReg, p4, 0, `Call func: ${expr.name}`);
	}
	else if (isAggregate && havingContext && !funcDef.xFunc) {
		throw new SqliteError(`Aggregate function ${funcDef.name} used incorrectly in HAVING clause.`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	} else if (isAggregate && !havingContext) {
		throw new SqliteError(`Aggregate function ${funcDef.name} used in a scalar context`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	} else {
		throw new SqliteError(`Invalid function call context for ${funcDef.name}`, StatusCode.INTERNAL, undefined, expr.loc?.start.line, expr.loc?.start.column);
	}
}

export function compileParameter(compiler: Compiler, expr: AST.ParameterExpr, targetReg: number): void {
	const key = expr.name || expr.index!;
	compiler.parameters.set(key, { memIdx: targetReg });
	compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Parameter placeholder: ${key} -> R[${targetReg}]`);
}

export function compileCollate(compiler: Compiler, expr: AST.CollateExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	compiler.compileExpression(expr.expr, targetReg, correlation, havingContext, argumentMap);
}

export function compileExpression(compiler: Compiler, expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	switch (expr.type) {
		case 'literal': compileLiteralValue(compiler, expr.value, targetReg); break;
		case 'identifier': compileColumn(compiler, { type: 'column', name: expr.name, alias: expr.name }, targetReg, correlation, havingContext, argumentMap); break;
		case 'column': compileColumn(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'binary': compileBinary(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'unary': compileUnary(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'cast': compileCast(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'function': compileFunction(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'parameter': compileParameter(compiler, expr, targetReg); break;
		case 'subquery': compiler.compileSubquery(expr, targetReg); break;
		case 'collate': compileCollate(compiler, expr, targetReg, correlation, havingContext, argumentMap); break;
		default:
			throw new SqliteError(`Unsupported expression type: ${(expr as any).type}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	}
}
