import type { Database } from '../../core/database.js';
import type { TableSchema, RowConstraintSchema } from '../../schema/table.js';
import type * as AST from '../../parser/ast.js';
import { GlobalScope } from '../scopes/global.js';
import { RegisteredScope } from '../scopes/registered.js';
import { TableReferenceNode, ColumnReferenceNode } from '../nodes/reference.js';
import { TableFunctionReferenceNode } from '../nodes/reference.js';
import { LiteralNode, BinaryOpNode, UnaryOpNode } from '../nodes/scalar.js';
import type { PlanningContext } from '../planning-context.js';
import { BuildTimeDependencyTracker } from '../planning-context.js';
import { buildExpression } from '../building/expression.js';
import type { PlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { Attribute } from '../nodes/plan-node.js';
import type { SqlValue } from '../../common/types.js';
import { SqlDataType } from '../../common/types.js';
import { Scope } from '../scopes/scope.js';

export interface DeferredConstraintSetup {
	tableRef: TableReferenceNode;
	context: PlanningContext;
}

export function createDeferredConstraintSetup(db: Database, table: TableSchema, options?: { bindOld?: boolean }): DeferredConstraintSetup {
	const globalScope = new GlobalScope(db.schemaManager);
	const tableRef = new TableReferenceNode(globalScope, table, table.vtabModule, table.vtabAuxData);
	const registered = new RegisteredScope(tableRef.scope);
	const attrs = tableRef.getAttributes();

	const lowerTableName = table.name.toLowerCase();

	const makeColumnFactory = (attr: ReturnType<TableReferenceNode['getAttributes']>[number], colIndex: number) => {
		return (exp: AST.Expression, s: Scope) => new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, colIndex);
	};

	table.columns.forEach((col, colIndex) => {
		const attr = attrs[colIndex];
		const lowerName = col.name.toLowerCase();
		const columnFactory = makeColumnFactory(attr, colIndex);

		registered.subscribeFactory(lowerName, columnFactory);
		registered.subscribeFactory(`new.${lowerName}`, columnFactory);
		registered.subscribeFactory(`${lowerTableName}.${lowerName}`, columnFactory);

		if (options?.bindOld) {
			const literalNull = { type: 'literal', value: null } as const;
			registered.subscribeFactory(`old.${lowerName}`, (exp, s) => new LiteralNode(s, literalNull));
		}
	});

	const context: PlanningContext = {
		db: db,
		schemaManager: db.schemaManager,
		parameters: {},
		scope: registered,
		cteNodes: new Map(),
		schemaDependencies: new BuildTimeDependencyTracker(),
		schemaCache: new Map(),
		cteReferenceCache: new Map(),
		outputScopes: new Map()
	};

	return { tableRef, context };
}

export function constraintPlanContainsSubquery(_db: Database, _table: TableSchema, expr: AST.Expression): boolean {
	// Check AST directly without building a plan to avoid schema resolution issues
	const stack: AST.Expression[] = [expr];
	while (stack.length) {
		const node = stack.pop()!;
		if (node.type === 'subquery' || node.type === 'exists') {
			return true;
		}
		if (node.type === 'in' && (node as AST.InExpr).subquery) {
			return true;
		}
		// Check for table references in scalar contexts (e.g., correlated subqueries)
		if (node.type === 'column' && (node as AST.ColumnExpr).table) {
			const colExpr = node as AST.ColumnExpr;
			// If column references a different table, it likely involves a subquery or join
			if (colExpr.table && colExpr.table.toLowerCase() !== _table.name.toLowerCase()) {
				return true;
			}
		}
		// Recursively check children
		if (node.type === 'binary') {
			const bin = node as AST.BinaryExpr;
			stack.push(bin.left, bin.right);
		} else if (node.type === 'unary') {
			const un = node as AST.UnaryExpr;
			stack.push(un.expr);
		} else if (node.type === 'function') {
			const fn = node as AST.FunctionExpr;
			stack.push(...fn.args);
		} else if (node.type === 'case') {
			const cs = node as AST.CaseExpr;
			if (cs.baseExpr) stack.push(cs.baseExpr);
			cs.whenThenClauses.forEach(w => {
				stack.push(w.when, w.then);
			});
			if (cs.elseExpr) stack.push(cs.elseExpr);
		}
	}
	return false;
}
