import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { DeclareSchemaNode, DiffSchemaNode, ApplySchemaNode, ExplainSchemaNode } from '../nodes/declarative-schema.js';

export function buildDeclareSchemaStmt(ctx: PlanningContext, stmt: AST.DeclareSchemaStmt): PlanNode {
	return new DeclareSchemaNode(ctx.scope, stmt);
}

export function buildDiffSchemaStmt(ctx: PlanningContext, stmt: AST.DiffSchemaStmt): PlanNode {
	return new DiffSchemaNode(ctx.scope, stmt);
}

export function buildApplySchemaStmt(ctx: PlanningContext, stmt: AST.ApplySchemaStmt): PlanNode {
	return new ApplySchemaNode(ctx.scope, stmt);
}

export function buildExplainSchemaStmt(ctx: PlanningContext, stmt: AST.ExplainSchemaStmt): PlanNode {
	return new ExplainSchemaNode(ctx.scope, stmt);
}


