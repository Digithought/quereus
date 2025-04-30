import { IndexConstraintOp, StatusCode } from '../common/constants.js';
import { SqliteError } from '../common/errors.js';
import type { Compiler, CursorPlanningResult } from './compiler.js';
import type { TableSchema } from '../schema/table.js';
import type * as AST from '../parser/ast.js';
import type { IndexInfo, IndexConstraint, IndexOrderBy } from '../vtab/indexInfo.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('compiler:plan');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

// --- Query Planning Helpers --- //

/** Result type for constraint extraction */
export interface ConstraintExtractionResult {
	constraints: IndexConstraint[];
	constraintExpressions: Map<number, AST.Expression>;
	handledNodes: Set<AST.Expression>;
}

/**
 * Traverses an expression AST to find all referenced columns.
 * Returns a map where keys are cursor indices and values are sets of column indices for that cursor.
 */
function findReferencedColumns(compiler: Compiler, expr: AST.Expression | undefined, activeCursors: ReadonlySet<number>): Map<number, Set<number>> {
	const referenced: Map<number, Set<number>> = new Map();
	if (!expr) return referenced;

	const traverse = (node: AST.Expression) => {
		if (node.type === 'column') {
			const colExpr = node as AST.ColumnExpr;
			let foundCursor = -1;
			if (colExpr.table) {
				foundCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
			} else {
				let ambiguous = false;
				for (const cursorId of activeCursors) {
					const schema = compiler.tableSchemas.get(cursorId);
					if (schema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
						if (foundCursor !== -1) ambiguous = true;
						foundCursor = cursorId;
					}
				}
				if (ambiguous) throw new SqliteError(`Ambiguous column reference in usage analysis: ${colExpr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
			}

			if (activeCursors.has(foundCursor)) {
				const schema = compiler.tableSchemas.get(foundCursor);
				const colIdx = schema?.columnIndexMap.get(colExpr.name.toLowerCase());
				if (colIdx !== undefined) {
					if (!referenced.has(foundCursor)) {
						referenced.set(foundCursor, new Set());
					}
					referenced.get(foundCursor)!.add(colIdx);
				} else if (colExpr.name.toLowerCase() === 'rowid') {
					if (!referenced.has(foundCursor)) {
						referenced.set(foundCursor, new Set());
					}
					referenced.get(foundCursor)!.add(-1); // Use -1 for rowid
				}
			}
		} else if (node.type === 'binary') {
			traverse(node.left);
			traverse(node.right);
		} else if (node.type === 'unary') {
			traverse(node.expr);
		} else if (node.type === 'function') {
			node.args.forEach(traverse);
		} else if (node.type === 'cast') {
			traverse(node.expr);
		} else if (node.type === 'subquery') {
			warnLog("Subquery column usage analysis not implemented for colUsed mask.");
		} else if (node.type === 'collate') {
			traverse(node.expr);
		} else if (node.type === 'identifier') {
            // Treat identifier as column for usage analysis
            traverse({ type: 'column', name: node.name, loc: node.loc });
        }
	};

	traverse(expr);
	return referenced;
}

/** Calculate the colUsed bitmask for a specific cursor index */
function calculateColumnUsage(
	compiler: Compiler,
	cursorIdx: number,
	selectColumns: AST.ResultColumn[],
	whereExpr: AST.Expression | undefined,
	orderByExprs: AST.OrderByClause[] | undefined
): bigint {
	let mask = BigInt(0);
	const activeCursors = new Set(compiler.tableAliases.values());
	const schema = compiler.tableSchemas.get(cursorIdx);
	if (!schema) return mask;

	const addColToMask = (colIdx: number) => {
		if (colIdx >= 0 && colIdx < 63) {
			mask |= (BigInt(1) << BigInt(colIdx));
		} else if (colIdx === -1) {
			mask |= (BigInt(1) << BigInt(63));
		}
	};

	selectColumns.forEach(rc => {
		if (rc.type === 'all') {
			let match = false;
			if (!rc.table) {
				match = true;
			} else {
				const aliasOrTableName = rc.table.toLowerCase();
				if (compiler.tableAliases.get(aliasOrTableName) === cursorIdx) {
					match = true;
				}
			}
			if (match) {
				schema.columns.forEach((col, idx) => { if (!col.hidden) addColToMask(idx); });
				addColToMask(-1); // Add rowid for ROWID tables
			}
		} else if (rc.expr) {
			const refs = findReferencedColumns(compiler, rc.expr, activeCursors);
			refs.get(cursorIdx)?.forEach(addColToMask);
		}
	});

	if (whereExpr) {
		const refs = findReferencedColumns(compiler, whereExpr, activeCursors);
		refs.get(cursorIdx)?.forEach(addColToMask);
	}

	if (orderByExprs) {
		orderByExprs.forEach(ob => {
			const refs = findReferencedColumns(compiler, ob.expr, activeCursors);
			refs.get(cursorIdx)?.forEach(addColToMask);
		});
	}

	schema.primaryKeyDefinition?.forEach(def => {
		if (def.index >= 0 && def.index < schema.columns.length) {
			addColToMask(def.index);
		}
	});

	return mask;
}

/** Extracts constraints and identifies handled nodes */
function extractConstraints(compiler: Compiler, cursorIdx: number, tableSchema: TableSchema, whereExpr: AST.Expression | undefined, activeOuterCursors: ReadonlySet<number>): ConstraintExtractionResult {
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
	}

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

export function planTableAccessHelper(
	compiler: Compiler,
	cursorIdx: number,
	tableSchema: TableSchema,
	stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt,
	activeOuterCursors: ReadonlySet<number>
): void {
	// Get the module associated with the table schema
	const module = tableSchema.vtabModule;

	// Check if the module provides xBestIndex
	if (typeof module.xBestIndex !== 'function') {
		compiler.cursorPlanningInfo.set(cursorIdx, {
			idxNum: 0,
			idxStr: null,
			usage: [],
			cost: 1e10,
			rows: BigInt(1000000),
			orderByConsumed: false,
			constraints: [],
			constraintExpressions: new Map(),
			handledWhereNodes: new Set(),
		});
		return;
	}

	const whereExpr = stmt.type === 'select' || stmt.type === 'update' || stmt.type === 'delete' ? stmt.where : undefined;
	const orderByExprs = stmt.type === 'select' ? stmt.orderBy : undefined;
	const selectColumns = stmt.type === 'select' ? stmt.columns : [];

	const { constraints, constraintExpressions, handledNodes } = extractConstraints(
		compiler, cursorIdx, tableSchema, whereExpr, activeOuterCursors
	);

	const orderBy: IndexOrderBy[] = [];
	if (orderByExprs) {
		orderByExprs.forEach(ob => {
			if (ob.expr.type === 'column') {
				const colExpr = ob.expr as AST.ColumnExpr;
				const colNameLower = colExpr.name.toLowerCase();
				let sourceCursor = -1;
				if (colExpr.table) {
					sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				} else {
					if (tableSchema.columnIndexMap.has(colNameLower)) {
						sourceCursor = cursorIdx;
						for (const outerC of activeOuterCursors) {
							if (compiler.tableSchemas.get(outerC)?.columnIndexMap.has(colNameLower)) {
								sourceCursor = -1;
								break;
							}
						}
					} else {
						for (const outerC of activeOuterCursors) {
							if (compiler.tableSchemas.get(outerC)?.columnIndexMap.has(colNameLower)) {
								sourceCursor = outerC;
								break;
							}
						}
					}
				}

				if (sourceCursor === cursorIdx) {
					const colIdx = tableSchema.columnIndexMap.get(colNameLower);
					if (colIdx !== undefined) {
						orderBy.push({ iColumn: colIdx, desc: ob.direction === 'desc' });
					} else if (colNameLower === 'rowid') {
						orderBy.push({ iColumn: -1, desc: ob.direction === 'desc' });
					}
				}
			} else {
				warnLog("Skipping non-column ORDER BY term for xBestIndex planning");
			}
		});
	}

	const colUsed = calculateColumnUsage(compiler, cursorIdx, selectColumns, whereExpr, orderByExprs);

	const indexInfo: IndexInfo = {
		nConstraint: constraints.length,
		aConstraint: Object.freeze([...constraints]),
		nOrderBy: orderBy.length,
		aOrderBy: Object.freeze([...orderBy]),
		colUsed: colUsed,
		aConstraintUsage: Array.from({ length: constraints.length }, () => ({ argvIndex: 0, omit: false })),
		idxNum: 0,
		idxStr: null,
		orderByConsumed: false,
		estimatedCost: 1e10,
		estimatedRows: BigInt(1000000),
		idxFlags: 0,
	};

	let status: number;
	try {
		// Call xBestIndex on the *module*, passing db and table schema
		status = module.xBestIndex(compiler.db, tableSchema, indexInfo);
	} catch (e) {
		errorLog(`Error calling module xBestIndex for %s: %O`, tableSchema.name, e);
		status = StatusCode.ERROR;
	}

	if (status !== StatusCode.OK) {
		throw new SqliteError(`xBestIndex failed for table ${tableSchema.name} with code ${status}`, status, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
	}

	const planResult: CursorPlanningResult = {
		idxNum: indexInfo.idxNum,
		idxStr: indexInfo.idxStr,
		usage: indexInfo.aConstraintUsage,
		cost: indexInfo.estimatedCost,
		rows: indexInfo.estimatedRows,
		orderByConsumed: indexInfo.orderByConsumed,
		constraints: [...indexInfo.aConstraint],
		constraintExpressions: constraintExpressions,
		handledWhereNodes: handledNodes,
	};
	compiler.cursorPlanningInfo.set(cursorIdx, planResult);

	log(`Plan: %s (cursor %d, outer: %s) -> idxNum=%d cost=%.2f rows=%d usage=%j handled=%d colUsed=%s`, tableSchema.name, cursorIdx, [...activeOuterCursors].join(','), planResult.idxNum, planResult.cost, planResult.rows, planResult.usage, planResult.handledWhereNodes.size, colUsed.toString(2));
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
