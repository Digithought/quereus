import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { TableSchema } from '../../schema/table.js';
import { MemoryTable } from '../../vtab/memory/table.js';
import { MemoryTableModule } from '../../vtab/memory/module.js';
import { MemoryTableManager } from '../../vtab/memory/layer/manager.js';
import type { Handler } from '../handler-types.js';
import { Opcode } from '../opcodes.js';
import { createDefaultColumnSchema } from '../../schema/column.js';
import { buildColumnIndexMap } from '../../schema/table.js';
import { createLogger } from '../../common/logger.js';

// Create one instance of the module to be shared
const ephemeralMemoryModule = new MemoryTableModule();

const log = createLogger('vdbe:ephemeral');
const errorLog = log.extend('error');

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.OpenEphemeral] = async (ctx, inst) => {
    const ephCursorIdx = inst.p1;
    const ephNumCols = inst.p2;
    const p4Schema = inst.p4 as TableSchema | null;

    // Define schema for the ephemeral table
    let tableSchema: TableSchema;
    const schemaName = '_temp_internal';
    const tableName = `_eph_${ephCursorIdx}`;
    const moduleName = 'memory';

    if (p4Schema?.columns && p4Schema?.columns.length === ephNumCols) {
      tableSchema = {
        ...p4Schema,
        name: tableName,
        schemaName: schemaName,
        vtabModule: ephemeralMemoryModule,
        vtabModuleName: moduleName,
        isView: false,
        isStrict: false,
        isWithoutRowid: p4Schema.isWithoutRowid ?? false,
        primaryKeyDefinition: p4Schema.primaryKeyDefinition ?? [],
        columnIndexMap: buildColumnIndexMap(p4Schema.columns),
        checkConstraints: p4Schema.checkConstraints ?? [],
      };
    } else {
      const defaultCols = Array.from({ length: ephNumCols }, (_, i) =>
        createDefaultColumnSchema(`eph_col${i}`)
      );
      tableSchema = {
        name: tableName,
        schemaName: schemaName,
        columns: defaultCols,
        columnIndexMap: buildColumnIndexMap(defaultCols),
        primaryKeyDefinition: [],
        checkConstraints: [],
        vtabModule: ephemeralMemoryModule,
        vtabModuleName: moduleName,
        isWithoutRowid: false,
        isStrict: false,
        isView: false,
      };
    }

    try {
      // 1. Create a NEW manager for this specific ephemeral table
      const manager = new MemoryTableManager(
        ctx.db,
        ephemeralMemoryModule,
        undefined,
        moduleName,
        schemaName,
        tableName,
        tableSchema,
        false
      );

      // 2. Create the MemoryTable instance (connection wrapper) using the manager
      const ephTable = new MemoryTable(
        ctx.db,
        ephemeralMemoryModule,
        manager
      );

      // 3. Open the cursor using the table instance's xOpen
      const ephInstance = await ephTable.xOpen();

      // 4. Store cursor state in VmCtx
      const cursor = ctx.getCursor(ephCursorIdx);
      if (!cursor) {
        throw new SqliteError(`Cursor slot ${ephCursorIdx} not available for ephemeral table`, StatusCode.INTERNAL);
      }
      cursor.instance = ephInstance;
      cursor.vtab = ephTable;
      cursor.isEphemeral = true;
      cursor.sortedResults = null;

    } catch (e) {
      errorLog("Error opening ephemeral table: %O", e);
      if (e instanceof SqliteError) throw e;
      throw new SqliteError(`Failed to open ephemeral table ${ephCursorIdx}: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR);
    }

    return undefined; // Continue execution
  };
}
