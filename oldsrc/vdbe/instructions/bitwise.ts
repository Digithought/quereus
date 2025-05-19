import type { Handler } from '../handler-types.js';
import { Opcode } from '../opcodes.js';

export function registerHandlers(handlers: Handler[]) {
	handlers[Opcode.BitAnd] = (ctx, inst) => {
		const v1 = ctx.getStack(inst.p1);
		const v2 = ctx.getStack(inst.p2);
		let result = null;

		try {
			if (v1 !== null && v2 !== null) {
				const i1 = BigInt(v1 as any);
				const i2 = BigInt(v2 as any);
				result = i1 & i2;
			}
		} catch {
			result = 0n;
		}

		ctx.setStack(inst.p3, result);
		return undefined;
	};
	handlers[Opcode.BitOr] = (ctx, inst) => {
		const v1 = ctx.getStack(inst.p1);
		const v2 = ctx.getStack(inst.p2);
		let result = null;

		try {
			if (v1 !== null && v2 !== null) {
				const i1 = BigInt(v1 as any);
				const i2 = BigInt(v2 as any);
				result = i1 | i2;
			}
		} catch {
			result = 0n;
		}

		ctx.setStack(inst.p3, result);
		return undefined;
	};
	handlers[Opcode.ShiftLeft] = (ctx, inst) => {
		const amount = ctx.getStack(inst.p1);
		const value = ctx.getStack(inst.p2);
		let result = null;

		try {
			if (amount !== null && value !== null) {
				const iAmount = BigInt(amount as any);
				const iValue = BigInt(value as any);
				result = iValue << iAmount;
			}
		} catch {
			result = 0n;
		}

		ctx.setStack(inst.p3, result);
		return undefined;
	};
	handlers[Opcode.ShiftRight] = (ctx, inst) => {
		const amount = ctx.getStack(inst.p1);
		const value = ctx.getStack(inst.p2);
		let result = null;

		try {
			if (amount !== null && value !== null) {
				const iAmount = BigInt(amount as any);
				const iValue = BigInt(value as any);
				result = iValue >> iAmount;
			}
		} catch {
			result = 0n;
		}

		ctx.setStack(inst.p3, result);
		return undefined;
	};
	handlers[Opcode.BitNot] = (ctx, inst) => {
		const val = ctx.getStack(inst.p1);
		let result = null;

		try {
			if (val !== null) {
				result = ~BigInt(val as any);
			}
		} catch {
			result = -1n;
		}

		ctx.setStack(inst.p2, result);
		return undefined;
	};
}
