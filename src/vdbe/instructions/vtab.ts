import { SqliteError } from '../../common/errors';
import { StatusCode, type SqlValue } from '../../common/types';
import type { Handler, VmCtx } from '../handler-types';
import type { P4Update, VdbeInstruction } from '../instruction';
import { Opcode } from '../opcodes';
import { ConflictResolution } from '../../common/constants';
import type { VirtualTableModule } from '../../vtab/module';

// Helper for handling errors from VTab methods
function handleVTabError(ctx: VmCtx, e: any, vtabName: string, method: string) {
  const message = `Error in VTab ${vtabName}.${method}: ${e instanceof Error ? e.message : String(e)}`;
  const code = e instanceof SqliteError ? e.code : StatusCode.ERROR;
  ctx.error = new SqliteError(message, code, e instanceof Error ? e : undefined);
  ctx.done = true;
  console.error(ctx.error);
}

export function registerHandlers(handlers: Handler[]) {
  // --- VTab Cursor Operations ---

	handlers[Opcode.VFilter] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const addrIfEmpty = inst.p2;
    const argsReg = inst.p3;
    const p4Info = inst.p4 as { idxNum: number; idxStr: string | null; nArgs: number } | null;

    const cursor = ctx.getCursor(cIdx);
    if (!cursor?.instance) {
      throw new SqliteError(`VFilter on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }
    if (!p4Info) {
      throw new SqliteError(`VFilter missing P4 info for cursor ${cIdx}`, StatusCode.INTERNAL);
    }

    const args: SqlValue[] = [];
    for (let i = 0; i < p4Info.nArgs; i++) {
      args.push(ctx.getMem(argsReg + i));
    }

    try {
      await cursor.instance.filter(p4Info.idxNum, p4Info.idxStr, args);
      const eof = cursor.instance.eof();
      ctx.pc = eof ? addrIfEmpty : ctx.pc + 1;
    } catch (e) {
      handleVTabError(ctx, e, cursor.vtab?.tableName ?? `cursor ${cIdx}`, 'filter');
      return ctx.error?.code;
    }
    return undefined; // PC handled
  };

  handlers[Opcode.VNext] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const addrIfEOF = inst.p2;

    const cursor = ctx.getCursor(cIdx);

    // Handle pre-sorted results (e.g., from Sort or materialized views)
    if (cursor?.sortedResults) {
      const s = cursor.sortedResults;
      s.index++;
      ctx.pc = (s.index >= s.rows.length) ? addrIfEOF : ctx.pc + 1;
      return undefined; // PC handled
    }

    if (!cursor?.instance) {
      throw new SqliteError(`VNext on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }

    try {
      await cursor.instance.next();
      const eof = cursor.instance.eof();
      ctx.pc = eof ? addrIfEOF : ctx.pc + 1;
    } catch (e) {
      handleVTabError(ctx, e, cursor.vtab?.tableName ?? `cursor ${cIdx}`, 'next');
      return ctx.error?.code;
    }
    return undefined; // PC handled
  };

  handlers[Opcode.Rewind] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const addrIfEmpty = inst.p2;
    const cursor = ctx.getCursor(cIdx);

    // Handle pre-sorted results
    if (cursor?.sortedResults) {
      const s = cursor.sortedResults;
      s.index = 0;
      ctx.pc = (s.rows.length === 0) ? addrIfEmpty : ctx.pc + 1;
      return undefined; // PC handled
    }

    if (!cursor?.instance) {
      throw new SqliteError(`Rewind on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }

    try {
      // Rewind is equivalent to a filter with no constraints
      await cursor.instance.filter(0, null, []);
      const eof = cursor.instance.eof();
      ctx.pc = eof ? addrIfEmpty : ctx.pc + 1;
    } catch (e) {
      handleVTabError(ctx, e, cursor.vtab?.tableName ?? `cursor ${cIdx}`, 'filter(rewind)');
      return ctx.error?.code;
    }
    return undefined; // PC handled
  };

  handlers[Opcode.VColumn] = (ctx, inst) => {
    const cIdx = inst.p1;
    const colIdx = inst.p2;
    const destOffset = inst.p3;
    const cursor = ctx.getCursor(cIdx);

    // Handle pre-sorted results
    if (cursor?.sortedResults) {
      const s = cursor.sortedResults;
      if (s.index < 0 || s.index >= s.rows.length) {
        throw new SqliteError(`VColumn on invalid sorted cursor index ${s.index} (cursor ${cIdx})`, StatusCode.INTERNAL);
      }
      const row = s.rows[s.index];
      if (colIdx < 0 || colIdx >= row.length) {
        // Potentially handle RowID request (colIdx == -1) if stored explicitly
        throw new SqliteError(`VColumn index ${colIdx} out of bounds for sorted row (cursor ${cIdx})`, StatusCode.INTERNAL);
      }
      ctx.setMem(destOffset, row[colIdx].value);
      return undefined;
    }

    if (!cursor?.instance) {
      throw new SqliteError(`VColumn on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }
    if (cursor.instance.eof()) {
      // Reading from EOF cursor should yield NULL, consistent with SQLite
      ctx.setMem(destOffset, null);
      // throw new SqliteError(`VColumn on EOF cursor ${cIdx}`, StatusCode.INTERNAL);
      return undefined;
    }

    try {
      // Reuse VTab context provided by VmCtx
      ctx.vtabContext._clear();
      const status = cursor.instance.column(ctx.vtabContext, colIdx);
      if (status !== StatusCode.OK) {
        throw new SqliteError(`VColumn failed (col ${colIdx}, cursor ${cIdx})`, status);
      }
      ctx.setMem(destOffset, ctx.vtabContext._getResult());
    } catch (e) {
      handleVTabError(ctx, e, cursor.vtab?.tableName ?? `cursor ${cIdx}`, 'column');
      return ctx.error?.code;
    }
    return undefined;
  };

  handlers[Opcode.VRowid] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const destOffset = inst.p2;
    const cursor = ctx.getCursor(cIdx);

    if (!cursor?.instance) {
      throw new SqliteError(`VRowid on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }
    if (cursor.instance.eof()) {
       throw new SqliteError(`VRowid on EOF cursor ${cIdx}`, StatusCode.INTERNAL);
    }

    try {
      const rowid = await cursor.instance.rowid();
      ctx.setMem(destOffset, rowid);
    } catch (e) {
      handleVTabError(ctx, e, cursor.vtab?.tableName ?? `cursor ${cIdx}`, 'rowid');
      return ctx.error?.code;
    }
    return undefined;
  };

  handlers[Opcode.VUpdate] = async (ctx, inst) => {
    const nData = inst.p1;
    const regDataStart = inst.p2;
    const regOut = inst.p3;
    const p4Info = inst.p4 as P4Update | null;

    if (!p4Info || p4Info.type !== 'update' || !p4Info.table?.vtabInstance?.module?.xUpdate) {
      throw new SqliteError("VUpdate missing P4 info, table, vtab instance, module, or xUpdate method", StatusCode.INTERNAL);
    }

    const vtabInstance = p4Info.table.vtabInstance;
    const module = vtabInstance.module;

    const values: SqlValue[] = [];
    for (let i = 0; i < nData; i++) {
      values.push(ctx.getMem(regDataStart + i) ?? null);
    }

    // Pass conflict resolution strategy via a conventional property
    (values as any)._onConflict = p4Info.onConflict || ConflictResolution.ABORT;

    const rowidFromData = nData > 0 ? values[0] : null; // RowID is typically the first value for UPDATE/DELETE

    try {
      // Call xUpdate on the module instance
      const result = await module.xUpdate(vtabInstance, values, rowidFromData as bigint | null);

      // Store output (e.g., new rowid for INSERT) if requested
      if (regOut > 0) {
        if (rowidFromData === null) { // INSERT operation
          ctx.setMem(regOut, result?.rowid ?? null);
        } else { // UPDATE/DELETE operation
          ctx.setMem(regOut, null); // Usually no output needed
        }
      }
    } catch (e) {
      handleVTabError(ctx, e, p4Info.table.name, 'xUpdate');
      return ctx.error?.code;
    }
    return undefined;
  };

  // --- VTab Transaction Operations ---
  const vtabTxOp = async (
    ctx: VmCtx,
    inst: VdbeInstruction,
    action: 'xBegin' | 'xCommit' | 'xRollback' | 'xSync' | 'xSavepoint' | 'xRelease' | 'xRollbackTo'
  ) => {
    const startCIdx = inst.p1;
    const endCIdx = inst.p2; // Assumes P2 marks end of cursor range for op
    const savepointIdx = inst.p3; // Used by Savepoint, Release, RollbackTo

    for (let i = startCIdx; i < endCIdx; i++) {
      const cursor = ctx.getCursor(i);
      const module = cursor?.vtab?.module as VirtualTableModule<any, any, any> | undefined;
      const vtab = cursor?.vtab;

      if (module && vtab && typeof module[action] === 'function') {
        try {
          if (action === 'xSavepoint' || action === 'xRelease' || action === 'xRollbackTo') {
            await module[action]!(vtab, savepointIdx);
          } else {
            await module[action]!(vtab);
          }
        } catch (e) {
          handleVTabError(ctx, e, vtab.tableName, action);
          return ctx.error?.code; // Stop on first error
        }
      }
    }
    return undefined; // Continue
  };

  handlers[Opcode.VBegin] = (ctx, inst) => vtabTxOp(ctx, inst, 'xBegin');
  handlers[Opcode.VCommit] = (ctx, inst) => vtabTxOp(ctx, inst, 'xCommit');
  handlers[Opcode.VRollback] = (ctx, inst) => vtabTxOp(ctx, inst, 'xRollback');
  handlers[Opcode.VSync] = (ctx, inst) => vtabTxOp(ctx, inst, 'xSync');
  handlers[Opcode.VSavepoint] = (ctx, inst) => vtabTxOp(ctx, inst, 'xSavepoint');
  handlers[Opcode.VRelease] = (ctx, inst) => vtabTxOp(ctx, inst, 'xRelease');
  handlers[Opcode.VRollbackTo] = (ctx, inst) => vtabTxOp(ctx, inst, 'xRollbackTo');
}
