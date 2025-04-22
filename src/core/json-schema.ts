import type { SqlDataType } from '../common/types';

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
