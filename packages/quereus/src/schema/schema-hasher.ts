import type * as AST from '../parser/ast.js';
import { generateDeclaredDDL } from './catalog.js';
import { fnv1aHash, toBase64Url } from '../util/hash.js';

/**
 * Strips tags from a declared schema AST so they don't affect hash computation.
 * Tags are informational metadata and must not influence schema versioning.
 */
function stripTagsFromDeclaredSchema(schema: AST.DeclareSchemaStmt): AST.DeclareSchemaStmt {
	return {
		...schema,
		items: schema.items.map(item => {
			if (item.type === 'declaredTable') {
				const { tags: _t, ...tableStmt } = item.tableStmt;
				return {
					...item,
					tableStmt: {
						...tableStmt,
						columns: tableStmt.columns.map(col => {
							const { tags: _ct, ...colRest } = col;
							return {
								...colRest,
								constraints: col.constraints.map(c => {
									const { tags: _cct, ...cRest } = c;
									return cRest;
								}),
							};
						}),
						constraints: tableStmt.constraints.map(c => {
							const { tags: _tct, ...cRest } = c;
							return cRest;
						}),
					},
				};
			}
			if (item.type === 'declaredIndex') {
				const { tags: _it, ...indexStmt } = item.indexStmt;
				return { ...item, indexStmt };
			}
			if (item.type === 'declaredView') {
				const { tags: _vt, ...viewStmt } = item.viewStmt;
				return { ...item, viewStmt };
			}
			return item;
		}),
	};
}

/**
 * Computes a hash of a declared schema for versioning
 */
export function computeSchemaHash(declaredSchema: AST.DeclareSchemaStmt): string {
	// Strip tags before generating DDL — tags are non-behavioral metadata
	const strippedSchema = stripTagsFromDeclaredSchema(declaredSchema);
	const ddlStatements = generateDeclaredDDL(strippedSchema);
	const canonicalText = ddlStatements.join('\n');

	// Compute hash using FNV-1a algorithm and encode as base64url
	const hashBytes = fnv1aHash(canonicalText);
	return toBase64Url(hashBytes);
}

/**
 * Computes a short hash (first 8 characters) for display
 */
export function computeShortSchemaHash(declaredSchema: AST.DeclareSchemaStmt): string {
	const fullHash = computeSchemaHash(declaredSchema);
	return fullHash.substring(0, 8);
}


