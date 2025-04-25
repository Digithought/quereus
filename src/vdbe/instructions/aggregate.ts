import { SqliteError } from '../../common/errors';
import { StatusCode, type SqlValue } from '../../common/types';
import { FunctionContext } from '../../func/context';
import type { Handler, VmCtx } from '../handler-types';
import type { P4FuncDef } from '../instruction';
import { Opcode } from '../opcodes';

// Helper for error handling in aggregate functions
function handleAggError(ctx: VmCtx, e: any, funcName: string, step: string) {
  console.error(`VDBE Agg Error in function ${funcName} (${step}):`, e);
  let error: SqliteError;
  if (e instanceof SqliteError) { error = e; }
  else if (e instanceof Error) { error = new SqliteError(`Runtime error in aggregate ${funcName} ${step}: ${e.message}`, StatusCode.ERROR); }
  else { error = new SqliteError(`Unknown runtime error in aggregate ${funcName} ${step}`, StatusCode.INTERNAL); }
  ctx.error = error;
  ctx.done = true;
}

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.MakeRecord] = (ctx, inst) => {
    const startOffset = inst.p1;
    const count = inst.p2;
    const destOffset = inst.p3;

    const values: SqlValue[] = [];
    for (let i = 0; i < count; i++) {
      values.push(ctx.getMem(startOffset + i));
    }

    // Serialize the key. JSON is simple but has limitations (e.g., distinguishes -0 and 0).
    // A more robust serialization might be needed for full SQL compatibility.
    // Handling BigInt and Blobs requires custom replacer.
    const serializedKey = JSON.stringify(values, (_, val) =>
      typeof val === 'bigint'
        ? `bigint:${val.toString()}`
        : val instanceof Uint8Array
        ? `blob:${Buffer.from(val).toString('hex')}`
        : val
    );

    ctx.setMem(destOffset, serializedKey);
    return undefined;
  };

  handlers[Opcode.AggStep] = (ctx, inst) => {
    const p4Func = inst.p4 as P4FuncDef;
    if (!p4Func || p4Func.type !== 'funcdef') {
      throw new SqliteError("Invalid P4 for AggStep", StatusCode.INTERNAL);
    }

    const groupKeyStartOffset = inst.p1;
    const argsStartOffset = inst.p2;
    const serializedKeyRegOffset = inst.p3; // Offset where MakeRecord stored the key
    const numGroupKeys = inst.p5;

    const serializedKey = ctx.getMem(serializedKeyRegOffset) as string;
    if (typeof serializedKey !== 'string') {
      throw new SqliteError(`AggStep key must be a string (got ${typeof serializedKey})`, StatusCode.INTERNAL);
    }

    const args: SqlValue[] = [];
    for (let i = 0; i < p4Func.nArgs; i++) {
      args.push(ctx.getMem(argsStartOffset + i));
    }

    let entry = ctx.aggregateContexts?.get(serializedKey);
    ctx.udfContext._clear();
    ctx.udfContext._setAggregateContextRef(entry?.accumulator);

    try {
      p4Func.funcDef.xStep!(ctx.udfContext, Object.freeze(args));
      const stepError = ctx.udfContext._getError();
      if (stepError) throw stepError;

      const newAcc = ctx.udfContext._getAggregateContextRef();

      if (entry === undefined && newAcc !== undefined) {
        // First time seeing this key, store accumulator and grouping key values
        const keyValues: SqlValue[] = [];
        for (let i = 0; i < numGroupKeys; i++) {
          keyValues.push(ctx.getMem(groupKeyStartOffset + i));
        }
        ctx.aggregateContexts?.set(serializedKey, {
          accumulator: newAcc,
          keyValues: Object.freeze(keyValues),
        });
      } else if (entry !== undefined && newAcc !== undefined && newAcc !== entry.accumulator) {
        // Update existing accumulator if it changed
        entry.accumulator = newAcc;
      }
    } catch (e) {
      handleAggError(ctx, e, p4Func.funcDef.name, 'xStep');
      return ctx.error?.code; // Stop execution
    }

    return undefined; // Continue execution
  };

  handlers[Opcode.AggFinal] = (ctx, inst) => {
    const p4Func = inst.p4 as P4FuncDef;
    if (!p4Func || p4Func.type !== 'funcdef') {
      throw new SqliteError("Invalid P4 for AggFinal", StatusCode.INTERNAL);
    }

    const serializedKeyRegOffset = inst.p1;
    const destOffset = inst.p3;

    const serializedKey = ctx.getMem(serializedKeyRegOffset) as string;
     if (typeof serializedKey !== 'string') {
      throw new SqliteError(`AggFinal key must be a string (got ${typeof serializedKey})`, StatusCode.INTERNAL);
    }

    const entry = ctx.aggregateContexts?.get(serializedKey);
    // Note: Should use a fresh context or ensure udfContext is clean for xFinal
    const finalUdfContext = new FunctionContext(ctx.db, p4Func.funcDef.userData);
    finalUdfContext._setAggregateContextRef(entry?.accumulator);

    try {
      p4Func.funcDef.xFinal!(finalUdfContext);
      const finalError = finalUdfContext._getError();
      if (finalError) throw finalError;
      ctx.setMem(destOffset, finalUdfContext._getResult());
    } catch (e) {
      handleAggError(ctx, e, p4Func.funcDef.name, 'xFinal');
      return ctx.error?.code; // Stop execution
    }

    return undefined;
  };

  handlers[Opcode.AggReset] = (ctx, inst) => {
    ctx.aggregateContexts?.clear();
    ctx.aggregateIterator = null;
    ctx.currentAggregateEntry = null;
    return undefined;
  };

  handlers[Opcode.AggIterate] = (ctx, inst) => {
    if (!ctx.aggregateContexts) {
      throw new SqliteError("Aggregate context map not initialized", StatusCode.INTERNAL);
    }
    ctx.aggregateIterator = ctx.aggregateContexts.entries();
    ctx.currentAggregateEntry = null;
    return undefined;
  };

  handlers[Opcode.AggNext] = (ctx, inst) => {
    const jumpTarget = inst.p2;
    if (!ctx.aggregateIterator) {
      throw new SqliteError("AggNext without AggIterate", StatusCode.INTERNAL);
    }
    const nextResult = ctx.aggregateIterator.next();
    if (nextResult.done) {
      ctx.currentAggregateEntry = null;
      ctx.pc = jumpTarget; // Jump to end address
    } else {
      ctx.currentAggregateEntry = nextResult.value;
      ctx.pc++; // Continue to next instruction
    }
    return undefined; // PC handled
  };

  handlers[Opcode.AggKey] = (ctx, inst) => {
    const destOffset = inst.p2;
    if (!ctx.currentAggregateEntry) {
      throw new SqliteError("AggKey on invalid iterator", StatusCode.INTERNAL);
    }
    // Key is the first element of the entry [serializedKey, {accumulator, keyValues}]
    ctx.setMem(destOffset, ctx.currentAggregateEntry[0]);
    return undefined;
  };

  handlers[Opcode.AggContext] = (ctx, inst) => {
    const destOffset = inst.p2;
    if (!ctx.currentAggregateEntry) {
      throw new SqliteError("AggContext on invalid iterator", StatusCode.INTERNAL);
    }
    // Accumulator is in the second element of the entry
    ctx.setMem(destOffset, ctx.currentAggregateEntry[1]?.accumulator);
    return undefined;
  };

  handlers[Opcode.AggGroupValue] = (ctx, inst) => {
    const keyIndex = inst.p2;
    const destOffset = inst.p3;
    if (!ctx.currentAggregateEntry) {
      throw new SqliteError("AggGroupValue on invalid iterator", StatusCode.INTERNAL);
    }
    const keyValues = ctx.currentAggregateEntry[1]?.keyValues;
    if (!keyValues || keyIndex < 0 || keyIndex >= keyValues.length) {
      throw new SqliteError(`Invalid key index ${keyIndex} for AggGroupValue`, StatusCode.INTERNAL);
    }
    ctx.setMem(destOffset, keyValues[keyIndex] ?? null);
    return undefined;
  };
}
