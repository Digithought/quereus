import { SqliterError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { FunctionContext } from '../../func/context.js';
import type { Handler, VmCtx } from '../handler-types.js';
import type { P4FuncDef } from '../instruction.js';
import { Opcode } from '../opcodes.js';
import { createLogger } from '../../common/logger.js';
import { jsonStringify } from '../../util/serialization.js';

const log = createLogger('vdbe:aggregate');
const errorLog = log.extend('error');

// Helper for error handling in aggregate functions
function handleAggError(ctx: VmCtx, e: any, funcName: string, step: string) {
  errorLog(`Error in function ${funcName} (${step}): %O`, e);
  let error: SqliterError;
  if (e instanceof SqliterError) { error = e; }
  else if (e instanceof Error) { error = new SqliterError(`Runtime error in aggregate ${funcName} ${step}: ${e.message}`, StatusCode.ERROR); }
  else { error = new SqliterError(`Unknown runtime error in aggregate ${funcName} ${step}`, StatusCode.INTERNAL); }
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
      values.push(ctx.getStack(startOffset + i));
    }

    // Serialize the key. JSON is simple but has limitations (e.g., distinguishes -0 and 0).
    // TODO: A more robust serialization might be needed for full SQL compatibility.
    // Handling BigInt and Blobs requires custom replacer.
    const serializedKey = jsonStringify(values);

    ctx.setStack(destOffset, serializedKey);
    return undefined;
  };

  handlers[Opcode.AggStep] = (ctx, inst) => {
    const p4Func = inst.p4 as P4FuncDef;
    if (!p4Func || p4Func.type !== 'funcdef') {
      throw new SqliterError("Invalid P4 for AggStep", StatusCode.INTERNAL);
    }

    const groupKeyStartOffset = inst.p1;
    const argsStartOffset = inst.p2;
    const serializedKeyRegOffset = inst.p3; // Offset where MakeRecord stored the key
    const numGroupKeys = inst.p5;

    const serializedKey = ctx.getStack(serializedKeyRegOffset) as string;
    if (typeof serializedKey !== 'string') {
      throw new SqliterError(`AggStep key must be a string (got ${typeof serializedKey})`, StatusCode.INTERNAL);
    }

    const args: SqlValue[] = [];
    for (let i = 0; i < p4Func.nArgs; i++) {
      args.push(ctx.getStack(argsStartOffset + i));
    }

    const entry = ctx.aggregateContexts?.get(serializedKey);
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
          keyValues.push(ctx.getStack(groupKeyStartOffset + i));
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
      throw new SqliterError("Invalid P4 for AggFinal", StatusCode.INTERNAL);
    }

    // P1 is now the *offset* of the register containing the aggregate context accumulator
    const contextRegOffset = inst.p1;
    const destOffset = inst.p3;

    const accumulatorValue = ctx.getStack(contextRegOffset); // Get accumulator (might be null)

    // Note: Use a fresh context for xFinal
    const finalUdfContext = new FunctionContext(ctx.db, p4Func.funcDef.userData);
    finalUdfContext._setAggregateContextRef(accumulatorValue); // Pass potentially null accumulator

    try {
      p4Func.funcDef.xFinal!(finalUdfContext);
      const finalError = finalUdfContext._getError();
      if (finalError) throw finalError;
      ctx.setStack(destOffset, finalUdfContext._getResult());
    } catch (e) {
      handleAggError(ctx, e, p4Func.funcDef.name, 'xFinal');
      return ctx.error?.code; // Stop execution
    }

    return undefined;
  };

  handlers[Opcode.AggReset] = (ctx) => {
    ctx.aggregateContexts?.clear();
    ctx.aggregateIterator = null;
    ctx.currentAggregateEntry = null;
    return undefined; // PC handled
  };

  handlers[Opcode.AggIterate] = (ctx) => {
    if (!ctx.aggregateContexts) {
      throw new SqliterError("Aggregate context map not initialized", StatusCode.INTERNAL);
    }
    ctx.aggregateIterator = ctx.aggregateContexts.entries();
    ctx.currentAggregateEntry = null;
    return undefined;
  };

  handlers[Opcode.AggNext] = (ctx, inst) => {
    const jumpTarget = inst.p2;
    if (!ctx.aggregateIterator) {
      throw new SqliterError("AggNext without AggIterate", StatusCode.INTERNAL);
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
      throw new SqliterError("AggKey on invalid iterator", StatusCode.INTERNAL);
    }
    // Key is the first element of the entry [serializedKey, {accumulator, keyValues}]
    ctx.setStack(destOffset, ctx.currentAggregateEntry[0]);
    return undefined;
  };

  handlers[Opcode.AggContext] = (ctx, inst) => {
    const destOffset = inst.p2;
    if (!ctx.currentAggregateEntry) {
      throw new SqliterError("AggContext on invalid iterator", StatusCode.INTERNAL);
    }
    // Accumulator is in the second element of the entry
    ctx.setStack(destOffset, ctx.currentAggregateEntry[1]?.accumulator);
    return undefined;
  };

  handlers[Opcode.AggGroupValue] = (ctx, inst) => {
    const keyIndex = inst.p2;
    const destOffset = inst.p3;
    if (!ctx.currentAggregateEntry) {
      throw new SqliterError("AggGroupValue on invalid iterator", StatusCode.INTERNAL);
    }
    const keyValues = ctx.currentAggregateEntry[1]?.keyValues;
    if (!keyValues || keyIndex < 0 || keyIndex >= keyValues.length) {
      throw new SqliterError(`Invalid key index ${keyIndex} for AggGroupValue`, StatusCode.INTERNAL);
    }
    ctx.setStack(destOffset, keyValues[keyIndex] ?? null);
    return undefined;
  };

  handlers[Opcode.AggGetContext] = (ctx, inst) => {
    const destReg = inst.p1;
    const keyReg = inst.p2;
    const key = ctx.getStack(keyReg);

    if (typeof key !== 'string') {
      throw new SqliterError(`AggGetContext key must be a string (got ${typeof key})`, StatusCode.INTERNAL);
    }

    if (!ctx.aggregateContexts) {
      throw new SqliterError("AggGetContext: Aggregate context map not initialized", StatusCode.INTERNAL);
    }

    const entry = ctx.aggregateContexts.get(key);
    const accumulator = entry?.accumulator ?? null; // Default to null if key not found or context undefined

    ctx.setStack(destReg, accumulator);
    return undefined;
  };

  handlers[Opcode.AggGetAccumulatorByKey] = (ctx, inst) => {
    const keyRegOffset = inst.p1;
    const destAccumulatorRegOffset = inst.p2;

    if (!ctx.aggregateContexts) {
      throw new SqliterError("AggGetAccumulatorByKey: Aggregate context map not initialized", StatusCode.INTERNAL);
    }

    const serializedKey = ctx.getStack(keyRegOffset) as string;
    if (typeof serializedKey !== 'string') {
      throw new SqliterError(`AggGetAccumulatorByKey key must be a string (got ${typeof serializedKey})`, StatusCode.INTERNAL);
    }

    const entry = ctx.aggregateContexts.get(serializedKey);
    const accumulator = entry?.accumulator ?? null; // Default to null if key not found

    ctx.setStack(destAccumulatorRegOffset, accumulator);
    return undefined;
  };
}
