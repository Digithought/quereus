import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Handler, VmCtx } from '../handler-types.js';
import { Opcode } from '../opcodes.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('vdbe:seek');
const errorLog = log.extend('error');

// Re-use VTab error helper if applicable, or define a local one
function handleSeekError(ctx: VmCtx, e: any, cursorIdx: number, method: string) {
    const message = `Error in cursor ${cursorIdx} during ${method}: ${e instanceof Error ? e.message : String(e)}`;
    const code = e instanceof SqliteError ? e.code : StatusCode.ERROR;
    ctx.error = new SqliteError(message, code, e instanceof Error ? e : undefined);
    ctx.done = true;
    errorLog(ctx.error);
}

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.SeekRelative] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const addrJump = inst.p2;
    const offsetReg = inst.p3;
    const invertJump = inst.p5 === 1;

    const cursor = ctx.getCursor(cIdx);
    if (!cursor?.instance) {
      throw new SqliteError(`SeekRelative: Invalid or unopened cursor index ${cIdx}`, StatusCode.INTERNAL);
    }
    if (typeof cursor.instance.seekRelative !== 'function') {
        throw new SqliteError(`SeekRelative not supported by cursor ${cIdx}`, StatusCode.MISUSE);
    }

    const offsetValue = ctx.getStack(offsetReg);
    let offset: number;
    if (typeof offsetValue === 'number') {
      offset = offsetValue;
    } else if (typeof offsetValue === 'bigint') {
      offset = Number(offsetValue); // Potential precision loss, but likely ok for relative seeks
    } else {
      throw new SqliteError(`SeekRelative: Offset value must be a number or bigint, got ${typeof offsetValue} (cursor ${cIdx})`, StatusCode.INTERNAL);
    }

    let seekResult = false;
    try {
      seekResult = await cursor.instance.seekRelative(offset);
    } catch (e) {
      handleSeekError(ctx, e, cIdx, 'seekRelative');
      return ctx.error?.code;
    }

    // Jump if (seek successful AND not inverted) OR (seek failed AND inverted)
    if ((seekResult && !invertJump) || (!seekResult && invertJump)) {
      ctx.pc = addrJump;
    } else {
      ctx.pc++;
    }
    return undefined; // PC handled
  };

  handlers[Opcode.SeekRowid] = async (ctx, inst) => {
    const cIdx = inst.p1;
    const addrJump = inst.p2;
    const rowidReg = inst.p3;
    const invertJump = inst.p5 === 1; // Added for SQLite parity (SeekLt, SeekGt, etc.)

    const cursor = ctx.getCursor(cIdx);
    if (!cursor?.instance) {
        throw new SqliteError(`SeekRowid: Invalid or unopened cursor index ${cIdx}`, StatusCode.INTERNAL);
    }
    if (typeof cursor.instance.seekToRowid !== 'function') {
        throw new SqliteError(`SeekRowid not supported by cursor ${cIdx}`, StatusCode.MISUSE);
    }

    const rowidValue = ctx.getStack(rowidReg);
    let targetRowid: bigint;
    if (typeof rowidValue === 'bigint') {
      targetRowid = rowidValue;
    } else if (typeof rowidValue === 'number' && Number.isInteger(rowidValue)) {
      targetRowid = BigInt(rowidValue);
    } else {
      throw new SqliteError(`SeekRowid: Target rowid must be an integer or bigint, got ${typeof rowidValue} (cursor ${cIdx})`, StatusCode.INTERNAL);
    }

    let seekResult = false;
    try {
      seekResult = await cursor.instance.seekToRowid(targetRowid);
    } catch (e) {
      handleSeekError(ctx, e, cIdx, 'seekToRowid');
      return ctx.error?.code;
    }

    // Jump if (seek successful AND not inverted) OR (seek failed AND inverted)
    if ((seekResult && !invertJump) || (!seekResult && invertJump)) {
      ctx.pc = addrJump;
    } else {
      ctx.pc++;
    }
    return undefined; // PC handled
  };
}
