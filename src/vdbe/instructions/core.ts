import { ConstraintError, SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { evaluateIsTrue } from '../../util/comparison.js';
import type { Handler } from '../handler-types.js';
import { Opcode } from '../opcodes.js';

export function registerHandlers(handlers: Handler[]) {
	// --- Control Flow ---
	handlers[Opcode.Init] = (ctx, inst) => {
		ctx.pc = inst.p2;
		return undefined;
	};
	handlers[Opcode.Goto] = (ctx, inst) => {
		ctx.pc = inst.p2;
		return undefined;
	};
	handlers[Opcode.Halt] = (ctx, inst) => {
		ctx.done = true;
		if (inst.p1 !== StatusCode.OK) {
			ctx.error = new SqliteError(inst.p4 ?? `Execution halted with code ${inst.p1}`, inst.p1);
		}
		return inst.p1;
	};
	handlers[Opcode.Noop] = (_ctx, _inst) => {
		// Do nothing
		return undefined;
	};
	// --- Register Operations ---
	handlers[Opcode.Integer] = (ctx, inst) => {
		ctx.setMem(inst.p2, inst.p1);
		return undefined;
	};
	handlers[Opcode.Int64] = (ctx, inst) => {
		ctx.setMem(inst.p2, ctx.getConstant(inst.p4));
		return undefined;
	};
	handlers[Opcode.String8] = (ctx, inst) => {
		ctx.setMem(inst.p2, ctx.getConstant(inst.p4));
		return undefined;
	};
	handlers[Opcode.Null] = (ctx, inst) => {
		ctx.setMem(inst.p2, null);
		return undefined;
	};
	handlers[Opcode.Real] = (ctx, inst) => {
		ctx.setMem(inst.p2, ctx.getConstant(inst.p4));
		return undefined;
	};
	handlers[Opcode.Blob] = (ctx, inst) => {
		ctx.setMem(inst.p2, ctx.getConstant(inst.p4));
		return undefined;
	};
	handlers[Opcode.ZeroBlob] = (ctx, inst) => {
		const size = Number(ctx.getMem(inst.p1));
		ctx.setMem(inst.p2, new Uint8Array(size >= 0 ? Math.trunc(size) : 0));
		return undefined;
	};
	handlers[Opcode.SCopy] = (ctx, inst) => {
		ctx.setMem(inst.p2, ctx.getMem(inst.p1));
		return undefined;
	};
	// --- Conditional Jumps ---
	handlers[Opcode.IfTrue] = (ctx, inst) => {
		const condition = evaluateIsTrue(ctx.getMem(inst.p1));
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IfFalse] = (ctx, inst) => {
		const condition = !evaluateIsTrue(ctx.getMem(inst.p1));
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IfZero] = (ctx, inst) => {
		const val = ctx.getMem(inst.p1);
		const condition = val === 0 || val === 0n || val === null;
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IfNull] = (ctx, inst) => {
		const condition = ctx.getMem(inst.p1) === null;
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IfNotNull] = (ctx, inst) => {
		const condition = ctx.getMem(inst.p1) !== null;
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IsNull] = (ctx, inst) => {
		ctx.setMem(inst.p2, ctx.getMem(inst.p1) === null);
		return undefined;
	};
	handlers[Opcode.NotNull] = (ctx, inst) => {
		ctx.setMem(inst.p2, ctx.getMem(inst.p1) !== null);
		return undefined;
	};
	// --- Move with boundary checking ---
	handlers[Opcode.Move] = (ctx, inst) => {
		const srcOffset = inst.p1;
		const destOffset = inst.p2;
		const count = inst.p3;

		const srcBaseIdx = ctx.framePointer + srcOffset;
		const destBaseIdx = ctx.framePointer + destOffset;

		// Bounds check for read only
		const maxSrcReadIndex = srcBaseIdx + count -1;

		if (srcBaseIdx < 0 || destBaseIdx < 0 || maxSrcReadIndex >= ctx.stackPointer) {
			// Check if source read goes out of bounds relative to current SP
			throw new SqliteError(
				`Move opcode stack READ access out of bounds: FP=${ctx.framePointer} ` +
				`SrcOff=${srcOffset} Count=${count} SP=${ctx.stackPointer}`,
				StatusCode.INTERNAL
			);
		}
		// Destination write bounds are implicitly handled by setStackValue extending SP if needed.
		// We rely on the compiler having allocated enough *total* cells (numMemCells).

		if (srcBaseIdx === destBaseIdx) {
			return undefined; // Nothing to do
		}

		// Handle potential overlapping regions correctly
		if (destBaseIdx > srcBaseIdx && destBaseIdx < srcBaseIdx + count) {
			// Copy from end to avoid overwriting source data
			for (let i = count - 1; i >= 0; i--) {
				ctx.setStackValue(destBaseIdx + i, ctx.getStackValue(srcBaseIdx + i));
			}
		} else {
			// Normal copy
			for (let i = 0; i < count; i++) {
				ctx.setStackValue(destBaseIdx + i, ctx.getStackValue(srcBaseIdx + i));
			}
		}
		return undefined;
	};
	// --- Other common opcodes ---
	handlers[Opcode.Clear] = (ctx, inst) => {
		const startOffset = inst.p1;
		const count = inst.p2;

		if (startOffset < 2) { // Assuming 2 is localsStartOffset
			throw new SqliteError(`Clear opcode attempt to clear control/arg area: Offset=${startOffset}`, StatusCode.INTERNAL);
		}

		const clearStartIdx = ctx.framePointer + startOffset;
		const clearEndIdx = clearStartIdx + count;

		if (clearStartIdx < 0 || clearEndIdx > ctx.stackPointer) {
			throw new SqliteError(
				`Clear opcode stack access out of bounds: FP=${ctx.framePointer} ` +
				`Offset=${startOffset} Count=${count} SP=${ctx.stackPointer}`,
				StatusCode.INTERNAL
			);
		}

		for (let i = clearStartIdx; i < clearEndIdx; i++) {
			ctx.setStackValue(i, null);
		}
		return undefined;
	};
	// --- Constraints ---
	handlers[Opcode.ConstraintViolation] = (ctx, inst) => {
		const context = (typeof inst.p4 === 'string' && inst.p4) ? inst.p4 : 'Constraint failed';
		throw new ConstraintError(context);
	};
}