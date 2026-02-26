/**
 * Shared serialization for JSON transport.
 *
 * Used by both the WebSocket handler and the HTTP routes
 * for consistent wire format.
 */

import {
	siteIdFromBase64,
	siteIdToBase64,
	deserializeHLC,
	serializeHLC,
	type ChangeSet,
	type SnapshotChunk,
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
 * Serialize a SnapshotChunk for JSON transport.
 * Converts binary fields (siteId, HLCs) to base64 strings.
 */
export function serializeSnapshotChunk(chunk: SnapshotChunk): object {
	switch (chunk.type) {
		case 'header':
			return {
				type: chunk.type,
				siteId: siteIdToBase64(chunk.siteId),
				hlc: Buffer.from(serializeHLC(chunk.hlc)).toString('base64'),
				tableCount: chunk.tableCount,
				migrationCount: chunk.migrationCount,
				snapshotId: chunk.snapshotId,
			};
		case 'column-versions':
			return {
				type: chunk.type,
				schema: chunk.schema,
				table: chunk.table,
				entries: chunk.entries.map(([key, hlc, value]) => [
					key,
					Buffer.from(serializeHLC(hlc)).toString('base64'),
					value,
				]),
			};
		case 'schema-migration':
			return {
				type: chunk.type,
				migration: {
					...chunk.migration,
					hlc: Buffer.from(serializeHLC(chunk.migration.hlc)).toString('base64'),
				},
			};
		// table-start, table-end, footer have no binary fields
		default:
			return chunk;
	}
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
