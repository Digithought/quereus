import { SqliterError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { FunctionContext } from '../../func/context.js';
import type { Handler } from '../handler-types.js';
import type { P4FuncDef } from '../instruction.js';
import { Opcode } from '../opcodes.js';
import { createLogger } from '../../common/logger.js';
import { safeJsonStringify } from '../../util/serialization.js';

const log = createLogger('vdbe:function');

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.Function] = (ctx, inst) => {
    const p4Func = inst.p4 as P4FuncDef;
    if (!p4Func || p4Func.type !== 'funcdef') {
      throw new SqliterError("Invalid P4 for Function", StatusCode.INTERNAL);
    }

    const argsReg = inst.p1;
    const resultReg = inst.p3;
    const args: SqlValue[] = [];
    log(`Function: ${p4Func.funcDef.name}. Reading ${p4Func.nArgs} args from base reg ${argsReg}. Result to reg ${resultReg}`); // DEBUG
    for (let i = 0; i < p4Func.nArgs; i++) {
      const argVal = ctx.getStack(argsReg + i);
      log(`  Arg ${i} (from reg ${argsReg + i}): ${safeJsonStringify(argVal)}`); // DEBUG
      args.push(argVal);
    }

    const localUdfContext = new FunctionContext(ctx.db, p4Func.funcDef.userData);

    try {
      log(`  Calling xFunc for ${p4Func.funcDef.name}...`); // DEBUG
      p4Func.funcDef.xFunc!(localUdfContext, args);
      log(`  xFunc for ${p4Func.funcDef.name} returned. Checking context error/result...`); // DEBUG
      const funcError = localUdfContext._getError();
      if (funcError) {
        log(`  Function context returned error: ${funcError.message}`); // DEBUG
        throw funcError;
      }
      const funcResult = localUdfContext._getResult();
      log(`  Function context result: ${safeJsonStringify(funcResult)}`); // DEBUG
      ctx.setStack(resultReg, funcResult);
      log(`  Set result reg ${resultReg} to: ${safeJsonStringify(funcResult)}`); // DEBUG
    } catch (e) {
      log(`  Error during function execution: ${e instanceof Error ? e.message : String(e)}`); // DEBUG
      if (e instanceof SqliterError) { throw e; }
      if (e instanceof Error) { throw new SqliterError(`Runtime error in func ${p4Func.funcDef.name}: ${e.message}`, StatusCode.ERROR); }
      throw new SqliterError(`Unknown runtime error in func ${p4Func.funcDef.name}`, StatusCode.INTERNAL);
    } finally {
      localUdfContext._cleanupAuxData();
    }
    return undefined;
  };
}

