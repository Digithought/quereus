import { SqliteError } from '../../common/errors';
import { StatusCode } from '../../common/types';
import type { VirtualTableModule } from '../../vtab/module';
import type { Handler, VmCtx } from '../handler-types';
import type { P4SchemaChange } from '../instruction';
import { Opcode } from '../opcodes';

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.SchemaChange] = async (ctx, inst) => {
    const cursorIdx = inst.p1!;
    const changeInfo = inst.p4 as P4SchemaChange | null;

    if (changeInfo === null) {
      throw new SqliteError(`SchemaChange requires valid P4SchemaChange info`, StatusCode.INTERNAL);
    }

    try {
      const cursor = ctx.getCursor(cursorIdx);
      if (!cursor) {
        throw new SqliteError(`SchemaChange: Invalid cursor index ${cursorIdx}`, StatusCode.INTERNAL);
      }

      const vtab = cursor.vtab;
      if (!vtab) {
        throw new SqliteError(`SchemaChange: Cursor ${cursorIdx} does not refer to an open virtual table`, StatusCode.INTERNAL);
      }

      // Check for xAlterSchema on the instance
      if (typeof vtab.xAlterSchema !== 'function') {
        throw new SqliteError(`ALTER TABLE operation not supported by virtual table module for table '${vtab.tableName}'`, StatusCode.MISUSE);
      }

      // Call the instance's implementation
      await vtab.xAlterSchema(changeInfo);
      console.log(`VDBE SchemaChange: Successfully executed on table ${vtab.tableName}`);

    } catch (e: any) {
      console.error("SchemaChange failed:", e);
      const msg = `SchemaChange failed: ${e instanceof Error ? e.message : String(e)}`;
      const code = e instanceof SqliteError ? e.code : StatusCode.ERROR;
      ctx.error = new SqliteError(msg, code, e instanceof Error ? e : undefined);
      ctx.done = true;
      return ctx.error.code; // Stop execution
    }

    return undefined; // Continue execution
  };

  handlers[Opcode.AlterTable] = (ctx, inst) => {
    // Placeholder: This opcode might trigger schema invalidation or other
    // pre/post actions related to ALTER TABLE, but the core logic is likely
    // handled by SchemaChange calling xAlterSchema.
    console.warn("Opcode.AlterTable is currently a No-Op.");
    return undefined;
  };

  // Other schema-related opcodes like CreateTable, CreateIndex, DropTable etc.
  // would be added here.
}
