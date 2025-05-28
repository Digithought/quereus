import { VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import * as AST from '../../parser/ast.js';

export interface TransactionNode extends VoidNode {
	nodeType: PlanNodeType.Transaction;
	operation: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release';
	mode?: 'deferred' | 'immediate' | 'exclusive'; // For BEGIN
	savepoint?: string; // For ROLLBACK TO, SAVEPOINT, RELEASE
	statementAst: AST.BeginStmt | AST.CommitStmt | AST.RollbackStmt | AST.SavepointStmt | AST.ReleaseStmt;
}

export class TransactionPlanNode extends VoidNode implements TransactionNode {
	readonly nodeType = PlanNodeType.Transaction;

	constructor(
		scope: Scope,
		public readonly operation: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release',
		public readonly statementAst: AST.BeginStmt | AST.CommitStmt | AST.RollbackStmt | AST.SavepointStmt | AST.ReleaseStmt,
		public readonly mode?: 'deferred' | 'immediate' | 'exclusive',
		public readonly savepoint?: string
	) {
		super(scope, 1); // Transaction operations have low cost
	}
}
