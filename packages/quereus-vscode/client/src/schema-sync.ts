import type { LanguageClient } from 'vscode-languageclient/node';
import type { SchemaSnapshot } from '../../shared/types.js';

export type { SchemaSnapshot, SchemaSnapshotTable } from '../../shared/types.js';

export async function pushSchemaSnapshot(client: LanguageClient, snapshot: SchemaSnapshot): Promise<void> {
	await client.sendRequest('quereus/applySchemaSnapshot', snapshot);
}


