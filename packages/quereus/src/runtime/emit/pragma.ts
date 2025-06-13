import type { EmissionContext } from '../emission-context.js';
import type { PragmaPlanNode } from '../../planner/nodes/pragma.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

const log = createLogger('runtime:emit:pragma');



export function emitPragma(plan: PragmaPlanNode, ctx: EmissionContext): Instruction {
	const run = async (rctx: RuntimeContext): Promise<SqlValue | undefined> => {
		const pragmaName = plan.pragmaName;
		const value = plan.value;

		log(`PRAGMA ${pragmaName} = ${value}`);

		// Try to set as a database option first
		try {
			rctx.db.setOption(pragmaName, value);
			log(`Set option ${pragmaName} = ${value}`);
		} catch (error) {
			// Treat unknown pragmas as no-ops for now, like SQLite often does
			log(`Ignoring unrecognized PRAGMA: ${pragmaName}`);
		}

		return null;
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `PRAGMA ${plan.pragmaName}${plan.value !== undefined ? ` = ${plan.value}` : ''}`
	};
}
