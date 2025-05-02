import { IndexConstraintOp } from '../../common/constants.js';
import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import type { IndexConstraint } from '../../vtab/indexInfo.js';
import type { Compiler } from '../compiler.js';
import { log, warnLog } from './helpers.js';
import type { ConstraintExtractionResult } from './types.js';

/** Extracts constraints and identifies handled nodes */
export function extractConstraints(compiler: Compiler, cursorIdx: number, tableSchema: TableSchema, whereExpr: AST.Expression | undefined, activeOuterCursors: ReadonlySet<number>): ConstraintExtractionResult {
	const constraints: IndexConstraint[] = [];
	const constraintExpressions: Map<number, AST.Expression> = new Map();
	const handledNodes = new Set<AST.Expression>();

	const isOuterExpr = (expr: AST.Expression): boolean => {
		if (expr.type === 'literal' || expr.type === 'parameter') return true;
		if (expr.type === 'column') {
			const colExpr = expr as AST.ColumnExpr;
			let sourceCursor = -1;
			if (colExpr.table) {
				sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
			} else {
				let foundInTarget = false;
				let foundInOuter = false;
				let ambiguous = false;
				if (tableSchema.columnIndexMap.has(colExpr.name.toLowerCase())) {
					foundInTarget = true;
					sourceCursor = cursorIdx;
				}
				for (const otherCursorId of compiler.tableAliases.values()) {
					if (otherCursorId === cursorIdx) continue;
					const otherSchema = compiler.tableSchemas.get(otherCursorId);
					if (otherSchema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
						if (foundInTarget || foundInOuter) ambiguous = true;
						sourceCursor = otherCursorId;
						foundInOuter = true;
					}
				}
				if (ambiguous) throw new SqliteError(`Ambiguous column in constraint analysis: ${colExpr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
			}
			return sourceCursor !== -1 && sourceCursor !== cursorIdx;
		}
		if (expr.type === 'binary') {
			return isOuterExpr(expr.left) && isOuterExpr(expr.right);
		}
		if (expr.type === 'unary') {
			return isOuterExpr(expr.expr);
		}
		if (expr.type === 'function') {
			return expr.args.every(isOuterExpr);
		}
		if (expr.type === 'subquery') {
			return false;
		}
		if (expr.type === 'cast') {
			return isOuterExpr(expr.expr);
		}
		if (expr.type === 'collate') {
			return isOuterExpr(expr.expr);
		}
		return false;
	};

	const traverse = (expr: AST.Expression | undefined) => {
		if (!expr) return;
		if (handledNodes.has(expr)) return;

		if (expr.type === 'unary' && (expr.operator.toUpperCase() === 'IS NULL' || expr.operator.toUpperCase() === 'IS NOT NULL')) {
			if (expr.expr.type === 'column') {
				const colExpr = expr.expr;
				const colNameLower = colExpr.name.toLowerCase();
				let sourceCursor = -1;
				if (colExpr.table) {
					sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				} else {
					if (tableSchema.columnIndexMap.has(colNameLower)) {
						sourceCursor = cursorIdx;
					}
				}

				if (sourceCursor === cursorIdx) {
					const colIdx = tableSchema.columnIndexMap.get(colNameLower);
					if (colIdx !== undefined) {
						const op = expr.operator.toUpperCase() === 'IS NULL' ? IndexConstraintOp.ISNULL : IndexConstraintOp.ISNOTNULL;
						const constraintIdx = constraints.length;
						constraints.push({ iColumn: colIdx, op: op, usable: true });
						constraintExpressions.set(constraintIdx, expr);
						handledNodes.add(expr);
					}
				}
			}
			return;
		}

		if (expr.type === 'binary') {
			const binExpr = expr as AST.BinaryExpr;
			if (binExpr.operator.toUpperCase() === 'AND') {
				traverse(binExpr.left);
				traverse(binExpr.right);
				return;
			}
			if (binExpr.operator.toUpperCase() === 'OR') {
				log("Skipping OR constraint for xBestIndex planning.");
				return;
			}

			if (binExpr.operator.toUpperCase() === 'BETWEEN') {
				if (binExpr.left.type === 'column' && binExpr.right.type === 'binary' && binExpr.right.operator.toUpperCase() === 'AND') {
					const colExpr = binExpr.left;
					const lowerBoundExpr = binExpr.right.left;
					const upperBoundExpr = binExpr.right.right;
					const geExpr: AST.BinaryExpr = { type: 'binary', operator: '>=', left: colExpr, right: lowerBoundExpr, loc: binExpr.loc };
					const leExpr: AST.BinaryExpr = { type: 'binary', operator: '<=', left: colExpr, right: upperBoundExpr, loc: binExpr.loc };
					traverse(geExpr);
					traverse(leExpr);
				} else {
					warnLog("Unsupported BETWEEN structure for planning.");
				}
				return;
			}

			if (binExpr.operator.toUpperCase() === 'IN') {
				if (binExpr.left.type === 'column' && binExpr.right.type === 'function' && binExpr.right.name === '_list_') {
					const colExpr = binExpr.left;
					const listValues = binExpr.right.args;
					let sourceCursor = -1;
					const colNameLower = colExpr.name.toLowerCase();
					if (colExpr.table) {
						sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
					} else {
						if (tableSchema.columnIndexMap.has(colNameLower)) {
							sourceCursor = cursorIdx;
						}
					}

					if (sourceCursor === cursorIdx && listValues.every(isOuterExpr)) {
						const colIdx = tableSchema.columnIndexMap.get(colNameLower);
						if (colIdx !== undefined) {
							listValues.forEach(valueExpr => {
								const constraintIdx = constraints.length;
								constraints.push({ iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true });
								constraintExpressions.set(constraintIdx, valueExpr);
							});
							handledNodes.add(binExpr);
						}
					}
				} else if (binExpr.right.type === 'subquery') {
					warnLog("IN (subquery) constraint skipped for xBestIndex planning.");
				}
				return;
			}

			let colExpr: AST.ColumnExpr | undefined;
			let valueExpr: AST.Expression | undefined;
			let op: IndexConstraintOp | undefined;
			let swapped = false;
			let colCursor = -1;

			if (binExpr.left.type === 'column') {
				colExpr = binExpr.left;
				valueExpr = binExpr.right;
				op = mapAstOperatorToConstraintOp(binExpr.operator);
				if (colExpr.table) colCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				else if (tableSchema.columnIndexMap.has(colExpr.name.toLowerCase())) colCursor = cursorIdx;
			} else if (binExpr.right.type === 'column') {
				colExpr = binExpr.right;
				valueExpr = binExpr.left;
				swapped = true;
				op = mapAstOperatorToConstraintOp(binExpr.operator, true);
				if (colExpr.table) colCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				else if (tableSchema.columnIndexMap.has(colExpr.name.toLowerCase())) colCursor = cursorIdx;
			}

			if (colExpr && op && valueExpr && colCursor === cursorIdx) {
				if (isOuterExpr(valueExpr)) {
					const colIdx = tableSchema.columnIndexMap.get(colExpr.name.toLowerCase());
					if (colIdx !== undefined) {
						const constraintIdx = constraints.length;
						constraints.push({ iColumn: colIdx, op: op, usable: true });
						constraintExpressions.set(constraintIdx, valueExpr);
						handledNodes.add(binExpr);
					}
				} else {
					log(`Skipping constraint for xBestIndex (value references target table): %s %s ...`, colExpr.name, binExpr.operator);
				}
			}
			else if (binExpr.left.type === 'column' && binExpr.right.type === 'column') {
				const col1 = binExpr.left;
				const col2 = binExpr.right;
				const col1Cursor = compiler.tableAliases.get(col1.table?.toLowerCase() ?? '') ?? (tableSchema.columnIndexMap.has(col1.name.toLowerCase()) ? cursorIdx : -1);
				const col2Cursor = compiler.tableAliases.get(col2.table?.toLowerCase() ?? '') ?? (tableSchema.columnIndexMap.has(col2.name.toLowerCase()) ? cursorIdx : -1);

				let targetCol: AST.ColumnExpr | undefined;
				let outerCol: AST.ColumnExpr | undefined;
				let effectiveOp: IndexConstraintOp | undefined;

				if (col1Cursor === cursorIdx && col2Cursor !== -1 && col2Cursor !== cursorIdx) {
					targetCol = col1;
					outerCol = col2;
					effectiveOp = mapAstOperatorToConstraintOp(binExpr.operator, false);
				} else if (col2Cursor === cursorIdx && col1Cursor !== -1 && col1Cursor !== cursorIdx) {
					targetCol = col2;
					outerCol = col1;
					effectiveOp = mapAstOperatorToConstraintOp(binExpr.operator, true);
				}

				if (targetCol && outerCol && effectiveOp) {
					const colIdx = tableSchema.columnIndexMap.get(targetCol.name.toLowerCase());
					if (colIdx !== undefined) {
						const constraintIdx = constraints.length;
						constraints.push({ iColumn: colIdx, op: effectiveOp, usable: true });
						constraintExpressions.set(constraintIdx, outerCol);
						handledNodes.add(binExpr);
					}
				}
			}
		}
	};

	traverse(whereExpr);

	return { constraints, constraintExpressions, handledNodes };
}

function mapAstOperatorToConstraintOp(op: string, swapped: boolean = false): IndexConstraintOp | undefined {
	const upperOp = op.toUpperCase();
	switch (upperOp) {
		case '=': case '==': return IndexConstraintOp.EQ;
		case '<': return swapped ? IndexConstraintOp.GT : IndexConstraintOp.LT;
		case '<=': return swapped ? IndexConstraintOp.GE : IndexConstraintOp.LE;
		case '>': return swapped ? IndexConstraintOp.LT : IndexConstraintOp.GT;
		case '>=': return swapped ? IndexConstraintOp.LE : IndexConstraintOp.GE;
		case '!=': case '<>': return IndexConstraintOp.NE;
		case 'IS': return IndexConstraintOp.IS;
		case 'IS NOT': return IndexConstraintOp.ISNOT;
		case 'LIKE': return IndexConstraintOp.LIKE;
		case 'GLOB': return IndexConstraintOp.GLOB;
		case 'REGEXP': return IndexConstraintOp.REGEXP;
		case 'MATCH': return IndexConstraintOp.MATCH;
		default: return undefined;
	}
}
