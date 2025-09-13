import type { LanguageClient } from 'vscode-languageclient/node';

export interface SchemaSnapshotTable {
	name: string;
	schema: string;
	columns: string[];
}

export interface SchemaSnapshot {
	tables: SchemaSnapshotTable[];
	functions: Array<{ name: string; numArgs: number }>;
}

export async function pushSchemaSnapshot(client: LanguageClient, snapshot: SchemaSnapshot): Promise<void> {
	await client.sendRequest('quereus/applySchemaSnapshot', snapshot);
}


