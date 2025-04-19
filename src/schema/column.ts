import { type SqlValue, SqlDataType } from '../common/types';

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
    defaultValue: SqlValue | null; // Or maybe a specific type/expression later
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
