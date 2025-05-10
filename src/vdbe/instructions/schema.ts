import { SqliterError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Handler } from '../handler-types.js';
import type { P4SchemaChange } from '../instruction.js';
import { Opcode } from '../opcodes.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('vdbe:schema');
const errorLog = log.extend('error');
const warnLog = log.extend('warn');

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.SchemaChange] = async (ctx, inst) => {
    const cursorIdx = inst.p1!;
    const changeInfo = inst.p4 as P4SchemaChange | null;

    if (changeInfo === null) {
      throw new SqliterError(`SchemaChange requires valid P4SchemaChange info`, StatusCode.INTERNAL);
    }

    try {
      const cursor = ctx.getCursor(cursorIdx);
      if (!cursor) {
        throw new SqliterError(`SchemaChange: Invalid cursor index ${cursorIdx}`, StatusCode.INTERNAL);
      }

      const vtab = cursor.vtab;
      if (!vtab) {
        throw new SqliterError(`SchemaChange: Cursor ${cursorIdx} does not refer to an open virtual table`, StatusCode.INTERNAL);
      }

      // Check for xAlterSchema on the instance
      if (typeof vtab.xAlterSchema !== 'function') {
        throw new SqliterError(`ALTER TABLE operation not supported by virtual table module for table '${vtab.tableName}'`, StatusCode.MISUSE);
      }

      // Call the instance's implementation
      await vtab.xAlterSchema(changeInfo);
      log(`Successfully executed SchemaChange on table %s`, vtab.tableName);

    } catch (e: any) {
      errorLog("SchemaChange failed: %O", e);
      const msg = `SchemaChange failed: ${e instanceof Error ? e.message : String(e)}`;
      const code = e instanceof SqliterError ? e.code : StatusCode.ERROR;
      ctx.error = new SqliterError(msg, code, e instanceof Error ? e : undefined);
      ctx.done = true;
      return ctx.error.code; // Stop execution
    }

    return undefined; // Continue execution
  };

  handlers[Opcode.AlterTable] = (ctx, inst) => {
    // Placeholder: This opcode might trigger schema invalidation or other
    // pre/post actions related to ALTER TABLE, but the core logic is likely
    // handled by SchemaChange calling xAlterSchema.
    warnLog("Opcode.AlterTable is currently a No-Op.");
    return undefined;
  };

  handlers[Opcode.SchemaInvalidate] = (ctx, inst) => {
      // TODO: Implement actual schema cache invalidation if needed
      log("SchemaInvalidate triggered (currently no-op)");
      return undefined;
  };

  // Other schema-related opcodes like CreateTable, CreateIndex, DropTable etc.
  // would be added here.
}
