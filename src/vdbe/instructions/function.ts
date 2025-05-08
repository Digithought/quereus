import { SqliteError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { FunctionContext } from '../../func/context.js';
import type { Handler } from '../handler-types.js';
import type { P4FuncDef } from '../instruction.js';
import { Opcode } from '../opcodes.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('vdbe:function');
const errorLog = log.extend('error');

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.Function] = (ctx, inst) => {
    const p4Func = inst.p4 as P4FuncDef;
    if (!p4Func || p4Func.type !== 'funcdef') {
      throw new SqliteError("Invalid P4 for Function", StatusCode.INTERNAL);
    }

    const argsReg = inst.p2;
    const resultReg = inst.p3;
    const args: SqlValue[] = [];
    for (let i = 0; i < p4Func.nArgs; i++) {
      // Arguments are read from absolute register locations
      args.push(ctx.getStack(argsReg + i));
    }

    // Reuse or recreate UDF context? For simplicity, let's assume VmCtx provides one
    // const udfContext = ctx.udfContext; // Assume VmCtx has this
    const localUdfContext = new FunctionContext(ctx.db, p4Func.funcDef.userData); // Create NEW local context
    // ctx.udfContext._clear(); // Don't clear the shared one here

    try {
      // Pass the LOCAL context to the function
      p4Func.funcDef.xFunc!(localUdfContext, Object.freeze(args));
      const err = localUdfContext._getError(); // Get error from LOCAL context
      if (err) {
        throw err; // Propagate errors set via context
      }
      // Result is written to an absolute register location
      // Get result from LOCAL context
      ctx.setStack(resultReg, localUdfContext._getResult());
    } catch (e) {
      const funcName = p4Func.funcDef.name;
      errorLog(`Error in function ${funcName}: %O`, e);
      if (e instanceof SqliteError) { throw e; }
      if (e instanceof Error) { throw new SqliteError(`Runtime error in func ${funcName}: ${e.message}`, StatusCode.ERROR); }
      throw new SqliteError(`Unknown runtime error in func ${funcName}`, StatusCode.INTERNAL);
    }

    return undefined; // Continue execution
  };
}

