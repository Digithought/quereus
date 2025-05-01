import { compareSqlValues } from '../../util/comparison.js';
import type { VmCtx, Status, Handler } from '../handler-types.js';
import type { P4Coll } from '../instruction.js';
import { Opcode } from '../opcodes.js';

// --- Comparisons ---
function handleComparison(ctx: VmCtx, inst: any, compareOp: (result: number) => boolean): Status {
	const v1 = ctx.getMem(inst.p1);
	const v2 = ctx.getMem(inst.p3);
	const jumpTarget = inst.p2;
	const p4Coll = inst.p4 as P4Coll | null;
	const collationName = p4Coll?.type === 'coll' ? p4Coll.name : 'BINARY';
	const comparisonResult = compareSqlValues(v1, v2, collationName);
	const conditionMet = compareOp(comparisonResult);
	ctx.pc = conditionMet ? jumpTarget : ctx.pc + 1;
	return undefined;
}

// Helper for standard SQL boolean comparison (NULLs are false)
function handleSqlBooleanComparison(ctx: VmCtx, inst: any, compareOp: (result: number) => boolean): Status {
	const v1 = ctx.getMem(inst.p1);
	const v2 = ctx.getMem(inst.p3);
	const jumpTarget = inst.p2;
	const p4Coll = inst.p4 as P4Coll | null;
	const collationName = p4Coll?.type === 'coll' ? p4Coll.name : 'BINARY';

	let conditionMet = false;
	if (v1 !== null && v2 !== null) {
		const comparisonResult = compareSqlValues(v1, v2, collationName);
		conditionMet = compareOp(comparisonResult);
	}

	ctx.pc = conditionMet ? jumpTarget : ctx.pc + 1;
	return undefined;
}

export function registerHandlers(handlers: Handler[]) {
	handlers[Opcode.Eq] = (ctx, inst) => {
		return handleSqlBooleanComparison(ctx, inst, result => result === 0);
	};
	handlers[Opcode.Ne] = (ctx, inst) => {
		// Ne jumps if result != 0 OR if either operand is NULL.
		// compareSqlValues handles non-null cases. We need the NULL check.
		const v1 = ctx.getMem(inst.p1);
		const v2 = ctx.getMem(inst.p3);
		if (v1 === null || v2 === null) {
			ctx.pc = inst.p2; // Jump if NULL
			return undefined;
		}
		return handleComparison(ctx, inst, result => result !== 0); // Original logic for non-NULL
	};
	handlers[Opcode.Lt] = (ctx, inst) => {
		return handleSqlBooleanComparison(ctx, inst, result => result < 0);
	};
	handlers[Opcode.Le] = (ctx, inst) => {
		return handleSqlBooleanComparison(ctx, inst, result => result <= 0);
	};
	handlers[Opcode.Gt] = (ctx, inst) => {
		return handleSqlBooleanComparison(ctx, inst, result => result > 0);
	};
	handlers[Opcode.Ge] = (ctx, inst) => {
		return handleSqlBooleanComparison(ctx, inst, result => result >= 0);
	};
}
