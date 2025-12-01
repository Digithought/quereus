import type * as AST from '../parser/ast.js';
import { generateDeclaredDDL } from './catalog.js';
import { fnv1aHash, toBase64Url } from '../util/hash.js';

/**
 * Computes a hash of a declared schema for versioning
 */
export function computeSchemaHash(declaredSchema: AST.DeclareSchemaStmt): string {
	// Generate canonical DDL representation
	const ddlStatements = generateDeclaredDDL(declaredSchema);
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


