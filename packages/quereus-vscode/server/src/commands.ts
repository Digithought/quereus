import type { Connection } from 'vscode-languageserver/node';
import type { Database } from '@quereus/quereus';
import { snapshotSchema } from './schema-bridge.js';
import type { SchemaSnapshot } from '../../shared/types.js';

export type { SchemaSnapshot, SchemaSnapshotTable } from '../../shared/types.js';

export type SchemaApplier = (snapshot: SchemaSnapshot) => void;

export function registerCommands(connection: Connection, db: Database, apply: SchemaApplier): void {
	connection.onRequest('quereus/schemaSnapshot', async () => snapshotSchema(db));
	connection.onRequest('quereus/applySchemaSnapshot', async (snapshot: SchemaSnapshot) => { apply(snapshot); return true; });
}


