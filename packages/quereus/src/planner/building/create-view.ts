import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateViewNode } from '../nodes/create-view-node.js';

/**
 * Builds a plan node for CREATE VIEW statements.
 */
export function buildCreateViewStmt(ctx: PlanningContext, stmt: AST.CreateViewStmt): CreateViewNode {
	// Extract schema and view name
	const schemaName = stmt.view.schema || 'main';
	const viewName = stmt.view.name;

	// The original SQL text is needed for the view definition
	// For now, we'll reconstruct it from the AST
	// In a full implementation, this should be preserved from the original input
	const sql = reconstructViewSQL(stmt);

	return new CreateViewNode(
		ctx.scope,
		viewName,
		schemaName,
		stmt.ifNotExists,
		stmt.columns,
		stmt.select,
		sql
	);
}

/**
 * Reconstructs the original SQL text for a CREATE VIEW statement.
 * This is a simplified version - in production, the original text should be preserved.
 */
function reconstructViewSQL(stmt: AST.CreateViewStmt): string {
	let sql = 'CREATE VIEW ';

	if (stmt.ifNotExists) {
		sql += 'IF NOT EXISTS ';
	}

	if (stmt.view.schema) {
		sql += `${stmt.view.schema}.`;
	}
	sql += stmt.view.name;

	if (stmt.columns && stmt.columns.length > 0) {
		sql += ` (${stmt.columns.join(', ')})`;
	}

	sql += ' AS ';

	// For now, just add a placeholder for the SELECT statement
	// In a full implementation, this would reconstruct the full SELECT
	sql += '(SELECT statement)';

	return sql;
}
