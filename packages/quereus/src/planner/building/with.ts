import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CTENode, type CTEPlanNode, type CTEScopeNode } from '../nodes/cte-node.js';
import { RecursiveCTENode } from '../nodes/recursive-cte-node.js';
import { InternalRecursiveCTERefNode } from '../nodes/internal-recursive-cte-ref-node.js';
import { buildSelectStmt } from './select.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Builds plan nodes for Common Table Expressions (CTEs) within a WITH clause.
 * Returns a map of CTE names to their corresponding CTENode instances.
 */
export function buildWithClause(
	ctx: PlanningContext,
	withClause: AST.WithClause
): Map<string, CTEScopeNode> {
	const cteNodes = new Map<string, CTEScopeNode>();

	// Check for duplicate CTE names
	const cteNames = new Set<string>();
	for (const cte of withClause.ctes) {
		const cteName = cte.name.toLowerCase();
		if (cteNames.has(cteName)) {
			throw new QuereusError(
				`Duplicate CTE name '${cte.name}' in WITH clause`,
				StatusCode.ERROR
			);
		}
		cteNames.add(cteName);
	}

	// Build each CTE in order
	// Note: For recursive CTEs, we may need to handle forward references
	for (const cte of withClause.ctes) {
		const cteNode = buildCommonTableExpr(ctx, cte, withClause.recursive, cteNodes, withClause.options) as CTEScopeNode;
		cteNodes.set(cte.name.toLowerCase(), cteNode);
	}

	return cteNodes;
}

/**
 * Builds a plan node for a single Common Table Expression.
 */
export function buildCommonTableExpr(
	ctx: PlanningContext,
	cte: AST.CommonTableExpr,
	isRecursive: boolean,
	existingCTEs: Map<string, CTEScopeNode>,
	options?: AST.WithClauseOptions
): CTEPlanNode {
	// Create a context that includes previously defined CTEs in scope
	// This allows later CTEs to reference earlier ones
	const cteContext = { ...ctx };

	// Add existing CTEs to the scope for forward references
	const cteScope = new RegisteredScope(ctx.scope);
	for (const [cteName, cteNode] of existingCTEs) {
		const attributes = cteNode.getAttributes();
		cteNode.getType().columns.forEach((col, i) => {
			const attr = attributes[i];
			// Register CTE columns with qualified names only to avoid conflicts with table columns
			const qualifiedColumnName = `${cteName}.${col.name.toLowerCase()}`;
			cteScope.registerSymbol(qualifiedColumnName, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, i));
		});
	}
	cteContext.scope = cteScope;

	// Check if this is a recursive CTE with UNION structure
	if (isRecursive && cte.query.type === 'select' && cte.query.compound) {
		return buildRecursiveCTE(cteContext, cte, existingCTEs, options);
	}

	// For non-recursive CTEs or recursive CTEs without UNION structure
	let query: RelationalPlanNode;

	if (cte.query.type === 'select') {
		query = buildSelectStmt(cteContext, cte.query) as RelationalPlanNode;
	} else {
		// CTE can also be INSERT, UPDATE, or DELETE statements
		throw new QuereusError(
			'Non-SELECT CTEs are not yet supported',
			StatusCode.UNSUPPORTED
		);
	}

	// Determine materialization strategy
	let materializationHint = cte.materializationHint;
	if (!materializationHint) {
		// Default strategy: materialize if CTE is likely to be reused
		// For now, we'll default to not materialized for simplicity
		materializationHint = 'not_materialized';
	}

	return new CTENode(
		ctx.scope,
		cte.name,
		cte.columns,
		query,
		materializationHint,
		isRecursive
	);
}

/**
 * Builds a recursive CTE node from a CTE with UNION structure.
 */
function buildRecursiveCTE(
	ctx: PlanningContext,
	cte: AST.CommonTableExpr,
	existingCTEs: Map<string, CTEScopeNode>,
	options?: AST.WithClauseOptions
): RecursiveCTENode {
	const selectStmt = cte.query as AST.SelectStmt;

	// Validate recursive CTE structure - check for compound operation
	if (!selectStmt.compound) {
		throw new QuereusError(
			`Recursive CTE '${cte.name}' must use UNION or UNION ALL`,
			StatusCode.ERROR
		);
	}

	// Extract base case (the main SELECT) and recursive case (the compound part)
	const baseCaseStmt: AST.SelectStmt = {
		...selectStmt,
		compound: undefined
	};

	const recursiveCaseStmt = selectStmt.compound.select;
	const isUnionAll = selectStmt.compound.op === 'unionAll';

	// Build the base case query (without CTE self-reference)
	// Pass existingCTEs so the base case can reference earlier CTEs
	const baseCaseQuery = buildSelectStmt(ctx, baseCaseStmt, existingCTEs) as RelationalPlanNode;

	// Determine materialization strategy (recursive CTEs should typically be materialized)
	const materializationHint = cte.materializationHint || 'materialized';

	// Create the final recursive CTE node first (so we have the tableDescriptor)
	const recursiveCTENode = new RecursiveCTENode(
		ctx.scope,
		cte.name,
		cte.columns,
		baseCaseQuery,
		baseCaseQuery, // Temporary - will be replaced with actual recursive case
		isUnionAll,
		materializationHint,
		options?.maxRecursion
	);

		// For the recursive case, we need to create a special context where the CTE name
	// references the working table (this will be handled at runtime)
	const recursiveContext = { ...ctx };

	// Create an internal recursive reference node that will look up the working table at runtime
	const internalRefNode = new InternalRecursiveCTERefNode(
		ctx.scope,
		cte.name,
		recursiveCTENode.getAttributes(),
		recursiveCTENode.getType(),
		recursiveCTENode.tableDescriptor
	);

	// Build the recursive case query with a simple replacement strategy
	// We'll replace CTE references with the internal recursive reference during the FROM clause processing
	const recursiveCteMap = new Map<string, CTEScopeNode>();
	// Include all existing CTEs so they're available in the recursive case
	for (const [name, node] of existingCTEs) {
		recursiveCteMap.set(name, node);
	}
	// Override the current CTE with the internal recursive reference
	recursiveCteMap.set(cte.name.toLowerCase(), internalRefNode);

	// Build the recursive case query
	const recursiveCaseQuery = buildSelectStmt(recursiveContext, recursiveCaseStmt, recursiveCteMap) as RelationalPlanNode;

	// Now update the recursive CTE node with the actual recursive case query
	recursiveCTENode.setRecursiveCaseQuery(recursiveCaseQuery);

	return recursiveCTENode;
}
