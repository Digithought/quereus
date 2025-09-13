import type { Database } from '@quereus/quereus';

export interface SchemaSnapshotTable {
	name: string;
	schema: string;
	columns: string[];
}

export interface SchemaSnapshot {
	tables: SchemaSnapshotTable[];
	functions: Array<{ name: string; numArgs: number }>;
}

export function snapshotSchema(db: Database): SchemaSnapshot {
	const tables: SchemaSnapshotTable[] = [];
	const main = db.schemaManager.getMainSchema();
	for (const tbl of main.getAllTables()) {
		tables.push({ name: tbl.name, schema: tbl.schemaName, columns: tbl.columns.map((c: { name: string }) => c.name) });
	}
	const functions: Array<{ name: string; numArgs: number }> = [];
	// No public iterator for functions in d.ts; leave empty for now.
	return { tables, functions };
}


