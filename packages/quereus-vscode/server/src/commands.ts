import type { Connection } from 'vscode-languageserver';
import type { Database } from '@quereus/quereus';
import { snapshotSchema } from './schema-bridge.js';

export interface SchemaSnapshotTable {
	name: string;
	schema: string;
	columns: string[];
}

export interface SchemaSnapshot {
	tables: SchemaSnapshotTable[];
	functions: Array<{ name: string; numArgs: number }>;
}

export type SchemaApplier = (snapshot: SchemaSnapshot) => void;

export function registerCommands(connection: Connection, db: Database, apply: SchemaApplier): void {
	connection.onRequest('quereus/schemaSnapshot', async () => snapshotSchema(db));
	connection.onRequest('quereus/applySchemaSnapshot', async (snapshot: SchemaSnapshot) => { apply(snapshot); return true; });
}


