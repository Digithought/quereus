import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import type { Compiler } from '../compiler.js';
import { warnLog } from './helpers.js';

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

export function calculateColumnUsage(
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
