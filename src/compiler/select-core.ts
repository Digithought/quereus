import type { Compiler } from './compiler.js';
import type { ColumnResultInfo } from './structs.js';
import type * as AST from '../parser/ast.js';
import type { SubqueryCorrelationResult } from './correlation';
import type { ArgumentMap } from './handlers';
import { Opcode } from '../vdbe/opcodes.js';

export function getSelectCoreStructure(
	compiler: Compiler,
	stmt: AST.SelectStmt,
	outerCursors: number[],
	correlation?: SubqueryCorrelationResult, // Optional correlation info
	argumentMap?: ArgumentMap
): { resultBaseReg: number, numCols: number, columnMap: ColumnResultInfo[] } {
	const savedResultColumns = compiler.resultColumns;
	const savedColumnAliases = compiler.columnAliases;
	compiler.resultColumns = [];
	compiler.columnAliases = [];

	// Determine the set of cursors defined *within* this SELECT statement
	const currentLevelCursors = new Set<number>();
	stmt.from?.forEach(fromClause => {
		const findCursors = (fc: AST.FromClause) => {
			if (fc.type === 'table') {
				const alias = (fc.alias || fc.table.name).toLowerCase();
				const cursorId = compiler.tableAliases.get(alias);
				if (cursorId !== undefined) currentLevelCursors.add(cursorId);
			} else if (fc.type === 'join') {
				findCursors(fc.left);
				findCursors(fc.right);
			}
		};
		findCursors(fromClause);
	});

	// Combine outer cursors passed in with cursors from this level
	const combinedActiveCursors = new Set([...outerCursors, ...currentLevelCursors]);

	let estimatedNumCols = 0;
	const hasStar = stmt.columns.some(c => c.type === 'all');
	if (hasStar) {
		combinedActiveCursors.forEach(cursorIdx => {
			const schema = compiler.tableSchemas.get(cursorIdx);
			const alias = [...compiler.tableAliases.entries()].find(([, cIdx]) => cIdx === cursorIdx)?.[0];
			const colSpec = stmt.columns.find(c => c.type === 'all' && c.table && (c.table.toLowerCase() === schema?.name.toLowerCase() || c.table.toLowerCase() === alias?.toLowerCase())) as AST.ResultColumn & { type: 'all' } | undefined;
			if (schema && (!colSpec || colSpec.table)) { // Check if star matches this cursor
				estimatedNumCols += (schema?.columns.filter(c => !c.hidden).length || 0);
			}
		});
	}
	estimatedNumCols += stmt.columns.filter(c => c.type === 'column').length;
	if (estimatedNumCols === 0) { estimatedNumCols = 1; } // Ensure at least one cell

	const resultBase = compiler.allocateMemoryCells(estimatedNumCols);
	let actualNumCols = 0;
	const columnMap: ColumnResultInfo[] = [];

	let currentResultReg = resultBase;
	for (const column of stmt.columns) {
		if (column.type === 'all') {
			combinedActiveCursors.forEach(cursorIdx => {
				const tableSchema = compiler.tableSchemas.get(cursorIdx);
				const alias = [...compiler.tableAliases.entries()].find(([, cIdx]) => cIdx === cursorIdx)?.[0];
				// Check if this cursor matches the qualified star (e.g., t.*)
				if (tableSchema && (!column.table || column.table.toLowerCase() === alias?.toLowerCase() || column.table.toLowerCase() === tableSchema.name.toLowerCase())) {
					tableSchema.columns.forEach((colSchema) => {
						if (!colSchema.hidden) {
							const targetReg = currentResultReg++;
							const colIdx = tableSchema.columnIndexMap.get(colSchema.name.toLowerCase());
							if (colIdx === undefined && colSchema.name.toLowerCase() !== 'rowid') {
								compiler.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Expand *: Col ${colSchema.name} Idx Error`);
								columnMap.push({ targetReg, sourceCursor: cursorIdx, sourceColumnIndex: -1 });
							} else {
								compiler.emit(Opcode.VColumn, cursorIdx, colIdx ?? -1, targetReg, 0, 0, `Expand *: ${alias || tableSchema.name}.${colSchema.name}`);
								const colExpr: AST.ColumnExpr = { type: 'column', name: colSchema.name, table: alias || tableSchema.name };
								columnMap.push({ targetReg, sourceCursor: cursorIdx, sourceColumnIndex: colIdx ?? -1, expr: colExpr });
							}
							const fullName = `${alias || tableSchema.name}.${colSchema.name}`;
							compiler.resultColumns.push({ name: fullName });
							compiler.columnAliases.push(fullName);
							actualNumCols++;
						}
					});
				}
			});
		} else if (column.expr) {
			const targetReg = currentResultReg++;
			// We only determine the target register here; compilation happens per-row.

			let sourceCursor = -1;
			let sourceColumnIndex = -1;
			if (column.expr.type === 'column') {
				const colExpr = column.expr as AST.ColumnExpr;
				if (colExpr.table) {
					sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				} else {
					for (const cIdx of combinedActiveCursors) {
						const schema = compiler.tableSchemas.get(cIdx);
						if (schema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
							if (sourceCursor !== -1) {
								// Ambiguous - reset source info
								sourceCursor = -1;
								sourceColumnIndex = -1;
								break;
							};
							sourceCursor = cIdx;
						}
					}
				}
				if (sourceCursor !== -1) {
					sourceColumnIndex = compiler.tableSchemas.get(sourceCursor)?.columnIndexMap.get(colExpr.name.toLowerCase()) ?? -1;
				}
			}
			columnMap.push({ targetReg, sourceCursor, sourceColumnIndex, expr: column.expr });
			let colName = column.alias || (column.expr.type === 'column' ? (column.expr as AST.ColumnExpr).name : `col${actualNumCols + 1}`);
			compiler.columnAliases.push(colName);
			compiler.resultColumns.push({ name: colName, expr: column.expr });
			actualNumCols++;
		}
	}

	// WHERE, GROUP BY, HAVING, ORDER BY are handled by the caller (compileSelectStatement)

	compiler.resultColumns = savedResultColumns;
	compiler.columnAliases = savedColumnAliases;
	return { resultBaseReg: resultBase, numCols: actualNumCols, columnMap };
}
