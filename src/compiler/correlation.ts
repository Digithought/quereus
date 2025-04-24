import type { Compiler } from './compiler';
import type * as AST from '../parser/ast';
import { SqliteError } from '../common/errors';
import { StatusCode } from '../common/constants';

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
 */
export function analyzeSubqueryCorrelation(
	compiler: Compiler,
	subqueryAst: AST.AstNode,
	activeOuterCursors: ReadonlySet<number> // Cursors available in the *outer* scope
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

			// Identify cursors defined *at this level*
			sel.from?.forEach(fromClause => {
				const findCursors = (fc: AST.FromClause) => {
					if (fc.type === 'table') {
						const alias = (fc.alias || fc.table.name).toLowerCase();
						// Need to resolve alias -> cursor mapping. Assume compiler.tableAliases is up-to-date?
						// This is complex if called before FROM clause compilation.
						// Assume it runs *after* FROM clause sets aliases for the current scope.
						const cursorId = compiler.tableAliases.get(alias);
						if (cursorId !== undefined) {
							currentLevelAliases.set(alias, cursorId);
							currentLevelCursors.add(cursorId);
						} else {
							// This might happen if the SELECT is analyzed standalone before context is set
							console.warn(`Alias/Table ${alias} not found in global map during correlation analysis. Scope issue?`);
						}
					} else if (fc.type === 'join') {
						findCursors(fc.left);
						findCursors(fc.right);
					} else if (fc.type === 'functionSource') {
						// TVF introduces a cursor
						const alias = (fc.alias || fc.name.name).toLowerCase();
						const cursorId = compiler.tableAliases.get(alias);
						if (cursorId !== undefined) {
							currentLevelAliases.set(alias, cursorId);
							currentLevelCursors.add(cursorId);
						} else {
							console.warn(`Alias/TVF ${alias} not found in global map during correlation analysis. Scope issue?`);
						}
					}
					// Add other FROM clause types if necessary
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
			// Don't traverse ORDER BY or LIMIT here, they execute after the core selection

			return; // Finished processing this SELECT scope
		}

		// Fix: Handle Column and Identifier References with type guards
		if (node.type === 'column' || node.type === 'identifier') {
			let colName: string;
			let tableQualifier: string | undefined;

			if (node.type === 'column') {
				colName = (node as AST.ColumnExpr).name;
				tableQualifier = (node as AST.ColumnExpr).table;
			} else { // node.type === 'identifier'
				colName = (node as AST.IdentifierExpr).name;
				tableQualifier = undefined; // Identifiers are not qualified in this context
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
					console.warn(`Outer column ${colName} resolved to cursor ${outerCursor} but index not found in schema.`);
				}
			}
		}
		// --- Recurse into other expression types --- //
		else if (node.type === 'binary') { traverse((node as AST.BinaryExpr).left, availableCursors); traverse((node as AST.BinaryExpr).right, availableCursors); }
		else if (node.type === 'unary') { traverse((node as AST.UnaryExpr).expr, availableCursors); }
		else if (node.type === 'function') { (node as AST.FunctionExpr).args.forEach(arg => traverse(arg, availableCursors)); }
		else if (node.type === 'cast') { traverse((node as AST.CastExpr).expr, availableCursors); }
		else if (node.type === 'subquery') { traverse((node as AST.SubqueryExpr).query, availableCursors); }
		else if (node.type === 'collate') { traverse((node as AST.CollateExpr).expr, availableCursors); }
		// Identifier handled above
	};

	traverse(subqueryAst, activeOuterCursors);
	return result;
}
