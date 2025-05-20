import type { DropTableNode } from '../../planner/nodes/drop-table-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';

export function emitDropTable(plan: DropTableNode): Instruction {
  async function run(ctx: RuntimeContext): Promise<SqlValue | undefined> {
    const schemaManager = ctx.db.schemaManager;
    const stmt = plan.statementAst; // AST.DropStmt

    const targetSchemaName = stmt.name.schema || schemaManager.getCurrentSchemaName();
    const objectName = stmt.name.name;

    if (stmt.objectType !== 'table') {
      // This emitter is specifically for DROP TABLE.
      // DROP VIEW, DROP INDEX would need their own PlanNodes and emitters, or a more generic DDL DropNode.
      throw new QuereusError(`DROP for object type '${stmt.objectType}' is not supported by emitDropTable.`, StatusCode.UNSUPPORTED);
    }

    await schemaManager.dropTable(targetSchemaName, objectName, stmt.ifExists);

		return null;
  }

  return { params: [], run: run as InstructionRun };
}
