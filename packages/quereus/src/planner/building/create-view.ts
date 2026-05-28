import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateViewNode } from '../nodes/create-view-node.js';
import { createViewToString } from '../../emit/ast-stringify.js';
import { buildSelectStmt, buildValuesStmt } from './select.js';
import { isRelationalNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Plan the view body for arity validation. Mirrors the planning-time gate
 * used in other relation-position sites: SELECT/VALUES build directly; DML
 * bodies parse but cannot yet execute as a view body (see follow-up
 * ticket dml-in-expression-position).
 */
function planViewBody(ctx: PlanningContext, viewName: string, body: AST.QueryExpr): RelationalPlanNode {
	switch (body.type) {
		case 'select': {
			const planned = buildSelectStmt(ctx, body);
			if (!isRelationalNode(planned)) {
				throw new QuereusError(
					`CREATE VIEW '${viewName}' body did not produce a relational result`,
					StatusCode.INTERNAL,
				);
			}
			return planned;
		}
		case 'values':
			return buildValuesStmt(ctx, body);
		case 'insert':
		case 'update':
		case 'delete':
			throw new QuereusError(
				`${body.type.toUpperCase()} as a view body is not yet supported — track ticket dml-in-expression-position.`,
				StatusCode.UNSUPPORTED,
				undefined,
				body.loc?.start.line,
				body.loc?.start.column,
			);
	}
}

/**
 * Builds a plan node for CREATE VIEW statements.
 */
export function buildCreateViewStmt(ctx: PlanningContext, stmt: AST.CreateViewStmt): CreateViewNode {
	// Extract schema and view name
	const schemaName = stmt.view.schema || 'main';
	const viewName = stmt.view.name;

	// If an explicit column list was provided, validate that its arity matches the body's projection.
	// Plan the body (read-only) so star-expansion and CTEs are resolved.
	if (stmt.columns && stmt.columns.length > 0) {
		const planned = planViewBody(ctx, viewName, stmt.select);
		const bodyArity = planned.getAttributes().length;
		if (stmt.columns.length !== bodyArity) {
			throw new QuereusError(
				`View '${viewName}' has ${stmt.columns.length} declared columns but body produces ${bodyArity}`,
				StatusCode.ERROR
			);
		}
	} else {
		// No explicit column list — still run the gate so a DML body is
		// rejected at plan time rather than waiting until first reference.
		planViewBody(ctx, viewName, stmt.select);
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


