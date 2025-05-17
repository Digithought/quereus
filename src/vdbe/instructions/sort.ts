import { SqliteError } from '../../common/errors.js';
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

    const openCursor = ctx.getCursor(cIdx);

    if (!openCursor || !openCursor.vtab || !(openCursor.vtab instanceof MemoryTable) || !openCursor.isEphemeral) {
      throw new SqliteError(`Sort requires an open ephemeral MemoryTable cursor (cursor ${cIdx})`, StatusCode.INTERNAL);
    }
    if (!openCursor.instance || !(openCursor.instance instanceof MemoryTableCursor)) {
        throw new SqliteError(`Sort requires an active MemoryTableCursor instance (cursor ${cIdx})`, StatusCode.INTERNAL);
    }
    if (!sortInfo || sortInfo.type !== 'sortkey') {
      throw new SqliteError(`Sort requires valid P4SortKey info (cursor ${cIdx})`, StatusCode.INTERNAL);
    }

    const cursorInstance = openCursor.instance as MemoryTableCursor;

    try {
      // Call the method on the cursor instance.
      // This method internally sets up the ephemeralSortingIndex and populates sorterResults.
      await cursorInstance.createAndPopulateSorterIndex(sortInfo);

      // The cursor instance manages its internal state (ephemeralSortingIndex, sorterResults).
      // No need to re-assign ephemeralSortingIndex here.
      // Also, OpenCursor (openCursor variable) does not have sortedResults property.
    } catch (e) {
      errorLog(`Error creating/populating ephemeral sorter index for cursor ${cIdx}: %O`, e);
      if (e instanceof SqliteError) throw e;
      throw new SqliteError(`Failed to create/populate sorter index: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR);
    }

    return undefined; // Continue execution
  };
}
