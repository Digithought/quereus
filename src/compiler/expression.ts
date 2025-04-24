import { StatusCode, SqlDataType } from '../common/types';
import { SqliteError } from '../common/errors';
import type { Compiler, HavingContext, SubroutineInfo } from './compiler';
import type * as AST from '../parser/ast';
import { type SubqueryCorrelationResult } from './correlation';
import type { TableSchema } from '../schema/table';
import type { ColumnSchema } from '../schema/column';
import { getAffinityForType } from '../schema/schema'; // Need a way to get affinity from type string
import type { ArgumentMap } from './handlers'; // Removed .ts extension
// Import specific handlers
import { compileColumn, compileBinary, compileUnary, compileCast, compileFunction, compileParameter, compileCollate } from './handlers'; // Removed .ts extension
import { compileLiteralValue } from './utils';
// Subquery compilation is delegated differently in Compiler class, handled there.
// No need to import subquery handlers here.

// Export ArgumentMap type
export type { ArgumentMap } from './handlers'; // Removed .ts extension

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
				// Avoid marking as ambiguous if the column only exists in one schema accessible here.
				// If we find it again, it IS ambiguous.
				if (cursor !== -1) {
					// Ambiguous case - return null here, let compileColumn handle the error with location
					return null;
				}
				cursor = cIdx;
				// Don't break immediately, need to check for ambiguity
			}
		}
	}
	// If cursor is still -1 after checking all aliases, the column wasn't found.
	if (cursor === -1) return null; // Not found
	const tableSchema = compiler.tableSchemas.get(cursor);
	if (!tableSchema) return null; // Should not happen if alias map is consistent
	const colIdx = tableSchema.columnIndexMap.get(expr.name.toLowerCase());
	if (colIdx === undefined) return null; // Column name not in the resolved schema
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

/**
 * Main dispatcher for compiling any expression AST node.
 * Delegates to specific handlers in ./expression/handlers.ts
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
		default:
			throw new SqliteError(`Unsupported expression type: ${(expr as any).type}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
	}
}

// No need to export handlers or utils directly from here, they are imported by this module or delegated by Compiler class.
