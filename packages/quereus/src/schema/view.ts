import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';

/**
 * Represents the schema definition of a database view.
 * Views are stored SELECT statements that act like virtual tables.
 */
export interface ViewSchema {
	/** The name of the view */
	name: string;
	/** The name of the schema this view belongs to (e.g., 'main') */
	schemaName: string;
	/** The original SQL text used to create the view */
	sql: string;
	/** The parsed SELECT statement AST that defines the view's logic */
	selectAst: AST.SelectStmt;
	/** Columns explicitly defined in CREATE VIEW (e.g., CREATE VIEW v(a,b) AS...) */
	columns?: ReadonlyArray<string>; // Optional list of explicitly named columns
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
}
