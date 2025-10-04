import type * as AST from '../parser/ast.js';
import { generateDeclaredDDL } from './catalog.js';

/**
 * Computes a hash of a declared schema for versioning
 */
export async function computeSchemaHash(declaredSchema: AST.DeclareSchemaStmt): Promise<string> {
	// Generate canonical DDL representation
	const ddlStatements = generateDeclaredDDL(declaredSchema);
	const canonicalText = ddlStatements.join('\n');

	// Compute SHA-256 hash
	const hash = await sha256(canonicalText);
	return hash;
}

/**
 * Computes SHA-256 hash of a string
 */
async function sha256(message: string): Promise<string> {
	// Use Node.js crypto if available, otherwise Web Crypto API
	if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
		// Web Crypto API
		const encoder = new TextEncoder();
		const data = encoder.encode(message);
		const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	} else {
		// Node.js crypto
		const crypto = await import('node:crypto');
		return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
	}
}

/**
 * Computes a short hash (first 12 characters) for display
 */
export async function computeShortSchemaHash(declaredSchema: AST.DeclareSchemaStmt): Promise<string> {
	const fullHash = await computeSchemaHash(declaredSchema);
	return fullHash.substring(0, 12);
}


