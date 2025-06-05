import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { CTEPlanNode } from '../nodes/cte-node.js';
import type { Scope } from '../scopes/scope.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ParameterScope } from '../scopes/param.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildWithClause } from './with.js';

/**
 * Helper function to get the non-parameter ancestor scope.
 * This ensures table/column scopes don't inherit from ParameterScope,
 * preventing parameter resolution ambiguity in MultiScope.
 */
export function getNonParamAncestor(scope: Scope): Scope {
	return (scope instanceof ParameterScope) ? scope.parentScope : scope;
}

/**
 * Builds context with CTEs if present
 */
export function buildWithContext(
	ctx: PlanningContext,
	stmt: AST.SelectStmt,
	parentCTEs: Map<string, CTEPlanNode> = new Map()
): {
	contextWithCTEs: PlanningContext;
	cteNodes: Map<string, CTEPlanNode>;
} {
	// Start with parent CTEs
	let cteNodes: Map<string, CTEPlanNode> = new Map(parentCTEs);
	let contextWithCTEs = ctx;

	if (stmt.withClause) {
		const newCteNodes = buildWithClause(ctx, stmt.withClause);
		// Merge parent CTEs with new ones (new ones take precedence)
		for (const [name, node] of newCteNodes) {
			cteNodes.set(name, node);
		}

		// Create a new scope that includes the CTEs
		const cteScope = createCTEScope(cteNodes, ctx);
		contextWithCTEs = { ...ctx, scope: cteScope };
	} else if (parentCTEs.size > 0) {
		// No WITH clause but we have parent CTEs, create scope for them
		const cteScope = createCTEScope(parentCTEs, ctx);
		contextWithCTEs = { ...ctx, scope: cteScope };
	}

	return { contextWithCTEs, cteNodes };
}

/**
 * Creates a scope that includes CTE references
 */
function createCTEScope(
	cteNodes: Map<string, CTEPlanNode>,
	ctx: PlanningContext
): RegisteredScope {
	const cteScope = new RegisteredScope(getNonParamAncestor(ctx.scope));

	// Register each CTE in the scope
	for (const [cteName, cteNode] of cteNodes) {
		const attributes = cteNode.getAttributes();
		cteNode.getType().columns.forEach((col: any, i: number) => {
			const attr = attributes[i];
			// Register CTE columns with qualified names to avoid collisions
			const qualifiedColumnName = `${cteName}.${col.name.toLowerCase()}`;
			cteScope.registerSymbol(qualifiedColumnName, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, i));
		});
	}

	return cteScope;
}
