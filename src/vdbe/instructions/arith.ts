import { SqliteError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Handler } from "../handler-types.js";
import type { Status, VmCtx } from "../handler-types.js";
import { Opcode } from "../opcodes.js";

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
    const leftVal = ctx.getMem(inst.p1);
    const rightVal = ctx.getMem(inst.p2);

    // Check for division by zero or null values
    if (rightVal === 0 || rightVal === 0n || rightVal === null || leftVal === null || Number(rightVal) === 0) {
      ctx.setMem(inst.p3, null);
    } else {
      try {
        const result = Number(leftVal) / Number(rightVal);
        ctx.setMem(inst.p3, Number.isFinite(result) ? result : null);
      } catch {
        ctx.setMem(inst.p3, null);
      }
    }
    return undefined;
  };

  handlers[Opcode.Remainder] = (ctx, inst) => {
    const val1 = ctx.getMem(inst.p1);
    const val2 = ctx.getMem(inst.p2);
    let result = null;

    if (val1 !== null && val2 !== null) {
      try {
        if (typeof val1 === 'bigint' || typeof val2 === 'bigint') {
          const b1 = BigInt(val1 as any);
          const b2 = BigInt(val2 as any);

          if (b2 === 0n) {
            result = null;
          } else {
            result = b1 % b2;
          }
        } else {
          const n1 = Number(val1);
          const n2 = Number(val2);

          if (n2 === 0 || !Number.isFinite(n1) || !Number.isFinite(n2)) {
            result = null;
          } else {
            result = n1 % n2;
          }
        }
      } catch (e) {
        result = null;
      }
    }

    ctx.setMem(inst.p3, result);
    return undefined;
  };

  handlers[Opcode.Concat] = (ctx, inst) => {
    const reg1Offset = inst.p1;
    const reg2Offset = inst.p2;
    const destOffset = inst.p3;

    const val1 = ctx.getMem(reg1Offset);
    const val2 = ctx.getMem(reg2Offset);

    let s1 = '';
    if (val1 !== null && !(val1 instanceof Uint8Array)) {
        s1 = String(val1);
    }
    let s2 = '';
    if (val2 !== null && !(val2 instanceof Uint8Array)) {
        s2 = String(val2);
    }

    ctx.setMem(destOffset, s1 + s2);
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
