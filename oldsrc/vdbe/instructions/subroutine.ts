import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Handler } from '../handler-types.js';
import { Opcode } from '../opcodes.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('vdbe:subroutine');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

export function registerHandlers(handlers: Handler[]) {
	handlers[Opcode.FrameEnter] = (ctx, inst) => {
		const frameSize = inst.p1;
		const newFP = ctx.stackPointer - 1;
		const requiredStackTop = newFP + frameSize;

		// Save old FP
		ctx.setStack(newFP + 1, ctx.framePointer);

		// Initialize locals
		for (let i = 2; i < frameSize; i++) {
			ctx.setStack(newFP + i, null);
		}

		// Update frame pointers
		ctx.framePointer = newFP;
		ctx.stackPointer = requiredStackTop;
		return undefined;
	};
	handlers[Opcode.FrameLeave] = (ctx, inst) => {
		if (ctx.framePointer === 0 && ctx.getStack(1) === null) {
			warnLog("FrameLeave called on base frame? Potentially harmless if program ends.");
		} else {
			const oldFPVal = ctx.getStack(ctx.framePointer + 1);
			const oldFP = typeof oldFPVal === 'number' ? oldFPVal : -1;
			if (isNaN(oldFP) || oldFP < 0) {
				errorLog(`Invalid old frame pointer %s at FP %d + 1`, oldFPVal, ctx.framePointer);
				throw new QuereusError(`Invalid old frame pointer ${oldFPVal} at FP ${ctx.framePointer + 1}`, StatusCode.INTERNAL);
			}

			ctx.stackPointer = ctx.framePointer;
			ctx.framePointer = oldFP;
		}
		return undefined;
	};
	// --- Subroutine Calls ---
	handlers[Opcode.Subroutine] = (ctx, inst) => {
		const targetAddr = inst.p2;
		const returnAddr = ctx.pc + 1;

		ctx.setStack(ctx.stackPointer, returnAddr);
		ctx.pc = targetAddr;
		return undefined;
	};
	handlers[Opcode.Return] = (ctx, inst) => {
		// The return address is at current SP-1 (not at SP as the comment incorrectly states)
		const jumpTargetVal = ctx.getStack(ctx.stackPointer - 1);
		const jumpTarget = typeof jumpTargetVal === 'number' ? jumpTargetVal : -1;

		if (!Number.isInteger(jumpTarget) || jumpTarget < 0) {
			errorLog(`Invalid return address %s at SP %d (expected after FrameLeave)`, jumpTargetVal, ctx.stackPointer);
			throw new QuereusError(`Invalid return address ${jumpTargetVal} at SP ${ctx.stackPointer} (expected after FrameLeave)`, StatusCode.INTERNAL);
		}

		ctx.stackPointer++; // SP advances past the return address
		ctx.pc = jumpTarget;
		return undefined;
	};
	handlers[Opcode.Push] = (ctx, inst) => {
		const valueToPush = ctx.getStack(inst.p1);
		ctx.pushStack(valueToPush);
		return undefined;
	};
	handlers[Opcode.StackPop] = (ctx, inst) => {
		const count = inst.p1;
		if (count < 0) {
			throw new QuereusError("StackPop count cannot be negative", StatusCode.INTERNAL);
		}

		if (ctx.stackPointer < count) {
			errorLog(`Stack underflow during StackPop: SP=%d, Count=%d`, ctx.stackPointer, count);
			throw new QuereusError(`Stack underflow during StackPop: SP=${ctx.stackPointer}, Count=${count}`, StatusCode.INTERNAL);
		}

		ctx.stackPointer -= count;
		return undefined;
	};
}
