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
	/**
	 * The parsed body AST that defines the view's logic. Any relation-producing
	 * QueryExpr (SELECT / VALUES / DML w/ RETURNING). Today the planner only
	 * runs SELECT and VALUES bodies; DML bodies are rejected at plan time
	 * pending the dml-in-expression-position ticket.
	 */
	selectAst: AST.QueryExpr;
	/** Columns explicitly defined in CREATE VIEW (e.g., CREATE VIEW v(a,b) AS...) */
	columns?: ReadonlyArray<string>; // Optional list of explicitly named columns
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
}
