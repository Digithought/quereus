import { ConstraintError, SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { evaluateIsTrue } from '../../util/comparison.js';
import type { Handler } from '../handler-types.js';
import { Opcode } from '../opcodes.js';
import { getCollation } from '../../util/comparison.js';

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
	handlers[Opcode.Noop] = () => {
		// Do nothing
		return undefined;
	};
	// --- Register Operations ---
	handlers[Opcode.Integer] = (ctx, inst) => {
		ctx.setStack(inst.p2, inst.p1);
		return undefined;
	};
	handlers[Opcode.Int64] = (ctx, inst) => {
		ctx.setStack(inst.p2, ctx.getConstant(inst.p4));
		return undefined;
	};
	handlers[Opcode.String8] = (ctx, inst) => {
		ctx.setStack(inst.p2, ctx.getConstant(inst.p4));
		return undefined;
	};
	handlers[Opcode.Null] = (ctx, inst) => {
		ctx.setStack(inst.p2, null);
		return undefined;
	};
	handlers[Opcode.Real] = (ctx, inst) => {
		ctx.setStack(inst.p2, ctx.getConstant(inst.p4));
		return undefined;
	};
	handlers[Opcode.Blob] = (ctx, inst) => {
		ctx.setStack(inst.p2, ctx.getConstant(inst.p4));
		return undefined;
	};
	handlers[Opcode.ZeroBlob] = (ctx, inst) => {
		const size = Number(ctx.getStack(inst.p1));
		ctx.setStack(inst.p2, new Uint8Array(size >= 0 ? Math.trunc(size) : 0));
		return undefined;
	};
	handlers[Opcode.SCopy] = (ctx, inst) => {
		ctx.setStack(inst.p2, ctx.getStack(inst.p1));
		return undefined;
	};
	// --- Conditional Jumps ---
	handlers[Opcode.IfTrue] = (ctx, inst) => {
		const condition = evaluateIsTrue(ctx.getStack(inst.p1));
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IfFalse] = (ctx, inst) => {
		const condition = !evaluateIsTrue(ctx.getStack(inst.p1));
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IfZero] = (ctx, inst) => {
		const val = ctx.getStack(inst.p1);
		const condition = val === 0 || val === 0n || val === null;
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IfNull] = (ctx, inst) => {
		const condition = ctx.getStack(inst.p1) === null;
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IfNotNull] = (ctx, inst) => {
		const condition = ctx.getStack(inst.p1) !== null;
		ctx.pc = condition ? inst.p2 : ctx.pc + 1;
		return undefined;
	};
	handlers[Opcode.IsNull] = (ctx, inst) => {
		ctx.setStack(inst.p2, ctx.getStack(inst.p1) === null ? 1 : 0);
		return undefined;
	};
	handlers[Opcode.NotNull] = (ctx, inst) => {
		ctx.setStack(inst.p2, ctx.getStack(inst.p1) !== null ? 1 : 0);
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
				ctx.setStack(destBaseIdx + i, ctx.getStack(srcBaseIdx + i));
			}
		} else {
			// Normal copy
			for (let i = 0; i < count; i++) {
				ctx.setStack(destBaseIdx + i, ctx.getStack(srcBaseIdx + i));
			}
		}
		return undefined;
	};
	// --- Other common opcodes ---
	handlers[Opcode.Clear] = (ctx, inst) => {
		const startReg = inst.p1; // P1 is the starting absolute register index
		const count = inst.p2;

		// Bounds check for the range of absolute registers to clear
		if (startReg < 0 || count < 0 ) { // count cannot be negative
			throw new SqliteError(
				`Clear opcode invalid arguments: StartReg=${startReg} Count=${count}`,
				StatusCode.INTERNAL
			);
		}

		const endReg = startReg + count; // Exclusive end

		// Ensure stack is large enough; setStackValue will extend if necessary
		// but good to have a conceptual check against numMemCells if available, though tricky.

		for (let i = startReg; i < endReg; i++) {
			ctx.setStack(i, null);
		}
		return undefined;
	};
	// --- Constraints ---
	handlers[Opcode.ConstraintViolation] = (ctx, inst) => {
		const context = (typeof inst.p4 === 'string' && inst.p4) ? inst.p4 : 'Constraint failed';
		throw new ConstraintError(context);
	};

	// --- Once ---
	handlers[Opcode.Once] = (ctx, inst) => {
		const programCounter = ctx.pc; // PC of the Once instruction itself
		if (ctx.stmt.didOnceExecute(programCounter)) {
			// Already executed, jump
			ctx.pc = inst.p2;
		} else {
			// First time, mark as executed and continue to next instruction
			ctx.stmt.markOnceAsExecuted(programCounter);
			ctx.pc++;
		}
		return undefined;
	};

	// --- Collation Sequence ---
	handlers[Opcode.CollSeq] = (ctx, inst) => {
		const destReg = inst.p2; // P2 is technically the target register
		const collName = inst.p4 as string;
		const collFunc = getCollation(collName);
		// The main purpose is to ensure the collation is loaded.
		// Standard SQLite doesn't store anything useful in P2 for CollSeq.
		// We'll store the resolved name if found, otherwise NULL.
		ctx.setStack(destReg, collFunc ? collName : null);
		return undefined;
	};
}
