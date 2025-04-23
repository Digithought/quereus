import { Opcode, ConflictResolution } from '../common/constants';
import { StatusCode, type SqlValue, SqlDataType } from '../common/types';
import { SqliteError } from '../common/errors';
import { createInstruction, type P4Vtab, type P4FuncDef } from '../vdbe/instruction';
import type { Compiler, HavingContext, SubroutineInfo } from './compiler';
import type * as AST from '../parser/ast';
import { analyzeSubqueryCorrelation, type SubqueryCorrelationResult, type CorrelatedColumnInfo } from './helpers';
import type { TableSchema } from '../schema/table';
import type { ColumnSchema } from '../schema/column';
import { getAffinityForType } from '../schema/schema'; // Need a way to get affinity from type string
// Note: Subquery compilation functions are now in subquery.ts

// New type for the argument map
export type ArgumentMap = ReadonlyMap<string, number>; // Key: "cursor.colIdx", Value: negative FP offset

// --- Expression Affinity Determination ---

/** Determines the affinity of an expression. */
function getExpressionAffinity(compiler: Compiler, expr: AST.Expression, correlation?: SubqueryCorrelationResult): SqlDataType {
	switch (expr.type) {
		case 'literal':
			const v = expr.value;
			if (v === null) return SqlDataType.NULL; // Or maybe NONE/BLOB?
			if (typeof v === 'number') return SqlDataType.REAL;
			if (typeof v === 'bigint') return SqlDataType.INTEGER;
			if (typeof v === 'string') return SqlDataType.TEXT;
			if (v instanceof Uint8Array) return SqlDataType.BLOB;
			return SqlDataType.BLOB; // Default
		case 'column': {
			const schemaInfo = resolveColumnSchema(compiler, expr, correlation);
			return schemaInfo?.column?.affinity ?? SqlDataType.BLOB; // Default to BLOB if unresolved
		}
		case 'cast':
			// Determine affinity from the target type string
			return getAffinityForType(expr.targetType); // Use helper from schema utils
		case 'function':
			const funcDef = compiler.db._findFunction(expr.name, expr.args.length);
			// TODO: Add return type/affinity to FunctionSchema
			return funcDef?.affinity ?? SqlDataType.BLOB; // Assume BLOB/NONE if func/affinity unknown
		case 'parameter':
			return SqlDataType.BLOB; // Parameter affinity is unknown until binding
		case 'unary':
			switch (expr.operator.toUpperCase()) {
				case '-': case '+': return SqlDataType.NUMERIC;
				case '~': return SqlDataType.INTEGER;
				case 'NOT': return SqlDataType.INTEGER; // Boolean result
				default: return SqlDataType.BLOB;
			}
		case 'binary':
			switch (expr.operator.toUpperCase()) {
				case '+': case '-': case '*': case '/': case '%':
				case '&': case '|': case '<<': case '>>':
					return SqlDataType.NUMERIC; // Or INTEGER for bitwise?
				case '||': return SqlDataType.TEXT;
				case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				case 'IS': case 'IS NOT': case 'IN': case 'LIKE': case 'GLOB': case 'BETWEEN':
					return SqlDataType.INTEGER; // Boolean result
				case 'AND': case 'OR':
					// Affinity is determined by operands, default to NUMERIC?
					const affLeft = getExpressionAffinity(compiler, expr.left, correlation);
					const affRight = getExpressionAffinity(compiler, expr.right, correlation);
					// Simple rule: if either is TEXT/BLOB, maybe TEXT? Else NUMERIC?
					if (affLeft === SqlDataType.TEXT || affRight === SqlDataType.TEXT) return SqlDataType.TEXT;
					if (affLeft === SqlDataType.BLOB || affRight === SqlDataType.BLOB) return SqlDataType.BLOB;
					return SqlDataType.NUMERIC;
				default: return SqlDataType.BLOB;
			}
		case 'subquery':
			// Cannot easily determine affinity without executing/analyzing subquery result columns
			return SqlDataType.BLOB;
		case 'identifier':
			// Treat as column
			return getExpressionAffinity(compiler, { type: 'column', name: expr.name }, correlation);
		default:
			return SqlDataType.BLOB;
	}
}

/** Helper to find the schema for a column expression */
function resolveColumnSchema(compiler: Compiler, expr: AST.ColumnExpr, correlation?: SubqueryCorrelationResult): { table: TableSchema, column: ColumnSchema } | null {
	// Simplified resolution - assumes column is valid and unambiguous (checked later in compileColumn)
	let cursor = -1;
	if (expr.table) {
		cursor = compiler.tableAliases.get(expr.table.toLowerCase()) ?? -1;
	} else {
		for (const [_, cIdx] of compiler.tableAliases.entries()) {
			const schema = compiler.tableSchemas.get(cIdx);
			if (schema?.columnIndexMap.has(expr.name.toLowerCase())) {
				cursor = cIdx;
				break;
			}
		}
	}
	if (cursor === -1) return null; // Not found or ambiguous (will error later)
	const tableSchema = compiler.tableSchemas.get(cursor);
	if (!tableSchema) return null;
	const colIdx = tableSchema.columnIndexMap.get(expr.name.toLowerCase());
	if (colIdx === undefined) return null;
	const columnSchema = tableSchema.columns[colIdx];
	return { table: tableSchema, column: columnSchema };
}

// --- End Affinity --- //

// First, add function to get expression collation
function getExpressionCollation(compiler: Compiler, expr: AST.Expression, correlation?: SubqueryCorrelationResult): string {
	switch (expr.type) {
		case 'literal': return 'BINARY'; // Literals use BINARY unless overridden
		case 'column':
			const colInfo = resolveColumnSchema(compiler, expr, correlation);
			return colInfo?.column.collation || 'BINARY';
		case 'collate': // Explicit COLLATE operator
			return expr.collation.toUpperCase(); // Normalize collation name
		case 'cast':
			// CAST generally doesn't change collation
			return 'BINARY';
		case 'function':
			// Functions usually have BINARY result collation
			return 'BINARY';
		case 'parameter':
			return 'BINARY'; // Parameters are assigned BINARY collation
		case 'unary':
			// Unary operators generally don't affect collation
			return 'BINARY';
		case 'binary':
			// Binary operations generally result in BINARY collation
			return 'BINARY';
		case 'subquery':
			// Subquery results use BINARY collation
			return 'BINARY';
		case 'identifier':
			// Treat as column
			return 'BINARY';
		default:
			return 'BINARY';
	}
}

// Now add support for COLLATE to compileExpression
export function compileExpression(compiler: Compiler, expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	switch (expr.type) {
		case 'literal': compiler.compileLiteral(expr, targetReg); break;
		case 'identifier': compiler.compileColumn({ type: 'column', name: expr.name, alias: expr.name }, targetReg, correlation, havingContext, argumentMap); break;
		case 'column': compiler.compileColumn(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'binary': compiler.compileBinary(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'unary': compiler.compileUnary(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'cast': compiler.compileCast(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'function': compiler.compileFunction(expr, targetReg, correlation, havingContext, argumentMap); break;
		case 'parameter': compiler.compileParameter(expr, targetReg); break;
		case 'subquery': compiler.compileSubquery(expr, targetReg); break;
		case 'collate': compiler.compileCollate(expr, targetReg, correlation, havingContext, argumentMap); break; // Add this
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
	// If it's a subquery comparison, handle specially
	if (expr.right.type === 'subquery' && ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IN'].includes(expr.operator.toUpperCase())) {
		const subQuery = expr.right.query;
		switch (expr.operator.toUpperCase()) {
			case 'IN': compiler.compileInSubquery(expr.left, subQuery, targetReg, false /*, correlation, argumentMap*/); return; // Fix: Adjusted arguments
			case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				compiler.compileComparisonSubquery(expr.left, expr.operator, subQuery, targetReg /*, correlation, argumentMap*/); return; // Fix: Adjusted arguments
			default: throw new SqliteError(`Operator '${expr.operator}' cannot be used with a subquery on the right side.`, StatusCode.ERROR);
		}
	}
	if (expr.left.type === 'subquery' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(expr.operator.toUpperCase())) {
		const subQuery = expr.left.query;
		switch (expr.operator.toUpperCase()) {
			case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				compiler.compileComparisonSubquery(expr.left, expr.operator, subQuery, targetReg /*, correlation, argumentMap*/); return; // Fix: Adjusted arguments
			default: throw new SqliteError(`Operator '${expr.operator}' cannot be used with a subquery on the left side.`, StatusCode.ERROR);
		}
	}

	// Get affinity and operands
	const leftReg = compiler.allocateMemoryCells(1);
	const rightReg = compiler.allocateMemoryCells(1);
	compiler.compileExpression(expr.left, leftReg, correlation, havingContext, argumentMap);
	compiler.compileExpression(expr.right, rightReg, correlation, havingContext, argumentMap);

	// Determine collation for comparison operators
	let collationName: string | undefined;
	const isComparison = ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT', 'LIKE', 'GLOB'].includes(expr.operator.toUpperCase());

	if (isComparison) {
		// Determine effective collation according to SQLite rules:
		// 1. Explicit COLLATE on either operand wins
		// 2. If one operand is a column, use its collation
		// 3. Otherwise, use BINARY

		if (expr.left.type === 'collate') {
			collationName = expr.left.collation.toUpperCase();
		} else if (expr.right.type === 'collate') {
			collationName = expr.right.collation.toUpperCase();
		} else {
			const leftColl = getExpressionCollation(compiler, expr.left, correlation);
			const rightColl = getExpressionCollation(compiler, expr.right, correlation);

			if (leftColl !== 'BINARY' && rightColl === 'BINARY') {
				collationName = leftColl;
			} else if (rightColl !== 'BINARY' && leftColl === 'BINARY') {
				collationName = rightColl;
			} else if (leftColl !== 'BINARY' && rightColl !== 'BINARY' && leftColl !== rightColl) {
				// Conflict - use BINARY
				collationName = 'BINARY';
			} else {
				collationName = leftColl; // Same as rightColl or both BINARY
			}
		}
	}

	// The rest of the function remains similar, but we'll pass collation info to comparison opcodes
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
			let compareOp: Opcode;
			let resultIfTrue = 1;
			let resultIfFalse = 0;
			let handleNull = true; // Standard operators treat NULL comparison as NULL
			let jumpOpcode: Opcode | null = null;

			// Set up P4 with collation info
			let p4: any = null;
			if (isComparison && collationName && collationName !== 'BINARY') {
				p4 = { type: 'coll', name: collationName };
			}

			// Choose opcode and jump target logic
			switch (expr.operator.toUpperCase()) {
				case '=': case '==': compareOp = Opcode.Eq; jumpOpcode = Opcode.Eq; handleNull = true; break;
				case 'IS': compareOp = Opcode.Eq; jumpOpcode = Opcode.Eq; handleNull = false; break;
				case '!=': case '<>': compareOp = Opcode.Ne; jumpOpcode = Opcode.Ne; handleNull = true; break;
				case 'IS NOT': compareOp = Opcode.Ne; jumpOpcode = Opcode.Ne; handleNull = false; break;
				case '<': compareOp = Opcode.Lt; jumpOpcode = Opcode.Lt; handleNull = true; break;
				case '<=': compareOp = Opcode.Le; jumpOpcode = Opcode.Le; handleNull = true; break;
				case '>': compareOp = Opcode.Gt; jumpOpcode = Opcode.Gt; handleNull = true; break;
				case '>=': compareOp = Opcode.Ge; jumpOpcode = Opcode.Ge; handleNull = true; break;
				default: throw new Error("Impossible operator");
			}

			// Apply type affinity if needed
			const leftAffinity = getExpressionAffinity(compiler, expr.left, correlation);
			const rightAffinity = getExpressionAffinity(compiler, expr.right, correlation);
			const leftIsNum = [SqlDataType.INTEGER, SqlDataType.REAL, SqlDataType.NUMERIC].includes(leftAffinity);
			const rightIsNum = [SqlDataType.INTEGER, SqlDataType.REAL, SqlDataType.NUMERIC].includes(rightAffinity);
			const leftIsTextBlob = [SqlDataType.TEXT, SqlDataType.BLOB].includes(leftAffinity);
			const rightIsTextBlob = [SqlDataType.TEXT, SqlDataType.BLOB].includes(rightAffinity);

			if (leftIsNum && rightIsTextBlob) {
				compiler.emit(Opcode.Affinity, rightReg, 1, 0, 'NUMERIC', 0, `Apply NUMERIC affinity to RHS for comparison`);
			} else if (rightIsNum && leftIsTextBlob) {
				compiler.emit(Opcode.Affinity, leftReg, 1, 0, 'NUMERIC', 0, `Apply NUMERIC affinity to LHS for comparison`);
			}

			const addrIsTrue = compiler.allocateAddress();
			const addrSetNull = compiler.allocateAddress();
			const addrEnd = compiler.allocateAddress();

			// ... rest of comparison logic (NULL handling, etc.) unchanged ...
			// But we'll pass p4 containing collation to the jumpOpcode
			if (handleNull) {
				compiler.emit(Opcode.IfNull, leftReg, addrSetNull, 0, null, 0, `Compare: If left NULL, jump to set NULL`);
				compiler.emit(Opcode.IfNull, rightReg, addrSetNull, 0, null, 0, `Compare: If right NULL, jump to set NULL`);
			}

			// This is the key change - passing p4 with collation info
			compiler.emit(jumpOpcode!, leftReg, addrIsTrue, rightReg, p4, 0, `Compare ${expr.operator}${p4 ? ` (${p4.name})` : ''}`);

			// Set false and jump to end
			if (resultIfFalse !== 0) {
				compiler.emit(Opcode.Integer, targetReg, resultIfFalse, 0, null, 0, `Load ${resultIfFalse} (false result)`);
			} else {
				compiler.emit(Opcode.Null, targetReg, 0, 0, null, 0, `Load 0 (false result)`);
			}
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0, `Jump to end, skipping true case`);

			// Set true value
			compiler.resolveAddress(addrIsTrue);
			if (resultIfTrue !== 1) {
				compiler.emit(Opcode.Integer, targetReg, resultIfTrue, 0, null, 0, `Load ${resultIfTrue} (true result)`);
			} else {
				compiler.emit(Opcode.Integer, targetReg, 1, 0, null, 0, `Load 1 (true result)`);
			}
			compiler.emit(Opcode.Goto, 0, addrEnd, 0, null, 0, `Jump to end, skipping NULL case`);

			// Set NULL value if either operand is NULL
			if (handleNull) {
				compiler.resolveAddress(addrSetNull);
				compiler.emit(Opcode.Null, targetReg, 0, 0, null, 0, `Null comparison result`);
			}

			// End of comparison logic
			compiler.resolveAddress(addrEnd);
			break;
		}
		case 'LIKE': case 'GLOB': {
			// TODO: Implement LIKE/GLOB with proper collation support
			throw new SqliteError(`Operator ${expr.operator} not fully implemented yet with collation support.`, StatusCode.ERROR);
		}
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

			// Perform comparison and jump if true (using the already affinity-adjusted values)
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
	// Use SqlDataType enum constants for affinity string in P4
	const affinity = getAffinityForType(targetType);
	let affinityStr: string;
	switch (affinity) {
		case SqlDataType.INTEGER: affinityStr = 'INTEGER'; break;
		case SqlDataType.REAL: affinityStr = 'REAL'; break;
		case SqlDataType.TEXT: affinityStr = 'TEXT'; break;
		case SqlDataType.BLOB: affinityStr = 'BLOB'; break;
		case SqlDataType.NUMERIC: affinityStr = 'NUMERIC'; break;
		default: affinityStr = 'BLOB'; // Default/NONE affinity maps to BLOB (no conversion)
	}
	compiler.emit(Opcode.Affinity, targetReg, 1, 0, affinityStr, 0, `CAST to ${targetType}`);
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

// Add compileCollate function
export function compileCollate(compiler: Compiler, expr: AST.CollateExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void {
	// The COLLATE operator doesn't change the value, only the collation used in comparisons
	// We simply compile the underlying expression
	compiler.compileExpression(expr.expr, targetReg, correlation, havingContext, argumentMap);
	// No specific VDBE instructions needed for COLLATE - the collation info is used by binary expressions
}
