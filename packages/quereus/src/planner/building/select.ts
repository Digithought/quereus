import type * as AST from '../../parser/ast.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { PlanningContext } from '../planning-context.js';
import { SingleRowNode } from '../nodes/single-row.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildTableScan } from './table.js';
import { AliasedScope } from '../scopes/aliased.js';
import { RegisteredScope } from '../scopes/registered.js';
import type { Scope } from '../scopes/scope.js';
import { MultiScope } from '../scopes/multi.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildExpression } from './expression.js';
import { FilterNode } from '../nodes/filter.js';
import { DistinctNode } from '../nodes/distinct-node.js';
import { LimitOffsetNode } from '../nodes/limit-offset.js';
import { LiteralNode } from '../nodes/scalar.js';
import { AggregateNode } from '../nodes/aggregate-node.js';
import { AggregateFunctionCallNode } from '../nodes/aggregate-function.js';
import { buildTableFunctionCall } from './table-function.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { expressionToString } from '../../util/ast-stringify.js';
import { buildWithClause } from './with.js';
import { CTEReferenceNode } from '../nodes/cte-reference-node.js';
import type { CTEPlanNode } from '../nodes/cte-node.js';
import { ParameterScope } from '../scopes/param.js';
import { SetOperationNode } from '../nodes/set-operation-node.js';
import { JoinNode } from '../nodes/join-node.js';

/**
 * Helper function to get the non-parameter ancestor scope.
 * This ensures table/column scopes don't inherit from ParameterScope,
 * preventing parameter resolution ambiguity in MultiScope.
 */
function getNonParamAncestor(scope: Scope): Scope {
	return (scope instanceof ParameterScope) ? scope.parentScope : scope;
}

/**
 * Checks if an expression contains aggregate functions
 */
function isAggregateExpression(node: ScalarPlanNode): boolean {
	if (node instanceof AggregateFunctionCallNode) {
		return true;
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		// Check if child is a scalar node and recursively check it
		if ('expression' in child && isAggregateExpression(child as ScalarPlanNode)) {
			return true;
		}
	}

	return false;
}

/**
 * Creates an initial logical query plan for a SELECT statement.
 *
 * For this initial version, it only supports simple "SELECT ... FROM one_table" queries,
 * effectively returning a TableScanNode for that table.
 *
 * @param stmt The AST.SelectStmt to plan.
 * @param ctx The parent planning context for this SELECT statement.
 * @param parentCTEs A map of parent CTEs for compound statements.
 * @returns A BatchNode representing the plan for the SELECT statement.
 * @throws {QuereusError} If the FROM clause is missing, empty, or contains more than one source.
 */
export function buildSelectStmt(
  ctx: PlanningContext,
  stmt: AST.SelectStmt,
  parentCTEs: Map<string, CTEPlanNode> = new Map()
): PlanNode {

	// Phase 0: Handle WITH clause if present
	let cteNodes: Map<string, CTEPlanNode> = new Map(parentCTEs); // Start with parent CTEs
	let contextWithCTEs = ctx;

	if (stmt.withClause) {
		const newCteNodes = buildWithClause(ctx, stmt.withClause);
		// Merge parent CTEs with new ones (new ones take precedence)
		for (const [name, node] of newCteNodes) {
			cteNodes.set(name, node);
		}

		// Create a new scope that includes the CTEs
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

		contextWithCTEs = { ...ctx, scope: cteScope };
	} else if (parentCTEs.size > 0) {
		// No WITH clause but we have parent CTEs, create scope for them
		const cteScope = new RegisteredScope(getNonParamAncestor(ctx.scope));

		// Register parent CTEs in the scope
		for (const [cteName, cteNode] of parentCTEs) {
			const attributes = cteNode.getAttributes();
			cteNode.getType().columns.forEach((col: any, i: number) => {
				const attr = attributes[i];
				// Register CTE columns with qualified names to avoid collisions
				const qualifiedColumnName = `${cteName}.${col.name.toLowerCase()}`;
				cteScope.registerSymbol(qualifiedColumnName, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, i));
			});
		}

		contextWithCTEs = { ...ctx, scope: cteScope };
	}

	// Handle compound set operations (UNION / INTERSECT / EXCEPT)
	if (stmt.compound) {
		// Build left side by cloning the statement without compound and stripping ORDER BY/LIMIT/OFFSET that belong to outer query
		// IMPORTANT: Keep the withClause for proper CTE scope inheritance
		const { compound, orderBy: outerOrderBy, limit: outerLimit, offset: outerOffset, ...leftCore } = stmt as any;

		// Also strip ORDER BY/LIMIT/OFFSET from the right side - they should only apply to the final compound result
		const { orderBy: rightOrderBy, limit: rightLimit, offset: rightOffset, ...rightCore } = stmt.compound.select as any;

		const leftPlan = buildSelectStmt(contextWithCTEs, leftCore as AST.SelectStmt, cteNodes) as RelationalPlanNode;
		const rightPlan = buildSelectStmt(contextWithCTEs, rightCore as AST.SelectStmt, cteNodes) as RelationalPlanNode;

		const setNode = new SetOperationNode(contextWithCTEs.scope, leftPlan, rightPlan, stmt.compound.op);

		// After set operation, apply ORDER BY / LIMIT / OFFSET from the *outer* (original) statement
		let input: RelationalPlanNode = setNode;

		// Build scope for output columns
		const setScope = new RegisteredScope();
		const attrs = input.getAttributes();
		input.getType().columns.forEach((c: any, i: number) => {
			const attr = attrs[i];
			// Ensure column has a name - use attribute name as fallback
			const columnName = c.name || attr.name;
			if (!columnName) {
				throw new QuereusError(`Column at index ${i} has no name in set operation`, StatusCode.ERROR);
			}
			setScope.registerSymbol(columnName.toLowerCase(), (exp: any, s: any) => new ColumnReferenceNode(s, exp, c.type, attr.id, i));
		});

		let selectContext: PlanningContext = { ...contextWithCTEs, scope: setScope };

		// ORDER BY
		if (outerOrderBy && outerOrderBy.length > 0) {
			const sortKeys = outerOrderBy.map((ob: any) => ({
				expression: buildExpression(selectContext, ob.expr),
				direction: ob.direction,
				nulls: ob.nulls,
			}));
			input = new SortNode(selectContext.scope, input, sortKeys);
		}

		// LIMIT/OFFSET
		if (outerLimit || outerOffset) {
			const literalNull = new LiteralNode(selectContext.scope, { type: 'literal', value: null });
			const limitExpr = outerLimit ? buildExpression(selectContext, outerLimit) : literalNull;
			const offsetExpr = outerOffset ? buildExpression(selectContext, outerOffset) : literalNull;
			input = new LimitOffsetNode(selectContext.scope, input, limitExpr, offsetExpr);
		}

		return input;
	}

	// Phase 1: Plan FROM clause and determine local input relations for the current select scope
	const fromTables = !stmt.from || stmt.from.length === 0
		? [SingleRowNode.instance]
		: stmt.from.map(from => buildFrom(from, contextWithCTEs, cteNodes));

	// TODO: Support multiple FROM sources (joins)
	if (fromTables.length > 1) {
		throw new QuereusError(
			'SELECT with multiple FROM sources (joins) not yet supported.',
			StatusCode.UNSUPPORTED, undefined, stmt.from![1].loc?.start.line, stmt.from![1].loc?.start.column
		);
	}

	// Phase 2: Create the main scope for this SELECT statement.
  // This scope sees the parent scope and the column scopes from the FROM clause.
  // Column scopes (FROM clause) should have higher precedence than parent scope for unqualified names
  const columnScopes = fromTables.map(ft => (ft as any).columnScope || ft.scope).filter(Boolean);
  const selectScope = new MultiScope([...columnScopes, contextWithCTEs.scope]);
	// Context for planning expressions within this SELECT (e.g., SELECT list, WHERE clause)
	let selectContext: PlanningContext = {...contextWithCTEs, scope: selectScope};

	let input: RelationalPlanNode = fromTables[0]; // Ensure input is RelationalPlanNode

	// Plan WHERE clause using selectContext, potentially creating a FilterNode
	if (stmt.where) {
		const whereExpression = buildExpression(selectContext, stmt.where);
		input = new FilterNode(selectScope, input, whereExpression);
	}

	// Build projections based on the SELECT list
	const projections: Projection[] = [];
	const aggregates: { expression: ScalarPlanNode; alias: string }[] = [];
	let hasAggregates = false;

	for (const column of stmt.columns) {
		if (column.type === 'all') {
			// Handle SELECT * or table.*
			const inputColumns = input.getType().columns;
			const inputAttributes = input.getAttributes();

			if (column.table) {
				// Handle qualified SELECT table.*
				// For now, we'll assume the table qualifier matches our single input table
				// TODO: Handle qualified star with multiple tables/joins
				const inputTableName = (input as any).source?.tableSchema?.name;
				const tableMatches = column.table.toLowerCase() === inputTableName?.toLowerCase();
				if (!tableMatches) {
					throw new QuereusError(
						`Table '${column.table}' not found in FROM clause for qualified SELECT *`,
						StatusCode.ERROR
					);
				}
			}

			// Add a projection for each column in the input relation
			inputColumns.forEach((columnDef, index) => {
				// Create a ColumnReferenceNode for this column using the input's attribute ID
				const columnExpr: AST.ColumnExpr = {
					type: 'column',
					name: columnDef.name,
					// Don't set table qualifier for SELECT * projections to avoid confusion
				};

				const attr = inputAttributes[index];
				const columnRef = new ColumnReferenceNode(
					selectScope,
					columnExpr,
					columnDef.type,
					attr.id, // Use the attribute ID from the input relation
					index
				);

				projections.push({
					node: columnRef,
					alias: columnDef.name // Use the original column name as alias
				});
			});
		} else if (column.type === 'column') {
			// Handle specific expressions - allow aggregates in SELECT list
			const scalarNode = buildExpression(selectContext, column.expr, true);

			// Check if this expression contains aggregate functions
			if (isAggregateExpression(scalarNode)) {
				hasAggregates = true;
				aggregates.push({
					expression: scalarNode,
					alias: column.alias || expressionToString(column.expr)
				});
			} else {
				projections.push({
					node: scalarNode,
					alias: column.alias // Use the specified alias, if any
				});
			}
		}
	}

	// Check if we have GROUP BY clause
	const hasGroupBy = stmt.groupBy && stmt.groupBy.length > 0;

	// Special handling for ORDER BY with aggregates but no GROUP BY
	// In this case, if ORDER BY references columns not in the SELECT list,
	// it should order the input rows before aggregation
	let preAggregateSort = false;
	if (hasAggregates && !hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0) {
		// Check if ORDER BY references columns that are not in the aggregate expressions
		// For now, we'll apply the sort before aggregation if we have any ORDER BY
		// This handles cases like: SELECT group_concat(val, '|') FROM t ORDER BY val
		preAggregateSort = true;

		// Apply ORDER BY before aggregation
		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const expression = buildExpression(selectContext, orderByClause.expr);
			return {
				expression,
				direction: orderByClause.direction,
				nulls: orderByClause.nulls
			};
		});

		input = new SortNode(selectScope, input, sortKeys);
	}

	// If we have aggregates or GROUP BY, create an AggregateNode
	if (hasAggregates || hasGroupBy) {
		// Build GROUP BY expressions
		const groupByExpressions = stmt.groupBy ? stmt.groupBy.map(expr => buildExpression(selectContext, expr, false)) : [];

		// If we have non-aggregate projections with aggregates, that's an error (unless they're in GROUP BY)
		if (projections.length > 0 && hasAggregates && !hasGroupBy) {
			throw new QuereusError(
				'Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY',
				StatusCode.ERROR
			);
		}

		input = new AggregateNode(selectScope, input, groupByExpressions, aggregates);

		// Create a scope that includes the aggregate output columns
		// This will be used for HAVING and ORDER BY after aggregation
		// It should inherit from the original scope to allow table resolution for subqueries
		const aggregateOutputScope = new RegisteredScope(selectScope);
		const aggregateAttributes = input.getAttributes();

		// Register GROUP BY columns
		groupByExpressions.forEach((expr, index) => {
			// Use the attribute name from the AggregateNode instead of duplicating logic
			const attr = aggregateAttributes[index];
			aggregateOutputScope.registerSymbol(attr.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, expr.getType(), attr.id, index));
		});

		// Register aggregate columns by their aliases
		aggregates.forEach((agg, index) => {
			const columnIndex = groupByExpressions.length + index;
			const attr = aggregateAttributes[columnIndex];
			aggregateOutputScope.registerSymbol(agg.alias.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, agg.expression.getType(), attr.id, columnIndex));
		});

		// Handle HAVING clause
		if (stmt.having) {
			// Build HAVING expression with the aggregate scope
			// We need to use a special context that knows about the aggregates
			const havingContext: PlanningContext = {
				...selectContext,
				scope: aggregateOutputScope,
				// Add the aggregates to the context so buildExpression can check them
				aggregates: aggregates.map((agg, index) => {
					const columnIndex = groupByExpressions.length + index;
					const attr = aggregateAttributes[columnIndex];
					return {
						expression: agg.expression,
						alias: agg.alias,
						columnIndex,
						attributeId: attr.id // Add the attribute ID for proper column reference creation
					};
				})
			};
			const havingExpression = buildExpression(havingContext, stmt.having, true);

			// Wrap the AggregateNode with a FilterNode for HAVING
			input = new FilterNode(aggregateOutputScope, input, havingExpression);
		}

		// Check if we need a final projection - only if we have complex expressions
		// that aren't just simple column references or aggregate functions
		let needsFinalProjection = false;
		if (projections.length > 0) {
			// Check if any of the projections are complex expressions (not just column refs)
			needsFinalProjection = projections.some(proj => {
				// If it's not a simple ColumnReferenceNode, we need final projection
				return !(proj.node instanceof ColumnReferenceNode);
			});
		}

		if (needsFinalProjection) {
			// Build projections for the complete SELECT list by re-processing with aggregate scope
			const finalProjections: Projection[] = [];

			for (const column of stmt.columns) {
				if (column.type === 'column') {
					// Re-build the expression in the context of the aggregate output
					const finalContext: PlanningContext = { ...selectContext, scope: aggregateOutputScope };
					const scalarNode = buildExpression(finalContext, column.expr, true);

					finalProjections.push({
						node: scalarNode,
						alias: column.alias || (column.expr.type === 'column' ? column.expr.name : undefined)
					});
				}
			}

			input = new ProjectNode(selectScope, input, finalProjections);
		}

		// Update the select context to use the aggregate output scope for ORDER BY
		selectContext = {...selectContext, scope: aggregateOutputScope};
	} else {
		// Create ProjectNode if we have projections, otherwise return input as-is
		if (projections.length > 0) {
			// Check if ORDER BY should be applied before projection
			let needsPreProjectionSort = false;
			if (stmt.orderBy && stmt.orderBy.length > 0 && !preAggregateSort) {
				// Check if any ORDER BY column is not in the projection aliases
				for (const orderByClause of stmt.orderBy) {
					if (orderByClause.expr.type === 'column') {
						const orderColumn = orderByClause.expr.name.toLowerCase();
						// Check if this column is in the projection aliases
						const isInProjection = projections.some(proj =>
							(proj.alias?.toLowerCase() === orderColumn) ||
							(proj.node instanceof ColumnReferenceNode && proj.node.expression.name.toLowerCase() === orderColumn)
						);
						if (!isInProjection) {
							needsPreProjectionSort = true;
							break;
						}
					}
				}
			}

			// Apply ORDER BY before projection if needed
			if (needsPreProjectionSort && stmt.orderBy && stmt.orderBy.length > 0) {
				const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
					const expression = buildExpression(selectContext, orderByClause.expr);
					return {
						expression,
						direction: orderByClause.direction,
						nulls: orderByClause.nulls
					};
				});
				input = new SortNode(selectScope, input, sortKeys);
				// Mark that we've applied ORDER BY before projection
				preAggregateSort = true;
			}

			input = new ProjectNode(selectScope, input, projections);

			// Create a new scope that maps column names to the ProjectNode's output attributes
			const projectionOutputScope = new RegisteredScope();
			const projectionAttributes = input.getAttributes();
			input.getType().columns.forEach((col, index) => {
				const attr = projectionAttributes[index];
				projectionOutputScope.registerSymbol(col.name.toLowerCase(), (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, index));
			});

			// Update selectContext to use BOTH the projection output scope AND the original scope
			// This allows ORDER BY to reference both projected columns (unqualified) and original columns (qualified)
			if (!needsPreProjectionSort) {
				const combinedScope = new MultiScope([projectionOutputScope, selectScope]);
				selectContext = {...selectContext, scope: combinedScope};
			}
		}
	}

	// Apply DISTINCT if present
	if (stmt.distinct) {
		input = new DistinctNode(selectScope, input);
	}

	// Plan ORDER BY clause, creating SortNode (only if not already applied before aggregation or projection)
	if (stmt.orderBy && stmt.orderBy.length > 0 && !preAggregateSort) {
		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const expression = buildExpression(selectContext, orderByClause.expr);
			return {
				expression,
				direction: orderByClause.direction,
				nulls: orderByClause.nulls
			};
		});

		input = new SortNode(selectScope, input, sortKeys);
	}

	// Plan LIMIT and OFFSET clauses
	if (stmt.limit || stmt.offset) {
		const literalNull = new LiteralNode(selectScope, { type: 'literal', value: null });
		const limitExpression = stmt.limit ? buildExpression(selectContext, stmt.limit) : literalNull;
		const offsetExpression = stmt.offset ? buildExpression(selectContext, stmt.offset) : literalNull;
		input = new LimitOffsetNode(selectScope, input, limitExpression, offsetExpression);
	}

	return input;
}

export function buildFrom(fromClause: AST.FromClause, parentContext: PlanningContext, cteNodes: Map<string, CTEPlanNode> = new Map()): RelationalPlanNode {
  let fromTable: RelationalPlanNode;
  let columnScope: Scope;

	if (fromClause.type === 'table') {
		const tableName = fromClause.table.name.toLowerCase();

		// First check if this is a CTE reference
		const cteNode = cteNodes.get(tableName);
		if (cteNode) {
			// This is a CTE reference
			const cteRefNode = new CTEReferenceNode(parentContext.scope, cteNode, fromClause.alias);
			fromTable = cteRefNode;

			// Column scope for CTE - no parent needed since it only contains column symbols
			const cteScope = new RegisteredScope();
			const attributes = fromTable.getAttributes();
			fromTable.getType().columns.forEach((c, i) => {
				const attr = attributes[i];
				cteScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
			});

			if (fromClause.alias) {
				columnScope = new AliasedScope(cteScope, tableName, fromClause.alias.toLowerCase());
			} else {
				// Even without an explicit alias, we need to support qualified column references using the CTE name
				columnScope = new AliasedScope(cteScope, tableName, tableName);
			}
		} else {
			// Check if this is a view reference
			const schemaName = fromClause.table.schema || parentContext.db.schemaManager.getCurrentSchemaName();
			const viewSchema = parentContext.db.schemaManager.getView(schemaName, fromClause.table.name);

			if (viewSchema) {
				// This is a view reference - expand it to the underlying SELECT statement
				fromTable = buildSelectStmt(parentContext, viewSchema.selectAst, cteNodes) as RelationalPlanNode;

				// Column scope for view - no parent needed since it only contains column symbols
				const viewScope = new RegisteredScope();
				const attributes = fromTable.getAttributes();

				// Use view column names if explicitly defined, otherwise use the SELECT output column names
				const columnNames = viewSchema.columns || fromTable.getType().columns.map(c => c.name);

				columnNames.forEach((columnName, i) => {
					if (i < attributes.length) {
						const attr = attributes[i];
						const columnType = fromTable.getType().columns[i].type; // Use actual column type
						viewScope.registerSymbol(columnName.toLowerCase(), (exp, s) =>
							new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, attr.id, i));
					}
				});

				if (fromClause.alias) {
					columnScope = new AliasedScope(viewScope, fromClause.table.name.toLowerCase(), fromClause.alias.toLowerCase());
				} else {
					// Even without an explicit alias, we need to support qualified column references using the view name
					columnScope = new AliasedScope(viewScope, fromClause.table.name.toLowerCase(), fromClause.table.name.toLowerCase());
				}
			} else {
				// This is a regular table reference
				fromTable = buildTableScan(fromClause, parentContext);

				// Column scope for table - no parent needed since it only contains column symbols
				const tableScope = new RegisteredScope();
				const attributes = fromTable.getAttributes();
				fromTable.getType().columns.forEach((c, i) => {
					const attr = attributes[i];
					tableScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
				});

				if (fromClause.alias) {
					columnScope = new AliasedScope(tableScope, fromClause.table.name.toLowerCase(), fromClause.alias.toLowerCase());
				} else {
					// Even without an explicit alias, we need to support qualified column references using the table name
					columnScope = new AliasedScope(tableScope, fromClause.table.name.toLowerCase(), fromClause.table.name.toLowerCase());
				}
			}
		}

		// Store the column scope for buildSelectStmt
		(fromTable as any).columnScope = columnScope;
	} else if (fromClause.type === 'functionSource') {
		fromTable = buildTableFunctionCall(fromClause, parentContext);

		// Column scope for function - no parent needed since it only contains column symbols
		const functionScope = new RegisteredScope();
		const attributes = fromTable.getAttributes();
		fromTable.getType().columns.forEach((c, i) => {
			const attr = attributes[i];
			functionScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
		});

		if (fromClause.alias) {
			// For table-valued functions, use empty string as parent name since columns are registered without qualifier
			columnScope = new AliasedScope(functionScope, '', fromClause.alias.toLowerCase());
		} else {
			columnScope = functionScope;
		}

		// Store the column scope for buildSelectStmt
		(fromTable as any).columnScope = columnScope;
	} else if (fromClause.type === 'subquerySource') {
		// Build the subquery as a relational plan node
		fromTable = buildSelectStmt(parentContext, fromClause.subquery, cteNodes) as RelationalPlanNode;

		// Column scope for subquery - no parent needed since it only contains column symbols
		const subqueryScope = new RegisteredScope();
		const attributes = fromTable.getAttributes();
		fromTable.getType().columns.forEach((c, i) => {
			const attr = attributes[i];
			subqueryScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
		});

		// Subqueries always have an alias (required by parser)
		columnScope = new AliasedScope(subqueryScope, '', fromClause.alias.toLowerCase());

		// Store the column scope for buildSelectStmt
		(fromTable as any).columnScope = columnScope;
	} else if (fromClause.type === 'join') {
		// Handle JOIN clauses
		return buildJoin(fromClause, parentContext, cteNodes);
	} else {
		// Handle the case where fromClause.type is not recognized
		const exhaustiveCheck: never = fromClause;
		throw new QuereusError(
			`Unsupported FROM clause item type: ${(exhaustiveCheck as any).type}`,
			StatusCode.UNSUPPORTED,
			undefined,
			(exhaustiveCheck as any).loc?.startLine,
			(exhaustiveCheck as any).loc?.startColumn
		);
	}
	return fromTable;
}

/**
 * Builds a join plan node from an AST join clause
 */
function buildJoin(joinClause: AST.JoinClause, parentContext: PlanningContext, cteNodes: Map<string, CTEPlanNode>): JoinNode {
	// Build left and right sides recursively
	const leftNode = buildFrom(joinClause.left, parentContext, cteNodes);
	const rightNode = buildFrom(joinClause.right, parentContext, cteNodes);

	// Extract column scopes from left and right nodes
	const leftScope = (leftNode as any).columnScope as Scope;
	const rightScope = (rightNode as any).columnScope as Scope;

	// Create a combined scope for the join that includes both left and right columns
	const combinedScope = new MultiScope([leftScope, rightScope]);

	// Create a new planning context with the combined scope for condition evaluation
	const joinContext: PlanningContext = {
		...parentContext,
		scope: combinedScope
	};

	let condition: ScalarPlanNode | undefined;
	let usingColumns: string[] | undefined;

	// Handle ON condition
	if (joinClause.condition) {
		condition = buildExpression(joinContext, joinClause.condition);
	}

	// Handle USING columns
	if (joinClause.columns) {
		usingColumns = joinClause.columns;
		// Convert USING to ON condition: table1.col1 = table2.col1 AND table1.col2 = table2.col2 ...
		// For now, store the column names and let the emitter handle the condition
		// TODO: This could be improved by synthesizing the equality conditions here
	}

	const joinNode = new JoinNode(
		parentContext.scope,
		leftNode,
		rightNode,
		joinClause.joinType,
		condition,
		usingColumns
	);

	// Use the combined scope as the column scope for the join
	// This allows both qualified and unqualified column references to resolve properly
	(joinNode as any).columnScope = combinedScope;

	return joinNode;
}
