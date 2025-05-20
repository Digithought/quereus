import type { ConflictResolution } from '../common/constants.js';
import type { SqlDataType, SqlValue } from '../common/types.js';

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
	desc?: boolean;
	collation?: string; // Optional collation
}

export interface JsonIndexSchema {
	name: string;
	columns: JsonIndexColumnSchema[];
	// unique?: boolean; // Add if unique indexes are serialized
}

export interface JsonPrimaryKeyDefinition {
	index: number;
	desc?: boolean;	// default false
}

export interface JsonTableSchema {
	name: string;
	columns: JsonColumnSchema[];
	primaryKeyDefinition: JsonPrimaryKeyDefinition[];
	vtabModule: string;
	vtabArgs?: Record<string, SqlValue>;
	indexes?: JsonIndexSchema[];
	checkConstraints?: (JsonColumnConstraint | JsonTableConstraint)[];
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

/** Base for constraints */
interface JsonConstraint {
	name?: string;
}

/** Column constraints in JSON */
export interface JsonColumnConstraint extends JsonConstraint {
	type: 'primaryKey' | 'notNull' | 'unique' | 'check' | 'default' | 'foreignKey' | 'collate' | 'generated';
	expr?: string | number | null; // For CHECK or DEFAULT (simplified to string/number/null for JSON)
	operations?: ('insert' | 'update' | 'delete')[];
	collation?: string;
	autoincrement?: boolean;
	direction?: 'asc' | 'desc';
}

export interface JsonTableConstraint extends JsonConstraint {
	type: 'primaryKey' | 'unique' | 'check' | 'foreignKey';
	columns?: { name: string; direction?: 'asc' | 'desc' }[];
	expr?: string | number | null; // For CHECK (simplified)
	operations?: ('insert' | 'update' | 'delete')[];
	onConflict?: ConflictResolution;
	foreignKey?: JsonForeignKeyClause;
}

/** Foreign key clause in JSON */
export interface JsonForeignKeyClause {
	table: string;
	columns?: string[];
}
