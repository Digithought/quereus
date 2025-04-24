import type * as AST from '../parser/ast';

/**
 * Represents the schema definition of a database view.
 */
export interface ViewSchema {
	/** The name of the view. */
	name: string;
	/** The name of the schema this view belongs to (e.g., 'main'). */
	schemaName: string;
	/** The original SQL text used to create the view. */
	sql: string;
	/** The parsed SELECT statement AST that defines the view's logic. */
	selectAst: AST.SelectStmt;
	/** Columns explicitly defined in CREATE VIEW (e.g., CREATE VIEW v(a,b) AS...) */
	columns?: ReadonlyArray<string>; // Optional list of explicitly named columns
	// Add any other relevant metadata later if needed
}
