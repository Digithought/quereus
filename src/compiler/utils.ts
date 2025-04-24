import type { Compiler } from './compiler';
import type * as AST from '../parser/ast';
import { SqlDataType } from '../common/constants';
import { getAffinityForType } from '../schema/schema';
import type { TableSchema } from '../schema/table';
import type { ColumnSchema } from '../schema/column';
import type { SubqueryCorrelationResult } from './correlation';

/** Determines the affinity of an expression. */
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
					const affLeft = getExpressionAffinity(compiler, expr.left, correlation);
					const affRight = getExpressionAffinity(compiler, expr.right, correlation);
					if (affLeft === SqlDataType.TEXT || affRight === SqlDataType.TEXT) return SqlDataType.TEXT;
					if (affLeft === SqlDataType.BLOB || affRight === SqlDataType.BLOB) return SqlDataType.BLOB;
					return SqlDataType.NUMERIC;
				default: return SqlDataType.BLOB;
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

/** Helper to find the schema for a column expression */
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
		if (expr.name.toLowerCase() === 'rowid' && tableSchema.primaryKeyDefinition?.length === 0 && !tableSchema.isVirtual) {
			// TODO: Need a way to represent the implicit rowid column schema
			// For now, return null, caller needs to handle this case.
			return null;
		}
		return null;
	}
	const columnSchema = tableSchema.columns[colIdx];
	return { table: tableSchema, column: columnSchema };
}

/** Determines the collation sequence for an expression. */
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
