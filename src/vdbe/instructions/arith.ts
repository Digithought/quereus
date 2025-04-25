import { SqliteError } from "../../common/errors";
import { StatusCode } from "../../common/types";
import type { Handler } from "../handler-types";
import type { Status, VmCtx } from "../handler-types";
import { Opcode } from "../opcodes";

function binaryArithOp(ctx: VmCtx, r1: number, r2: number, dest: number, op: (a: any, b: any) => any): Status {
	const v1 = ctx.getMem(r1);
	const v2 = ctx.getMem(r2);
	let result = null;

	if (v1 !== null && v2 !== null) {
		if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
			try {
				result = op(BigInt(v1 as any), BigInt(v2 as any));
			} catch {
				result = null;
			}
		} else {
			const n1 = Number(v1);
			const n2 = Number(v2);
			if (!isNaN(n1) && !isNaN(n2)) {
				try {
					result = op(n1, n2);
					if (typeof result === 'number' && !Number.isFinite(result)) {
						result = null;
					}
				} catch {
					result = null;
				}
			}
		}
	}

	ctx.setMem(dest, result);
	return undefined;
}

export function registerHandlers(handlers: Handler[]) {
  handlers[Opcode.Add] = (ctx, inst) => {
    return binaryArithOp(ctx, inst.p1, inst.p2, inst.p3, (a, b) => a + b);
  };

  handlers[Opcode.Subtract] = (ctx, inst) => {
    return binaryArithOp(ctx, inst.p1, inst.p2, inst.p3, (a, b) => b - a);
  };

  handlers[Opcode.Multiply] = (ctx, inst) => {
    return binaryArithOp(ctx, inst.p1, inst.p2, inst.p3, (a, b) => a * b);
  };

  handlers[Opcode.Divide] = (ctx, inst) => {
    const divisor = ctx.getMem(inst.p1);
    const numerator = ctx.getMem(inst.p2);

    // Check for division by zero or null values
    if (divisor === 0 || divisor === 0n || divisor === null || numerator === null || Number(divisor) === 0) {
      ctx.setMem(inst.p3, null);
    } else {
      try {
        const result = Number(numerator) / Number(divisor);
        ctx.setMem(inst.p3, Number.isFinite(result) ? result : null);
      } catch {
        ctx.setMem(inst.p3, null);
      }
    }
    return undefined;
  };

  handlers[Opcode.Remainder] = (ctx, inst) => {
    const divisor = ctx.getMem(inst.p1);
    const numerator = ctx.getMem(inst.p2);
    let result = null;

    if (divisor !== null && numerator !== null) {
      try {
        if (typeof divisor === 'bigint' || typeof numerator === 'bigint') {
          const b1 = BigInt(divisor as any);
          const b2 = BigInt(numerator as any);

          // Explicit check for division by zero
          if (b1 === 0n) {
            throw new SqliteError("Division by zero", StatusCode.ERROR);
          }

          result = b2 % b1;
        } else {
          const n1 = Number(divisor);
          const n2 = Number(numerator);

          // Explicit checks for numeric validity
          if (n1 === 0 || !Number.isFinite(n1) || !Number.isFinite(n2)) {
            result = null;
          } else {
            result = n2 % n1;
          }
        }
      } catch (e) {
        if (e instanceof SqliteError) throw e;
        result = null;
      }
    }

    ctx.setMem(inst.p3, result);
    return undefined;
  };

  handlers[Opcode.Concat] = (ctx, inst) => {
    let result = '';
    for (let i = inst.p1; i <= inst.p2; i++) {
      const val = ctx.getMem(i);
      if (val !== null && !(val instanceof Uint8Array)) {
        result += String(val);
      }
    }
    ctx.setMem(inst.p3, result);
    return undefined;
  };

  handlers[Opcode.Negative] = (ctx, inst) => {
    const val = ctx.getMem(inst.p1);
    let result = null;

    if (val !== null) {
      try {
        result = typeof val === 'bigint' ? -val : -Number(val);
        if (typeof result === 'number' && !Number.isFinite(result)) {
          result = null;
        }
      } catch {
        result = null;
      }
    }

    ctx.setMem(inst.p2, result);
    return undefined;
  };
}
