import type * as AST from '../../parser/ast.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { CTEPlanNode } from '../nodes/cte-node.js';
import { SetOperationNode } from '../nodes/set-operation-node.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { LimitOffsetNode } from '../nodes/limit-offset.js';
import { LiteralNode } from '../nodes/scalar.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
// Import will be added after refactoring select.ts
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Builds a compound SELECT statement (UNION, INTERSECT, EXCEPT)
 */
export function buildCompoundSelect(
	stmt: AST.SelectStmt,
	contextWithCTEs: PlanningContext,
	cteNodes: Map<string, CTEPlanNode>,
	buildSelectStmt: (ctx: PlanningContext, stmt: AST.SelectStmt, parentCTEs?: Map<string, CTEPlanNode>) => RelationalPlanNode
): RelationalPlanNode {
	if (!stmt.compound) {
		throw new QuereusError('buildCompoundSelect called without compound clause', StatusCode.INTERNAL);
	}

	// Build left side by cloning the statement without compound and stripping ORDER BY/LIMIT/OFFSET that belong to outer query
	const { _compound, orderBy: outerOrderBy, limit: outerLimit, offset: outerOffset, ...leftCore } = stmt as any;

	// Also strip ORDER BY/LIMIT/OFFSET from the right side - they should only apply to the final compound result
	const { orderBy: _rightOrderBy, limit: _rightLimit, offset: _rightOffset, ...rightCore } = stmt.compound.select as any;

	const leftPlan = buildSelectStmt(contextWithCTEs, leftCore as AST.SelectStmt, cteNodes) as RelationalPlanNode;
	const rightPlan = buildSelectStmt(contextWithCTEs, rightCore as AST.SelectStmt, cteNodes) as RelationalPlanNode;

	const setNode = new SetOperationNode(contextWithCTEs.scope, leftPlan, rightPlan, stmt.compound.op);

	// After set operation, apply ORDER BY / LIMIT / OFFSET from the *outer* (original) statement
	let input: RelationalPlanNode = setNode;

	// Build scope for output columns
	const setScope = createSetOperationScope(input);
	const selectContext: PlanningContext = { ...contextWithCTEs, scope: setScope };

	// Apply outer modifiers
	input = applyOuterOrderBy(input, outerOrderBy, selectContext);
	input = applyOuterLimitOffset(input, outerLimit, outerOffset, selectContext);

	return input;
}

/**
 * Creates a scope for set operation output columns
 */
function createSetOperationScope(setNode: RelationalPlanNode): RegisteredScope {
	const setScope = new RegisteredScope();
	const attrs = setNode.getAttributes();

	setNode.getType().columns.forEach((c: any, i: number) => {
		const attr = attrs[i];
		// Ensure column has a name - use attribute name as fallback
		const columnName = c.name || attr.name;
		if (!columnName) {
			throw new QuereusError(`Column at index ${i} has no name in set operation`, StatusCode.ERROR);
		}
		setScope.registerSymbol(columnName.toLowerCase(), (exp: any, s: any) =>
			new ColumnReferenceNode(s, exp, c.type, attr.id, i));
	});

	return setScope;
}

/**
 * Applies ORDER BY clause from outer compound statement
 */
function applyOuterOrderBy(
	input: RelationalPlanNode,
	outerOrderBy: any[] | undefined,
	selectContext: PlanningContext
): RelationalPlanNode {
	if (outerOrderBy && outerOrderBy.length > 0) {
		const sortKeys: SortKey[] = outerOrderBy.map((ob: any) => ({
			expression: buildExpression(selectContext, ob.expr),
			direction: ob.direction,
			nulls: ob.nulls,
		}));
		return new SortNode(selectContext.scope, input, sortKeys);
	}
	return input;
}

/**
 * Applies LIMIT and OFFSET clauses from outer compound statement
 */
function applyOuterLimitOffset(
	input: RelationalPlanNode,
	outerLimit: any,
	outerOffset: any,
	selectContext: PlanningContext
): RelationalPlanNode {
	if (outerLimit || outerOffset) {
		const literalNull = new LiteralNode(selectContext.scope, { type: 'literal', value: null });
		const limitExpr = outerLimit ? buildExpression(selectContext, outerLimit) : literalNull;
		const offsetExpr = outerOffset ? buildExpression(selectContext, outerOffset) : literalNull;
		return new LimitOffsetNode(selectContext.scope, input, limitExpr, offsetExpr);
	}
	return input;
}
