import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import type { Handler, VmCtx } from '../handler-types.js';
import type { P4Update, VdbeInstruction, P4OpenTvf } from '../instruction.js';
import { Opcode } from '../opcodes.js';
import { ConflictResolution } from '../../common/constants.js';
import type { IndexConstraint, IndexConstraintUsage, IndexInfo } from '../../vtab/indexInfo.js';
import type { IndexSchema } from '../../schema/table.js';
import type { VirtualTable } from '../../vtab/table.js';

// Helper for handling errors from VTab methods
function handleVTabError(ctx: VmCtx, e: any, vtabName: string, method: string) {
  const message = `Error in VTab ${vtabName}.${method}: ${e instanceof Error ? e.message : String(e)}`;
  const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
  ctx.error = new QuereusError(message, code, e instanceof Error ? e : undefined);
  ctx.done = true;
}

export function registerHandlers(handlers: Handler[]) {
  // --- VTab Cursor Operations ---

	handlers[Opcode.VFilter] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const addrIfEmpty = inst.p2;
    const argsReg = inst.p3;
    const p4Info = inst.p4 as {
      idxNum: number;
      idxStr: string | null;
      nArgs: number;
      aConstraint: ReadonlyArray<IndexConstraint>;
      aConstraintUsage: IndexConstraintUsage[];
      nOrderBy?: number;
      aOrderBy?: ReadonlyArray<{ iColumn: number; desc: boolean }>;
      colUsed?: bigint;
      idxFlags?: number;
      estimatedCost?: number;
      estimatedRows?: bigint;
      orderByConsumed?: boolean;
    } | null;

    const cursor = ctx.getCursor(cIdx);
    if (!cursor?.instance) {
      throw new QuereusError(`VFilter on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }
    cursor.currentEofJumpTarget = addrIfEmpty; // Store VFilter's EOF jump target
    if (!p4Info) {
      throw new QuereusError(`VFilter missing P4 info for cursor ${cIdx}`, StatusCode.INTERNAL);
    }

    const args: SqlValue[] = [];
    for (let i = 0; i < p4Info.nArgs; i++) {
      args.push(ctx.getStack(argsReg + i));
    }

    // Determine constraints to pass to the VTab filter method.
    // The VTab filter expects constraints relevant to the *chosen plan* (idxNum/idxStr).
    // aConstraintUsage maps *all* potential constraints to their argvIndex if used.
    // We pass the full IndexInfo and let the VTab filter/cursor decide which ones to use.
    const constraintsToPass: { constraint: IndexConstraint, argvIndex: number }[] = [];
    if (p4Info.aConstraint && p4Info.aConstraintUsage) {
        p4Info.aConstraintUsage.forEach((usage, constraintIdx) => {
            if (usage.argvIndex > 0 && constraintIdx < p4Info.aConstraint.length) {
                constraintsToPass.push({
                    constraint: p4Info.aConstraint[constraintIdx],
                    argvIndex: usage.argvIndex
                });
            }
        });
    }

    try {
      // Convert p4Info to IndexInfo properly
      const indexInfo: IndexInfo = {
        nConstraint: p4Info.aConstraint?.length ?? 0,
        aConstraint: p4Info.aConstraint ?? [],
        nOrderBy: p4Info.nOrderBy ?? 0,
        aOrderBy: p4Info.aOrderBy ?? [],
        colUsed: p4Info.colUsed ?? BigInt(-1),
        aConstraintUsage: p4Info.aConstraintUsage ?? [],
        idxNum: p4Info.idxNum,
        idxStr: p4Info.idxStr,
        orderByConsumed: p4Info.orderByConsumed ?? false,
        estimatedCost: p4Info.estimatedCost ?? 0,
        estimatedRows: p4Info.estimatedRows ?? BigInt(0),
        idxFlags: p4Info.idxFlags ?? 0,
      };

      await cursor.instance.filter(
        p4Info.idxNum,
        p4Info.idxStr,
        constraintsToPass, // Pass only the constraints with argvIndex > 0
        args,
        indexInfo          // Pass the full IndexInfo
      );

      const eofStatus = cursor.instance.eof();
      if (eofStatus) {
        ctx.pc = addrIfEmpty;
      }

    } catch (e) {
      handleVTabError(ctx, e, cursor.vtab?.tableName ?? `cursor ${cIdx}`, 'filter');
      return ctx.error?.code;
    }
    return undefined;
  };

  handlers[Opcode.VNext] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const addrIf_NOT_EOF_LoopTarget = inst.p2;

    const cursor = ctx.getCursor(cIdx);

    // Handle pre-sorted results (e.g., from Sort or materialized views)
    if (cursor) { // Check cursor first
      if (cursor.sortedResults) { // Then check sortedResults
        const s = cursor.sortedResults;
        s.index++;
        if (s.index >= s.rows.length) { // EOF for sorted results
          if (cursor.currentEofJumpTarget === undefined) { // cursor is definitely defined here
            throw new QuereusError(`VNext (sorted) on cursor ${cIdx} found EOF, but no EOF jump target was set.`, StatusCode.INTERNAL);
          }
          ctx.pc = cursor.currentEofJumpTarget;
        } else { // Not EOF for sorted results
          ctx.pc = addrIf_NOT_EOF_LoopTarget;
        }
        return undefined; // PC handled
      }
    }

    // If we reach here, it's not sorted results, or cursor was initially undefined.
    // The next check handles !cursor or !cursor.instance
    if (!cursor?.instance) { // This check is fine as is, or can be if (!cursor || !cursor.instance)
      throw new QuereusError(`VNext on unopened or undefined cursor ${cIdx}`, StatusCode.INTERNAL);
    }

    try {
      await cursor.instance.next();
      const eof = cursor.instance.eof();
      if (eof) {
        if (cursor.currentEofJumpTarget === undefined) {
          throw new QuereusError(`VNext on cursor ${cIdx} found EOF, but no EOF jump target was set by VFilter/Rewind.`, StatusCode.INTERNAL);
        }
        ctx.pc = cursor.currentEofJumpTarget;
        // log is not available here by default, VDBE runtime log will show PC change.
      } else {
        ctx.pc = addrIf_NOT_EOF_LoopTarget;
      }
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

    if (!cursor?.instance) {
      throw new QuereusError(`Rewind on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }

    cursor.currentEofJumpTarget = addrIfEmpty; // Store Rewind's EOF jump target

    // Handle pre-sorted results
    if (cursor?.sortedResults) {
      const s = cursor.sortedResults;
      s.index = 0;
      ctx.pc = (s.rows.length === 0) ? addrIfEmpty : ctx.pc + 1;
      return undefined; // PC handled
    }

    const defaultIndexInfo: IndexInfo = {
      nConstraint: 0,
      aConstraint: [],
      nOrderBy: 0,
      aOrderBy: [],
      colUsed: BigInt(-1),
      aConstraintUsage: [],
      idxNum: 0,
      idxStr: null,
      orderByConsumed: false,
      estimatedCost: 0,
      estimatedRows: BigInt(0),
      idxFlags: 0,
    };

    try {
      await cursor.instance.filter(0, null, [], [], defaultIndexInfo);
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
        throw new QuereusError(`VColumn on invalid sorted cursor index ${s.index} (cursor ${cIdx})`, StatusCode.INTERNAL);
      }
      const row = s.rows[s.index];
      if (colIdx < 0 || colIdx >= row.length) {
        // Potentially handle RowID request (colIdx == -1) if stored explicitly
        throw new QuereusError(`VColumn index ${colIdx} out of bounds for sorted row (cursor ${cIdx})`, StatusCode.INTERNAL);
      }
      ctx.setStack(destOffset, row[colIdx].value);
      return undefined;
    }

    if (!cursor?.instance) {
      throw new QuereusError(`VColumn on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }
    if (cursor.instance.eof()) {
      // Reading from EOF cursor should yield NULL, consistent with SQLite
      ctx.setStack(destOffset, null);
      // throw new QuereusError(`VColumn on EOF cursor ${cIdx}`, StatusCode.INTERNAL);
      return undefined;
    }

    try {
      // Reuse VTab context provided by VmCtx
      ctx.vtabContext._clear();
      // const status = cursor.instance.column(ctx.vtabContext, colIdx);
      // if (status !== StatusCode.OK) {
      //   throw new QuereusError(`VColumn failed (col ${colIdx}, cursor ${cIdx})`, status);
      // }
      ctx.setStack(destOffset, ctx.vtabContext._getResult());
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
      throw new QuereusError(`VRowid on unopened cursor ${cIdx}`, StatusCode.INTERNAL);
    }
    if (cursor.instance.eof()) {
       throw new QuereusError(`VRowid on EOF cursor ${cIdx}`, StatusCode.INTERNAL);
    }

    try {
      const rowid = await cursor.instance.rowid();
      ctx.setStack(destOffset, rowid);
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

    // Get target cursor index from p5
    const updateCursorIdx = inst.p5;
    if (updateCursorIdx === undefined || updateCursorIdx < 0) {
      throw new QuereusError(`VUpdate instruction requires a valid cursor index in p5`, StatusCode.INTERNAL);
    }

    const cursor = ctx.getCursor(updateCursorIdx);
    const vtabInstance = cursor?.vtab;

    if (!p4Info || p4Info.type !== 'update' || !p4Info.table) {
      throw new QuereusError("VUpdate missing P4 info or table schema", StatusCode.INTERNAL);
    }
    if (!vtabInstance) {
      throw new QuereusError(`VUpdate target cursor ${updateCursorIdx} does not have an active VTab instance`, StatusCode.INTERNAL);
    }
    if (typeof vtabInstance.xUpdate !== 'function') {
      throw new QuereusError(`VTab instance for ${vtabInstance.tableName} does not implement xUpdate`, StatusCode.MISUSE);
    }

    // const module = vtabInstance.module; // No longer needed

    const values: SqlValue[] = [];
    for (let i = 0; i < nData; i++) {
      values.push(ctx.getStack(regDataStart + i) ?? null);
    }

    // Pass conflict resolution strategy via a conventional property
    (values as any)._onConflict = p4Info.onConflict || ConflictResolution.ABORT;

    const rowidFromData = nData > 0 ? values[0] : null; // RowID is typically the first value for UPDATE/DELETE

    try {
      // Call xUpdate on the vtab instance directly
      const result = await vtabInstance.xUpdate(values, rowidFromData as bigint | null);

      // Store output (e.g., new rowid for INSERT) if requested
      if (regOut > 0) {
        if (rowidFromData === null) { // INSERT operation
          ctx.setStack(regOut, result?.rowid ?? null);
        } else { // UPDATE/DELETE operation
          ctx.setStack(regOut, null); // Usually no output needed
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
      // const module = cursor?.vtab?.module as VirtualTableModule<any, any, any> | undefined;
      const vtab = cursor?.vtab;

      // Check if vtab exists and the action method exists on it
      if (vtab && typeof (vtab as any)[action] === 'function') {
        try {
          if (action === 'xSavepoint' || action === 'xRelease' || action === 'xRollbackTo') {
            await (vtab as any)[action]!(savepointIdx);
          } else {
            await (vtab as any)[action]!();
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

  // --- Add VTab DDL Handlers ---

  handlers[Opcode.VCreateIndex] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const indexSchema = inst.p4 as IndexSchema;
    // const tableSchema = inst.p5 as TableSchema | undefined; // Assuming table schema might be in P5

    const cursor = ctx.getCursor(cIdx);
    const vtabInstance = cursor?.vtab;

    if (!vtabInstance) {
      throw new QuereusError(`VCreateIndex target cursor ${cIdx} does not have an active VTab instance`, StatusCode.INTERNAL);
    }
    if (typeof vtabInstance.xCreateIndex !== 'function') {
      throw new QuereusError(`VTab instance for ${vtabInstance.tableName} does not implement xCreateIndex`, StatusCode.MISUSE);
    }
    if (!indexSchema) {
      throw new QuereusError(`VCreateIndex missing IndexSchema info in P4`, StatusCode.INTERNAL);
    }

    try {
      await vtabInstance.xCreateIndex(indexSchema);
      // VCreateIndex modifies state but doesn't advance PC or return data directly
    } catch (e) {
      handleVTabError(ctx, e, vtabInstance.tableName, 'xCreateIndex');
      return ctx.error?.code; // Stop on error
    }
    return undefined; // Continue execution
  };

  handlers[Opcode.VDropIndex] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const indexName = inst.p4 as string;

    const cursor = ctx.getCursor(cIdx);
    const vtabInstance = cursor?.vtab;

    if (!vtabInstance) {
      throw new QuereusError(`VDropIndex target cursor ${cIdx} does not have an active VTab instance`, StatusCode.INTERNAL);
    }
    if (typeof vtabInstance.xDropIndex !== 'function') {
      throw new QuereusError(`VTab instance for ${vtabInstance.tableName} does not implement xDropIndex`, StatusCode.MISUSE);
    }
    if (typeof indexName !== 'string' || !indexName) {
      throw new QuereusError(`VDropIndex missing index name string in P4`, StatusCode.INTERNAL);
    }

    try {
      await vtabInstance.xDropIndex(indexName);
      // VDropIndex modifies state but doesn't advance PC or return data directly
    } catch (e) {
      handleVTabError(ctx, e, vtabInstance.tableName, 'xDropIndex');
      return ctx.error?.code; // Stop on error
    }
    return undefined; // Continue execution
  };

	handlers[Opcode.OpenTvf] = async (ctx, inst) => {
    const cIdx = inst.p1;                // Cursor index to open
    const regArgBase = inst.p2;          // Base register for arguments
    const nArg = inst.p3;                // Number of arguments
    const p4 = inst.p4 as P4OpenTvf | null; // Get P4 object

    if (!p4 || p4.type !== 'opentvf') {
      throw new QuereusError(`OpenTvf P4 must be a P4OpenTvf object`, StatusCode.INTERNAL);
    }
    const moduleName = p4.moduleName;
    const alias = p4.alias;

    // 1. Get the VTab module
    const moduleInfo = ctx.db._getVtabModule(moduleName);
    if (!moduleInfo) {
      throw new QuereusError(`Table-valued function or module not found: ${moduleName}`, StatusCode.ERROR);
    }

    // 2. Read evaluated arguments from registers
    const args: SqlValue[] = [];
    for (let i = 0; i < nArg; i++) {
      args.push(ctx.getStack(regArgBase + i));
    }

    // 3. Construct the configuration/options object for xConnect
    //    This requires a convention for mapping args. For json_each/json_tree:
    //    arg[0] = jsonSource
    //    arg[1] = rootPath (optional)
    let options: any = {}; // Use 'any' for flexibility, module should validate
    try {
      const moduleNameLower = moduleName.toLowerCase();
      if (moduleNameLower === 'json_each' || moduleNameLower === 'json_tree') {
        if (nArg < 1 || nArg > 2) {
          throw new Error(`${moduleName} requires 1 or 2 arguments (jsonSource, [rootPath])`);
        }
        options.jsonSource = args[0];
        if (nArg > 1) {
          options.rootPath = args[1];
        }
      } else if (moduleNameLower === 'query_plan') {
        if (nArg !== 1) {
          throw new Error(`'${moduleName}' requires exactly one argument (the SQL string to explain).`);
        }
        if (typeof args[0] !== 'string') {
          throw new Error(`Argument to '${moduleName}' must be a string.`);
        }
        options.sql = args[0]; // Pass the SQL string in the expected format
      } else {
				// TODO: Make this general - able to invoke any function with any arguments
        // Generic module: Pass args as a property? Needs a defined convention.
        // For now, we don't have other TVFs, so we'll error or pass empty.
        options = {}; // Default empty config
      }
    } catch (e: any) {
        const message = `Failed to map arguments for TVF module '${moduleName}': ${e.message}`;
        ctx.error = new QuereusError(message, StatusCode.ERROR, e instanceof Error ? e : undefined);
        ctx.done = true;
        return ctx.error.code;
    }

    // 4. Call xConnect to get the VTab instance
    let vtabInstance: VirtualTable;
    try {
        // Using alias as tableName for xConnect, consistent with compiler stub
        vtabInstance = await moduleInfo.module.xConnect(
            ctx.db,
            moduleInfo.auxData,
            moduleName,
            'main', // Default schema for TVFs
            alias,    // Table name is the alias
            options
        );
        if (!vtabInstance || !vtabInstance.tableSchema) {
            throw new QuereusError(`Module ${moduleName} xConnect did not return a valid table instance or schema.`, StatusCode.INTERNAL);
        }
    } catch (e) {
        handleVTabError(ctx, e, moduleName, 'xConnect');
        return ctx.error?.code;
    }

    // 5. Call xOpen to get the cursor instance
    let cursorInstance;
    try {
        cursorInstance = await vtabInstance.xOpen();
        if (!cursorInstance) {
            throw new QuereusError(`Module ${moduleName} xOpen did not return a cursor instance.`, StatusCode.INTERNAL);
        }
    } catch (e) {
        handleVTabError(ctx, e, alias, 'xOpen');
        return ctx.error?.code;
    }

    // 6. Store the cursor instance in the runtime
    const vdbeCursor = ctx.getCursor(cIdx);
    if (!vdbeCursor) {
        // This shouldn't happen if compiler allocated cursor correctly
        throw new QuereusError(`OpenTvf target cursor ${cIdx} not allocated in runtime`, StatusCode.INTERNAL);
    }
    vdbeCursor.instance = cursorInstance;
    vdbeCursor.vtab = vtabInstance; // Store VTab instance too
    vdbeCursor.isEphemeral = true; // TVF cursors are generally ephemeral

    return undefined; // Success, continue execution
  };
}
