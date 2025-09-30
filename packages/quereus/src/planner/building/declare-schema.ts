import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { PlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { Scope } from '../scopes/scope.js';
import { RelationType } from '../../common/datatype.js';
import { SqlDataType } from '../../common/types.js';
import { SchemaManager } from '../../schema/manager.js';

class SimpleUtilityNode extends PlanNode {
  override readonly nodeType: PlanNodeType;
  constructor(scope: Scope, nodeType: PlanNodeType, private readonly run: (ctx: PlanningContext) => void | Promise<void>) {
    super(scope, 0.001);
    this.nodeType = nodeType;
  }

  getType(): RelationType {
    return {
      typeClass: 'relation',
      isReadOnly: false,
      isSet: true,
      columns: [
        { name: 'status', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false }, generated: true },
      ],
      keys: [[]],
      rowConstraints: [],
    };
  }

  getAttributes() { return []; }
  getChildren() { return []; }
  withChildren() { return this; }
  get estimatedRows() { return 1; }
  override toString() { return `${this.nodeType}`; }
  override getLogicalAttributes() { return { type: this.nodeType }; }

  // Hook for runtime emission via emitters: we will run side effects in emitter
  // but since emitters don't know PlanningContext, we no-op here. Real execution will be in emitter registry.
}

export function buildDeclareSchemaStmt(ctx: PlanningContext, stmt: AST.DeclareSchemaStmt): PlanNode {
  // Store declared doc on db for later diff/apply
  // We'll use a runtime emitter to register it on Database instance.
  return new SimpleUtilityNode(ctx.scope, PlanNodeType.DeclareSchema, () => {});
}

export function buildDiffSchemaStmt(ctx: PlanningContext, _stmt: AST.DiffSchemaStmt): PlanNode {
  return new SimpleUtilityNode(ctx.scope, PlanNodeType.DiffSchema, () => {});
}

export function buildApplySchemaStmt(ctx: PlanningContext, _stmt: AST.ApplySchemaStmt): PlanNode {
  return new SimpleUtilityNode(ctx.scope, PlanNodeType.ApplySchema, () => {});
}

export function buildExplainSchemaStmt(ctx: PlanningContext, _stmt: AST.ExplainSchemaStmt): PlanNode {
  return new SimpleUtilityNode(ctx.scope, PlanNodeType.ExplainSchema, () => {});
}

