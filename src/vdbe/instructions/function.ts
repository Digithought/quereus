import { SqliteError } from '../../common/errors';
import { StatusCode, type SqlValue } from '../../common/types';
import { FunctionContext } from '../../func/context';
import type { Handler } from '../handler-types';
import type { P4FuncDef } from '../instruction';
import { Opcode } from '../opcodes';

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
      // Arguments are read relative to the frame pointer
      args.push(ctx.getMem(argsReg + i));
    }

    // Reuse or recreate UDF context? For simplicity, let's assume VmCtx provides one
    // const udfContext = ctx.udfContext; // Assume VmCtx has this
    const udfContext = new FunctionContext(ctx.db, p4Func.funcDef.userData); // Or create new? Let's stick with VmCtx provided one
    ctx.udfContext._clear(); // Clear previous state

    try {
      p4Func.funcDef.xFunc!(ctx.udfContext, Object.freeze(args));
      const err = ctx.udfContext._getError();
      if (err) {
        throw err; // Propagate errors set via context
      }
      // Result is written relative to the frame pointer
      ctx.setMem(resultReg, ctx.udfContext._getResult());
    } catch (e) {
      const funcName = p4Func.funcDef.name;
      console.error(`VDBE Function Error in function ${funcName}:`, e);
      if (e instanceof SqliteError) { throw e; }
      if (e instanceof Error) { throw new SqliteError(`Runtime error in func ${funcName}: ${e.message}`, StatusCode.ERROR); }
      throw new SqliteError(`Unknown runtime error in func ${funcName}`, StatusCode.INTERNAL);
    }

    return undefined; // Continue execution
  };
}

