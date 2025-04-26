import { SqliteError } from '../../common/errors';
import { StatusCode } from '../../common/types';
import { MemoryTable } from '../../vtab/memory/table';
import type { Handler } from '../handler-types';
import type { P4SortKey } from '../instruction';
import { Opcode } from '../opcodes';
import { MemoryTableCursor } from '../../vtab/memory/cursor';

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.Sort] = (ctx, inst) => {
    const cIdx = inst.p1;
    const sortInfo = inst.p4 as P4SortKey | null;

    const cursor = ctx.getCursor(cIdx);

    // Sort only applies to ephemeral MemoryTable cursors used as sorters
    if (!cursor || !cursor.vtab || !(cursor.vtab instanceof MemoryTable) || !cursor.isEphemeral) {
      throw new SqliteError(`Sort requires an open ephemeral MemoryTable cursor (cursor ${cIdx})`, StatusCode.INTERNAL);
    }
    if (!sortInfo || sortInfo.type !== 'sortkey') {
      throw new SqliteError(`Sort requires valid P4SortKey info (cursor ${cIdx})`, StatusCode.INTERNAL);
    }

    const memTable = cursor.vtab as MemoryTable;

    // Configure the MemoryTable instance to act as a sorter using the provided key info.
    // The actual sorting happens implicitly via B-tree insertion order based on this config.
    // This opcode itself doesn't *perform* the sort, it configures the cursor for sorted reads.
    try {
      // Create an ephemeral index containing sorted row copies
      const ephemeralIndex = memTable.createEphemeralSorterIndex(sortInfo);
      // Store this index on the cursor state for filter/next/rewind to use
      if (!cursor.instance) {
        throw new SqliteError("Cannot attach sorter index to a closed or invalid cursor instance.", StatusCode.INTERNAL);
      }
      // Attach the ephemeral index directly to the cursor instance
      (cursor.instance as MemoryTableCursor).ephemeralSortingIndex = ephemeralIndex;
      // Clear any previous sorted results array if present
      cursor.sortedResults = null;
    } catch (e) {
      console.error(`Error creating ephemeral sorter index for cursor ${cIdx}:`, e);
      if (e instanceof SqliteError) throw e;
      throw new SqliteError(`Failed to create sorter index: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR);
    }

    // TODO: Optionally, could materialize sorted results here into cursor.sortedResults
    // for potential optimization, but currently relying on MemoryTable's sorted iteration.

    return undefined; // Continue execution
  };
}
