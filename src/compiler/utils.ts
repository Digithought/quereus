import type { Compiler } from './compiler.js';
import type * as AST from '../parser/ast.js';
import { SqlDataType } from '../common/constants.js';
import { getAffinityForType } from '../schema/schema.js';
import type { TableSchema } from '../schema/table.js';
import type { ColumnSchema } from '../schema/column.js';
import type { SubqueryCorrelationResult } from './correlation.js';
import type { SqlValue } from '../common/types.js';
import { Opcode } from '../vdbe/opcodes.js';

/**
 * Determines the affinity of an expression.
 *
 * @param compiler The compiler instance
 * @param expr The expression to analyze
 * @param correlation Optional correlation info for subqueries
 * @returns The SQL data type affinity
 */
export function getExpressionAffinity(compiler: Compiler, expr: AST.Expression, correlation?: SubqueryCorrelationResult): SqlDataType {
	switch (expr.type) {
		case 'literal':
			const v = expr.value;
			if (v === null) return SqlDataType.NULL;
			if (typeof v === 'number') return SqlDataType.REAL;
			if (typeof v === 'bigint') return SqlDataType.INTEGER;
			if (typeof v === 'string') return SqlDataType.TEXT;
			if (v instanceof Uint8Array) return SqlDataType.BLOB;
			return SqlDataType.BLOB;
		case 'column': {
			const schemaInfo = resolveColumnSchema(compiler, expr, correlation);
			return schemaInfo?.column?.affinity ?? SqlDataType.BLOB;
		}
		case 'cast':
			return getAffinityForType(expr.targetType);
		case 'function':
			const funcDef = compiler.db._findFunction(expr.name, expr.args.length);
			return funcDef?.affinity ?? SqlDataType.BLOB;
		case 'parameter':
			return SqlDataType.BLOB;
		case 'unary':
			switch (expr.operator.toUpperCase()) {
				case '-': case '+': return SqlDataType.NUMERIC;
				case '~': return SqlDataType.INTEGER;
				case 'NOT': return SqlDataType.INTEGER;
				default: return SqlDataType.BLOB;
			}
		case 'binary':
			switch (expr.operator.toUpperCase()) {
				case '+': case '-': case '*': case '/': case '%':
				case '&': case '|': case '<<': case '>>':
					return SqlDataType.NUMERIC;
				case '||': return SqlDataType.TEXT;
				case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				case 'IS': case 'IS NOT': case 'IN': case 'LIKE': case 'GLOB': case 'BETWEEN':
					return SqlDataType.INTEGER;
				case 'AND': case 'OR':
					const leftAff = getExpressionAffinity(compiler, expr.left, correlation);
					const rightAff = getExpressionAffinity(compiler, expr.right, correlation);
					if (leftAff === SqlDataType.TEXT || rightAff === SqlDataType.TEXT) return SqlDataType.TEXT;
					if (leftAff === SqlDataType.BLOB || rightAff === SqlDataType.BLOB) return SqlDataType.BLOB;
					return SqlDataType.NUMERIC;
				default:
					return SqlDataType.BLOB;
			}
		case 'subquery':
			return SqlDataType.BLOB;
		case 'identifier':
			return getExpressionAffinity(compiler, { type: 'column', name: expr.name }, correlation);
		case 'collate':
			return getExpressionAffinity(compiler, expr.expr, correlation);
		default:
			return SqlDataType.BLOB;
	}
}

/**
 * Finds the schema for a column expression.
 *
 * @param compiler The compiler instance
 * @param expr The column expression
 * @param correlation Optional correlation info for subqueries
 * @returns The table and column schema, or null if not found or ambiguous
 */
export function resolveColumnSchema(compiler: Compiler, expr: AST.ColumnExpr, correlation?: SubqueryCorrelationResult): { table: TableSchema, column: ColumnSchema } | null {
	let cursor = -1;
	if (expr.table) {
		cursor = compiler.tableAliases.get(expr.table.toLowerCase()) ?? -1;
	} else {
		for (const [_, cIdx] of compiler.tableAliases.entries()) {
			const schema = compiler.tableSchemas.get(cIdx);
			if (schema?.columnIndexMap.has(expr.name.toLowerCase())) {
				if (cursor !== -1) {
					return null;
				}
				cursor = cIdx;
			}
		}
	}
	if (cursor === -1) return null;
	const tableSchema = compiler.tableSchemas.get(cursor);
	if (!tableSchema) return null;
	const colIdx = tableSchema.columnIndexMap.get(expr.name.toLowerCase());
	if (colIdx === undefined) {
		// Handle implicit rowid
		if (expr.name.toLowerCase() === 'rowid' && tableSchema.primaryKeyDefinition?.length === 0) {
			// TODO: Need a way to represent the implicit rowid column schema
			// For now, return null, caller needs to handle this case.
			return null;
		}
		return null;
	}
	const columnSchema = tableSchema.columns[colIdx];
	return { table: tableSchema, column: columnSchema };
}

/**
 * Determines the collation sequence for an expression.
 *
 * @param compiler The compiler instance
 * @param expr The expression to analyze
 * @param correlation Optional correlation info for subqueries
 * @returns The collation name
 */
export function getExpressionCollation(compiler: Compiler, expr: AST.Expression, correlation?: SubqueryCorrelationResult): string {
	switch (expr.type) {
		case 'literal': return 'BINARY';
		case 'column':
			const colInfo = resolveColumnSchema(compiler, expr, correlation);
			return colInfo?.column.collation || 'BINARY';
		case 'collate':
			return expr.collation.toUpperCase();
		case 'cast':
			return getExpressionCollation(compiler, expr.expr, correlation);
		case 'function':
			return 'BINARY';
		case 'parameter':
			return 'BINARY';
		case 'unary':
			return getExpressionCollation(compiler, expr.expr, correlation);
		case 'binary':
			switch (expr.operator.toUpperCase()) {
				case '||': case '+': case '-': case '*': case '/': case '%':
				case '&': case '|': case '<<': case '>>':
					return 'BINARY';
				case '=': case '==': case '!=': case '<>': case '<': case '<=': case '>': case '>=':
				case 'IS': case 'IS NOT': case 'LIKE': case 'GLOB': case 'BETWEEN': case 'IN':
					{
						const leftColl = getExpressionCollation(compiler, expr.left, correlation);
						const rightColl = getExpressionCollation(compiler, expr.right, correlation);
						if (leftColl !== 'BINARY' && rightColl === 'BINARY') return leftColl;
						if (rightColl !== 'BINARY' && leftColl === 'BINARY') return rightColl;
						return 'BINARY';
					}
				case 'AND': case 'OR':
					return 'BINARY';
				default:
					return 'BINARY';
			}
		case 'subquery':
			return 'BINARY';
		case 'identifier':
			return getExpressionCollation(compiler, { type: 'column', name: expr.name }, correlation);
		default:
			return 'BINARY';
	}
}

/**
 * Emits VDBE instructions to load a literal value into a register.
 *
 * @param compiler The compiler instance
 * @param value The SQL value to load
 * @param targetReg The register to load the value into
 */
export function compileLiteralValue(compiler: Compiler, value: SqlValue, targetReg: number): void {
	if (value === null) {
		compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, "Load NULL literal");
	} else if (typeof value === 'number') {
		if (Number.isSafeInteger(value)) {
			compiler.emit(Opcode.Integer, value, targetReg, 0, null, 0, `Load Integer literal: ${value}`);
		} else if (Number.isInteger(value)) {
			// Value is integer but outside safe range, store as Int64 constant
			const constIdx = compiler.addConstant(BigInt(value));
			compiler.emit(Opcode.Int64, 0, targetReg, 0, constIdx, 0, `Load Large Integer literal: ${value}`);
		} else {
			// Non-integer number, store as Real constant
			const constIdx = compiler.addConstant(value);
			compiler.emit(Opcode.Real, 0, targetReg, 0, constIdx, 0, `Load Float literal: ${value}`);
		}
	} else if (typeof value === 'string') {
		const constIdx = compiler.addConstant(value);
		compiler.emit(Opcode.String8, 0, targetReg, 0, constIdx, 0, `Load String literal`);
	} else if (value instanceof Uint8Array) {
		const constIdx = compiler.addConstant(value);
		compiler.emit(Opcode.Blob, value.length, targetReg, 0, constIdx, 0, "Load BLOB literal");
	} else if (typeof value === 'bigint') {
		const constIdx = compiler.addConstant(value);
		compiler.emit(Opcode.Int64, 0, targetReg, 0, constIdx, 0, `Load BigInt literal: ${value}`);
	} else if (typeof value === 'boolean') {
		// Store booleans as integers 0 or 1
		compiler.emit(Opcode.Integer, value ? 1 : 0, targetReg, 0, null, 0, `Load Boolean literal: ${value}`);
	} else {
		// Should not happen with SqlValue type, but good to have a fallback
		throw new Error(`Unsupported literal type for VDBE emission: ${typeof value}`);
	}
}
