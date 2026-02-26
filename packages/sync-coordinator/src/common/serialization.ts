/**
 * Shared ChangeSet serialization for JSON transport.
 *
 * Used by both the WebSocket handler and the CoordinatorService
 * for consistent wire format.
 */

import {
	siteIdFromBase64,
	siteIdToBase64,
	deserializeHLC,
	serializeHLC,
	type ChangeSet,
} from '@quereus/sync';

/**
 * Serialize a ChangeSet for JSON transport.
 * Converts binary fields (siteId, HLCs) to base64 strings.
 */
export function serializeChangeSet(cs: ChangeSet): object {
	return {
		siteId: siteIdToBase64(cs.siteId),
		transactionId: cs.transactionId,
		hlc: Buffer.from(serializeHLC(cs.hlc)).toString('base64'),
		changes: cs.changes.map(c => ({
			...c,
			hlc: Buffer.from(serializeHLC(c.hlc)).toString('base64'),
		})),
		schemaMigrations: cs.schemaMigrations.map(m => ({
			...m,
			hlc: Buffer.from(serializeHLC(m.hlc)).toString('base64'),
		})),
	};
}

/**
 * Deserialize a ChangeSet from JSON transport format.
 * Converts base64 strings back to binary fields.
 */
export function deserializeChangeSet(cs: unknown): ChangeSet {
	const obj = cs as Record<string, unknown>;
	return {
		siteId: siteIdFromBase64(obj.siteId as string),
		transactionId: obj.transactionId as string,
		hlc: deserializeHLC(Buffer.from(obj.hlc as string, 'base64')),
		changes: (obj.changes as Record<string, unknown>[]).map(c => ({
			...c,
			hlc: deserializeHLC(Buffer.from(c.hlc as string, 'base64')),
		})),
		schemaMigrations: ((obj.schemaMigrations as Record<string, unknown>[]) || []).map(m => ({
			...m,
			hlc: deserializeHLC(Buffer.from(m.hlc as string, 'base64')),
		})),
	} as ChangeSet;
}
