import { SqliteError } from '../../common/errors';
import { StatusCode, type SqlValue } from '../../common/types';
import { applyNumericAffinity, applyIntegerAffinity, applyRealAffinity, applyTextAffinity, applyBlobAffinity } from '../../util/affinity';
import type { Handler } from '../handler-types';
import { Opcode } from '../opcodes';

export function registerHandlers(handlers: Handler[]) {
	// --- Type Affinity/Conversion ---
	handlers[Opcode.Affinity] = (ctx, inst) => {
		const startOffset = inst.p1;
		const count = inst.p2;
		const affinityStr = (inst.p4 as string).toUpperCase();

		// Validate bounds
		if (startOffset < 2) { // Assuming 2 is the minimum valid offset
			throw new SqliteError(`Affinity opcode attempt on control/arg area: Offset=${startOffset}`, StatusCode.INTERNAL);
		}

		let applyAffinityFn: (v: SqlValue) => SqlValue;
		switch (affinityStr) {
			case 'NUMERIC': applyAffinityFn = applyNumericAffinity; break;
			case 'INTEGER': applyAffinityFn = applyIntegerAffinity; break;
			case 'REAL': applyAffinityFn = applyRealAffinity; break;
			case 'TEXT': applyAffinityFn = applyTextAffinity; break;
			case 'BLOB': applyAffinityFn = applyBlobAffinity; break;
			default: applyAffinityFn = (v: SqlValue) => v;
		}

		for (let i = 0; i < count; i++) {
			const offset = startOffset + i;
			const currentValue = ctx.getMem(offset);
			const newValue = applyAffinityFn(currentValue);
			if (newValue !== currentValue) {
				ctx.setMem(offset, newValue);
			}
		}
		return undefined;
	};
}