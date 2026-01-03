import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateViewNode } from '../nodes/create-view-node.js';
import { createViewToString } from '../../emit/ast-stringify.js';

/**
 * Builds a plan node for CREATE VIEW statements.
 */
export function buildCreateViewStmt(ctx: PlanningContext, stmt: AST.CreateViewStmt): CreateViewNode {
	// Extract schema and view name
	const schemaName = stmt.view.schema || 'main';
	const viewName = stmt.view.name;

	// The original SQL text is needed for the view definition
	// Reconstruct it from the AST using the proper stringifier
	const sql = createViewToString(stmt);

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


