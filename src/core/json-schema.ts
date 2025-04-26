import type { SqlDataType } from '../common/types.js';

export interface JsonColumnSchema {
	name: string;
	affinity: keyof typeof SqlDataType; // Store affinity as string key, e.g., "INTEGER"
	notNull: boolean;
	primaryKey: boolean;
	defaultValue: string | number | null; // Store as string literal or null/number
	collation: string;
	hidden: boolean;
	generated: boolean;
}

export interface JsonIndexColumnSchema {
	index: number;
	desc: boolean;
	collation?: string; // Optional collation
}

export interface JsonIndexSchema {
	name: string;
	columns: JsonIndexColumnSchema[];
	// unique?: boolean; // Add if unique indexes are serialized
}

export interface JsonPrimaryKeyDefinition {
	index: number;
	desc: boolean;
}

export interface JsonTableSchema {
	name: string;
	columns: JsonColumnSchema[];
	primaryKeyDefinition: JsonPrimaryKeyDefinition[];
	isVirtual: boolean;
	vtabModule?: string;
	vtabArgs?: string[];
	indexes?: JsonIndexSchema[];
}

export interface JsonFunctionSchema {
	name: string;
	numArgs: number;
	flags: number;
}

export interface JsonSchema {
	tables: JsonTableSchema[];
	functions: JsonFunctionSchema[];
}

export interface JsonDatabaseSchema {
	schemaVersion: 1;
	schemas: {
		[schemaName: string]: JsonSchema;
	};
}
