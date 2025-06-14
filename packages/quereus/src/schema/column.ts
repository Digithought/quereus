import { SqlDataType } from '../common/types.js';
import type { Expression } from '../parser/ast.js';

/**
 * Represents the schema definition of a single column in a table.
 */
export interface ColumnSchema {
	/** Column name */
	name: string;
	/** Data type affinity (TEXT, INTEGER, REAL, BLOB, NUMERIC) */
	affinity: SqlDataType;
	/** Whether the column has a NOT NULL constraint */
	notNull: boolean;
	/** Whether the column is part of the primary key */
	primaryKey: boolean;
	/** Order within the primary key (1-based) or 0 if not PK */
	pkOrder: number;
	/** Default value expression */
	defaultValue: Expression | null;
	/** Declared collation sequence name (e.g., "BINARY", "NOCASE", "RTRIM") */
	collation: string;
	/** Is the column generated? */
	generated: boolean;
}

/**
 * Creates a default ColumnSchema with basic properties
 * Following Third Manifesto principles, columns default to NOT NULL unless explicitly specified otherwise
 *
 * @param name The name for the column
 * @param defaultNotNull Whether columns should be NOT NULL by default (defaults to true for Third Manifesto compliance)
 * @returns A new column schema with default values
 */
export function createDefaultColumnSchema(name: string, defaultNotNull: boolean = true): ColumnSchema {
	return {
		name: name,
		affinity: SqlDataType.TEXT,
		notNull: defaultNotNull, // Third Manifesto: default to NOT NULL
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY', // SQLite's default
		generated: false,
	};
}
