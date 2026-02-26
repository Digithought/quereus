export interface SchemaSnapshotTable {
	name: string;
	schema: string;
	columns: string[];
}

export interface SchemaSnapshot {
	tables: SchemaSnapshotTable[];
	functions: Array<{ name: string; numArgs: number }>;
}
