import type { Compiler } from './compiler.js';
import type * as AST from '../parser/ast.js';
import { SqliteError } from '../common/errors.js';
import { StatusCode } from '../common/constants.js';
import { createLogger } from '../common/logger.js';

const warnLog = createLogger('compiler:correlation').extend('warn');

// --- Exports for Correlation Analysis ---
/** Type definition for correlated column info */
export interface CorrelatedColumnInfo {
	outerCursor: number;
	outerColumnIndex: number; // Relative to the outer table's schema
}

/** Result type for subquery correlation analysis */
export interface SubqueryCorrelationResult {
	isCorrelated: boolean;
	correlatedColumns: CorrelatedColumnInfo[];
}
// ---------------------------------------

/**
 * Analyzes a subquery AST to detect correlation with outer query cursors.
 *
 * @param compiler The compiler instance
 * @param subqueryAst The subquery AST to analyze
 * @param activeOuterCursors Set of cursors available in the outer scope
 * @returns Analysis result indicating if the subquery is correlated and which columns are involved
 */
export function analyzeSubqueryCorrelation(
	compiler: Compiler,
	subqueryAst: AST.AstNode,
	activeOuterCursors: ReadonlySet<number>
): SubqueryCorrelationResult {
	const result: SubqueryCorrelationResult = {
		isCorrelated: false,
		correlatedColumns: [],
	};
	const processedColumns = new Set<string>(); // Track "cursor.colIdx" to avoid duplicates

	// Recursive traversal function
	const traverse = (node: AST.AstNode | undefined | null, availableCursors: ReadonlySet<number>) => {
		if (!node) return;

		// Handle SELECT statements (introduces new scope)
		if (node.type === 'select') {
			const sel = node as AST.SelectStmt;
			const currentLevelAliases = new Map<string, number>();
			const currentLevelCursors = new Set<number>();

			// Identify cursors defined at this level
			sel.from?.forEach(fromClause => {
				const findCursors = (fc: AST.FromClause) => {
					if (fc.type === 'table') {
						const alias = (fc.alias || fc.table.name).toLowerCase();
						const cursorId = compiler.tableAliases.get(alias);
						if (cursorId !== undefined) {
							currentLevelAliases.set(alias, cursorId);
							currentLevelCursors.add(cursorId);
						} else {
							warnLog(`Alias/Table %s not found in global map during correlation analysis. Scope issue?`, alias);
						}
					} else if (fc.type === 'join') {
						findCursors(fc.left);
						findCursors(fc.right);
					} else if (fc.type === 'functionSource') {
						const alias = (fc.alias || fc.name.name).toLowerCase();
						const cursorId = compiler.tableAliases.get(alias);
						if (cursorId !== undefined) {
							currentLevelAliases.set(alias, cursorId);
							currentLevelCursors.add(cursorId);
						} else {
							warnLog(`Alias/TVF %s not found in global map during correlation analysis. Scope issue?`, alias);
						}
					}
				};
				findCursors(fromClause);
			});

			// Cursors available for expressions within this SELECT are outer + current level
			const nextAvailableCursors = new Set([...availableCursors, ...currentLevelCursors]);

			// Recurse into sub-components using the combined set of available cursors
			sel.columns.forEach(c => { if (c.type === 'column' && c.expr) traverse(c.expr, nextAvailableCursors); });
			traverse(sel.where, nextAvailableCursors);
			sel.groupBy?.forEach(g => traverse(g, nextAvailableCursors));
			traverse(sel.having, nextAvailableCursors);
			// ORDER BY and LIMIT execute after the core selection

			return; // Finished processing this SELECT scope
		}

		// Handle Column and Identifier References
		if (node.type === 'column' || node.type === 'identifier') {
			let colName: string;
			let tableQualifier: string | undefined;

			if (node.type === 'column') {
				colName = (node as AST.ColumnExpr).name;
				tableQualifier = (node as AST.ColumnExpr).table;
			} else { // identifier
				colName = (node as AST.IdentifierExpr).name;
				tableQualifier = undefined;
			}

			let sourceCursor = -1;
			let resolved = false;

			if (tableQualifier) {
				const aliasOrTable = tableQualifier.toLowerCase();
				const cursorId = compiler.tableAliases.get(aliasOrTable);
				if (cursorId !== undefined && availableCursors.has(cursorId)) {
					sourceCursor = cursorId;
					resolved = true;
				}
			} else {
				// Unqualified name resolution
				let foundCursorId = -1;
				let ambiguous = false;
				for (const cursorId of availableCursors) {
					const schema = compiler.tableSchemas.get(cursorId);
					if (schema?.columnIndexMap.has(colName.toLowerCase())) {
						if (foundCursorId !== -1) ambiguous = true;
						foundCursorId = cursorId;
					}
				}
				if (ambiguous) throw new SqliteError(`Ambiguous column in subquery correlation check: ${colName}`, StatusCode.ERROR, undefined, node.loc?.start.line, node.loc?.start.column);
				if (foundCursorId !== -1) {
					sourceCursor = foundCursorId;
					resolved = true;
				}
			}

			// Check if resolved column belongs to an outer scope
			if (resolved && activeOuterCursors.has(sourceCursor)) {
				const outerCursor = sourceCursor;
				const outerSchema = compiler.tableSchemas.get(outerCursor);
				const outerColIdx = outerSchema?.columnIndexMap.get(colName.toLowerCase()) ?? -1;
				if (outerColIdx !== -1) {
					result.isCorrelated = true;
					const key = `${outerCursor}.${outerColIdx}`;
					if (!processedColumns.has(key)) {
						result.correlatedColumns.push({ outerCursor: outerCursor, outerColumnIndex: outerColIdx });
						processedColumns.add(key);
					}
				} else {
					warnLog(`Outer column %s resolved to cursor %d but index not found in schema.`, colName, outerCursor);
				}
			}
		}
		// Recurse into other expression types
		else if (node.type === 'binary') { traverse((node as AST.BinaryExpr).left, availableCursors); traverse((node as AST.BinaryExpr).right, availableCursors); }
		else if (node.type === 'unary') { traverse((node as AST.UnaryExpr).expr, availableCursors); }
		else if (node.type === 'function') { (node as AST.FunctionExpr).args.forEach(arg => traverse(arg, availableCursors)); }
		else if (node.type === 'cast') { traverse((node as AST.CastExpr).expr, availableCursors); }
		else if (node.type === 'subquery') { traverse((node as AST.SubqueryExpr).query, availableCursors); }
		else if (node.type === 'collate') { traverse((node as AST.CollateExpr).expr, availableCursors); }
	};

	traverse(subqueryAst, activeOuterCursors);
	return result;
}
