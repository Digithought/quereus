import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateViewNode } from '../nodes/create-view-node.js';
import { createViewToString } from '../../emit/ast-stringify.js';
import { buildSelectStmt } from './select.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Builds a plan node for CREATE VIEW statements.
 */
export function buildCreateViewStmt(ctx: PlanningContext, stmt: AST.CreateViewStmt): CreateViewNode {
	// Extract schema and view name
	const schemaName = stmt.view.schema || 'main';
	const viewName = stmt.view.name;

	// If an explicit column list was provided, validate that its arity matches the SELECT projection.
	// Plan the SELECT (read-only) so that star-expansion and CTEs are resolved.
	if (stmt.columns && stmt.columns.length > 0) {
		const planned = buildSelectStmt(ctx, stmt.select);
		if (!isRelationalNode(planned)) {
			throw new QuereusError(
				`CREATE VIEW '${viewName}' body did not produce a relational result`,
				StatusCode.INTERNAL
			);
		}
		const selectArity = planned.getAttributes().length;
		if (stmt.columns.length !== selectArity) {
			throw new QuereusError(
				`View '${viewName}' has ${stmt.columns.length} declared columns but SELECT produces ${selectArity}`,
				StatusCode.ERROR
			);
		}
	}

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
		sql,
		stmt.tags ? Object.freeze({ ...stmt.tags }) : undefined
	);
}


