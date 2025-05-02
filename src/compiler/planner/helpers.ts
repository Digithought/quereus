import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import type { IndexOrderBy, IndexInfo } from '../../vtab/indexInfo.js';
import type { Compiler, CursorPlanningResult } from '../compiler.js';
import { extractConstraints } from './constraints.js';
import { calculateColumnUsage } from './columns.js';
import type { PlannedStep } from './types.js';
import { createLogger } from '../../common/logger.js';

// Define and export loggers at the top level
export const log = createLogger('compiler:plan');
export const warnLog = log.extend('warn');
export const errorLog = log.extend('error');

/** Helper to get the primary alias associated with a planned step */
export function getStepPrimaryAlias(step: PlannedStep): string {
	if (step.type === 'Scan') {
		return step.relation.alias;
	} else if (step.type === 'Join') {
		// The alias of a join step could be ambiguous, return a composite representation?
		// Or perhaps the 'outputRelation' should store a primary alias?
		// For now, use the outer step's alias as a placeholder.
		return getStepPrimaryAlias(step.outerStep);
	}
	return 'unknown_step';
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
			nOrderBy: 0,
			aOrderBy: [],
			colUsed: BigInt(-1),
			idxFlags: 0,
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
		constraints: [...indexInfo.aConstraint],
		constraintExpressions: constraintExpressions,
		handledWhereNodes: handledNodes,
		cost: indexInfo.estimatedCost,
		rows: indexInfo.estimatedRows,
		orderByConsumed: indexInfo.orderByConsumed,
		nOrderBy: indexInfo.nOrderBy,
		aOrderBy: indexInfo.aOrderBy,
		colUsed: indexInfo.colUsed,
		idxFlags: indexInfo.idxFlags,
	};
	compiler.cursorPlanningInfo.set(cursorIdx, planResult);

	log(`Plan: %s (cursor %d, outer: %s) -> idxNum=%d cost=%.2f rows=%s usage=%j handled=%d colUsed=%s`,
		tableSchema.name,
		cursorIdx,
		[...activeOuterCursors].join(','),
		planResult.idxNum,
		planResult.cost,
		planResult.rows.toString(),
		planResult.usage,
		planResult.handledWhereNodes.size,
		colUsed.toString(2)
	);
}

