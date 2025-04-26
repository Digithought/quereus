import { SqlDataType } from '../common/types.js';
import type { Expression } from '../parser/ast.js';

/**
 * Represents the schema definition of a single column.
 */
export interface ColumnSchema {
	/** Column name */
	name: string;
	/** Declared type affinity (TEXT, INTEGER, REAL, BLOB, NUMERIC - or just use SqlDataType?) */
	affinity: SqlDataType; // Or maybe allow a string type name? Let's stick to enum for now.
	/** Whether the column has a NOT NULL constraint */
	notNull: boolean;
	/** Whether the column is part of the primary key */
	primaryKey: boolean;
	/** Order within the primary key (1-based) or 0 if not PK */
	pkOrder: number;
	/** Default value (might be complex, start simple) */
	defaultValue: Expression | null; // Store the AST Expression or null
	/** Declared collation sequence name (e.g., "BINARY", "NOCASE", "RTRIM") */
	collation: string; // Default to 'BINARY'
	/** Is the column hidden (e.g., implicit rowid for non-WITHOUT ROWID vtabs)? */
	hidden: boolean;
	/** Is the column generated? (Likely false for VTabs, but good for completeness) */
	generated: boolean; // Default false

	// Add other properties if needed, e.g., from sqlite3_table_column_metadata
	// isAutoIncrement?: boolean; // Explicitly skipping based on requirements
}

/**
 * Determines the column affinity based on SQLite rules.
 * See: https://www.sqlite.org/datatype3.html#determination_of_column_affinity
 * @param typeName The declared type name (case-insensitive).
 * @returns The determined SqlDataType affinity.
 */
export function getAffinity(typeName: string | undefined): SqlDataType {
	if (!typeName) {
		return SqlDataType.BLOB; // Or NUMERIC? SQLite docs say BLOB if no type.
	}
	const typeUpper = typeName.toUpperCase();
	if (typeUpper.includes('INT')) {
		return SqlDataType.INTEGER;
	}
	if (typeUpper.includes('CHAR') || typeUpper.includes('CLOB') || typeUpper.includes('TEXT')) {
		return SqlDataType.TEXT;
	}
	if (typeUpper.includes('BLOB')) {
		return SqlDataType.BLOB;
	}
	if (typeUpper.includes('REAL') || typeUpper.includes('FLOA') || typeUpper.includes('DOUB')) {
		return SqlDataType.REAL;
	}
	return SqlDataType.NUMERIC; // Default catch-all
}

/**
 * Creates a default ColumnSchema, useful for initialization.
 */
export function createDefaultColumnSchema(name: string): ColumnSchema {
	return {
		name: name,
		affinity: SqlDataType.TEXT, // Default affinity often TEXT or BLOB/NUMERIC in SQLite
		notNull: false,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY', // SQLite's default
		hidden: false,
		generated: false,
	};
}
