import { BlockNode } from '../nodes/block.js';
import * as AST from '../../parser/ast.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { buildSelectStmt } from './select.js';
import type { PlanningContext } from '../planning-context.js';
import { buildCreateTableStmt } from './ddl.js';
import { buildCreateIndexStmt } from './ddl.js';
import { buildDropTableStmt } from './drop-table.js';
import { buildCreateViewStmt } from './create-view.js';
import { buildDropViewStmt } from './drop-view.js';
import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { buildAlterTableStmt } from './alter-table.js';
import { buildBeginStmt, buildCommitStmt, buildRollbackStmt, buildSavepointStmt, buildReleaseStmt } from './transaction.js';
import { buildPragmaStmt } from './pragma.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export function buildBlock(ctx: PlanningContext, statements: AST.Statement[]): BlockNode {
	const plannedStatements = statements.map((stmt) => {
		switch (stmt.type) {
			case 'select':
				// buildSelectStmt returns a BatchNode, which is a PlanNode.
				return buildSelectStmt(ctx, stmt as AST.SelectStmt);
			case 'createTable':
				return buildCreateTableStmt(ctx, stmt as AST.CreateTableStmt);
			case 'createIndex':
				return buildCreateIndexStmt(ctx, stmt as AST.CreateIndexStmt);
			case 'createView':
				return buildCreateViewStmt(ctx, stmt as AST.CreateViewStmt);
			case 'drop':
				if (stmt.objectType === 'table') {
					return buildDropTableStmt(ctx, stmt as AST.DropStmt);
				} else if (stmt.objectType === 'view') {
					return buildDropViewStmt(ctx, stmt as AST.DropStmt);
				}
				break;
			case 'insert':
				return buildInsertStmt(ctx, stmt as AST.InsertStmt);
			case 'update':
				return buildUpdateStmt(ctx, stmt as AST.UpdateStmt);
			case 'delete':
				return buildDeleteStmt(ctx, stmt as AST.DeleteStmt);
			case 'begin':
				return buildBeginStmt(ctx, stmt as AST.BeginStmt);
			case 'commit':
				return buildCommitStmt(ctx, stmt as AST.CommitStmt);
			case 'rollback':
				return buildRollbackStmt(ctx, stmt as AST.RollbackStmt);
			case 'savepoint':
				return buildSavepointStmt(ctx, stmt as AST.SavepointStmt);
			case 'release':
				return buildReleaseStmt(ctx, stmt as AST.ReleaseStmt);
			case 'pragma':
				return buildPragmaStmt(ctx, stmt as AST.PragmaStmt);
			case 'alterTable':
				return buildAlterTableStmt(ctx, stmt as AST.AlterTableStmt);
			default:
				// Throw an exception for unsupported statement types
				quereusError(
					`Unsupported statement type: ${(stmt as AST.Statement).type}`,
					StatusCode.UNSUPPORTED,
					undefined,
					stmt
				);
		}
	}).filter(p => p !== undefined) as PlanNode[]; // Ensure we only have valid PlanNodes and cast

    // The final BatchNode for the entire batch.
    // Its scope is batchParameterScope, and it contains all successfully planned statements.
	return new BlockNode(ctx.scope, plannedStatements, { ...ctx.parameters });
}


