import { SqliteError } from '../../common/errors';
import { StatusCode } from '../../common/types';
import type { Handler } from '../handler-types';
import { Opcode } from '../opcodes';

export function registerHandlers(handlers: Handler[]) {
	// --- Result Row ---
	handlers[Opcode.ResultRow] = (ctx, inst) => {
		const startOffset = inst.p1;
		const count = inst.p2;

		const startIdx = ctx.framePointer + startOffset;
		if (startIdx < 0 || startIdx + count > ctx.stackPointer) {
			throw new SqliteError(
				`ResultRow stack access out of bounds: FP=${ctx.framePointer} ` +
				`Offset=${startOffset} Count=${count} SP=${ctx.stackPointer}`,
				StatusCode.INTERNAL
			);
		}

		// This requires access to the statement object through ctx
		// We'll rely on the executor to handle this in the run method
		ctx.hasYielded = true;
		return StatusCode.ROW;
	};
	// --- Cursor Management (Async) ---
	handlers[Opcode.OpenRead] = async (ctx, inst) => {
		const cIdx = inst.p1;
		const schema = inst.p4;

		if (!schema?.vtabInstance?.module?.xOpen) {
			throw new SqliteError("Missing vtab instance or module.xOpen for OpenRead", StatusCode.INTERNAL);
		}

		const v = schema.vtabInstance;
		const ci = await v.module.xOpen(v);

		const cursor = ctx.getCursor(cIdx);
		if (cursor) {
			cursor.instance = ci;
			cursor.vtab = v;
			cursor.sortedResults = null;
		}
		return undefined;
	};
	handlers[Opcode.OpenWrite] = handlers[Opcode.OpenRead];
	handlers[Opcode.Close] = async (ctx, inst) => {
		const cIdx = inst.p1;
		const cursor = ctx.getCursor(cIdx);

		if (cursor) {
			if (cursor.sortedResults) {
				cursor.sortedResults = null;
			}

			if (cursor.instance) {
				await cursor.instance.close();
			}

			cursor.instance = null;
			cursor.vtab = null;
		}
		return undefined;
	};
}