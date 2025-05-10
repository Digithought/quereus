import { SqliterError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { MemoryTable } from '../../vtab/memory/table.js';
import type { Handler } from '../handler-types.js';
import type { P4SortKey } from '../instruction.js';
import { Opcode } from '../opcodes.js';
import { MemoryTableCursor } from '../../vtab/memory/cursor.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('vdbe:sort');
const errorLog = log.extend('error');

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.Sort] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const sortInfo = inst.p4 as P4SortKey | null;

    const cursor = ctx.getCursor(cIdx);

    if (!cursor || !cursor.vtab || !(cursor.vtab instanceof MemoryTable) || !cursor.isEphemeral) {
      throw new SqliterError(`Sort requires an open ephemeral MemoryTable cursor (cursor ${cIdx})`, StatusCode.INTERNAL);
    }
    if (!cursor.instance || !(cursor.instance instanceof MemoryTableCursor)) {
        throw new SqliterError(`Sort requires an active MemoryTableCursor instance (cursor ${cIdx})`, StatusCode.INTERNAL);
    }
    if (!sortInfo || sortInfo.type !== 'sortkey') {
      throw new SqliterError(`Sort requires valid P4SortKey info (cursor ${cIdx})`, StatusCode.INTERNAL);
    }

    const cursorInstance = cursor.instance as MemoryTableCursor;

    try {
      // Call the new method on the cursor instance
      const ephemeralIndex = await cursorInstance.createAndPopulateSorterIndex(sortInfo);

      // Attach the ephemeral index directly to the cursor instance
      cursorInstance.ephemeralSortingIndex = ephemeralIndex;
      // Clear any previous sorted results array if present
      cursor.sortedResults = null;
    } catch (e) {
      errorLog(`Error creating/populating ephemeral sorter index for cursor ${cIdx}: %O`, e);
      if (e instanceof SqliterError) throw e;
      throw new SqliterError(`Failed to create/populate sorter index: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR);
    }

    return undefined; // Continue execution
  };
}
