import { SqliteError } from '../../common/errors';
import { StatusCode } from '../../common/types';
import type { TableSchema } from '../../schema/table';
import { MemoryTable } from '../../vtab/memory-table';
import { MemoryTableModule } from '../../vtab/memory-module';
import type { Handler } from '../handler-types';
import { Opcode } from '../opcodes';

// Potentially share this instance if MemoryTableModule is stateless
const ephemeralModule = new MemoryTableModule();

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.OpenEphemeral] = async (ctx, inst) => {
    const ephCursorIdx = inst.p1;
    const ephNumCols = inst.p2;
    const providedSchema = inst.p4 as TableSchema | null;

    // Create a new MemoryTable instance for this ephemeral table
    const ephTable = new MemoryTable(
      ctx.db,
      ephemeralModule,
      `_temp_internal_${ephCursorIdx}`,
      `_eph_${ephCursorIdx}`
    );

    // Register the ephemeral table with the context (needed? maybe just manage cursor)
    // ctx.registerEphemeralTable(ephCursorIdx, ephTable); // Assuming VmCtx has such a method

    // Configure columns - Use provided schema if available, otherwise default
    if (providedSchema?.columns && providedSchema.primaryKeyDefinition) {
      const cols = providedSchema.columns.map(c => ({ name: c.name, type: undefined, collation: c.collation }));
      ephTable.setColumns(cols, providedSchema.primaryKeyDefinition);
    } else {
      const defaultCols = Array.from({ length: ephNumCols }, (_, i) => ({
        name: `eph_col${i}`,
        type: undefined,
        collation: 'BINARY' // Default collation
      }));
      ephTable.setColumns(defaultCols, []); // Default: no explicit primary key
    }

    // Open the cursor using the module's xOpen
    try {
      const ephInstance = await ephemeralModule.xOpen(ephTable);

      // Store cursor state in VmCtx
      const cursor = ctx.getCursor(ephCursorIdx);
      if (!cursor) {
        // This case might imply VmCtx needs to pre-allocate cursor slots
        throw new SqliteError(`Cursor slot ${ephCursorIdx} not available for ephemeral table`, StatusCode.INTERNAL);
      }
      cursor.instance = ephInstance;
      cursor.vtab = ephTable;
      cursor.isEphemeral = true;
      cursor.sortedResults = null;

    } catch (e) {
      console.error("Error opening ephemeral table:", e);
      if (e instanceof SqliteError) throw e;
      throw new SqliteError(`Failed to open ephemeral table ${ephCursorIdx}: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR);
    }

    return undefined; // Continue execution
  };
}
