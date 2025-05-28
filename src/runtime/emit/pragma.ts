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

		switch (pragmaName) {
			case 'default_vtab_module':
				if (typeof value === 'string') {
					rctx.db.setDefaultVtabName(value);
					log(`Set default vtab module to: ${value}`);
				} else {
					throw new QuereusError(`PRAGMA default_vtab_module requires a string value.`, StatusCode.ERROR);
				}
				break;

			case 'default_vtab_args':
				if (value === null) {
					// Clear the args
					rctx.db.setDefaultVtabArgs({});
					log(`Cleared default vtab args`);
				} else if (typeof value === 'string') {
					try {
						const args = JSON.parse(value);
						rctx.db.setDefaultVtabArgs(args);
						log(`Set default vtab args to: ${value}`);
					} catch (e) {
						throw new QuereusError(`PRAGMA default_vtab_args requires valid JSON string.`, StatusCode.ERROR);
					}
				} else {
					throw new QuereusError(`PRAGMA default_vtab_args requires a JSON string or NULL.`, StatusCode.ERROR);
				}
				break;

			default:
				// Treat unknown pragmas as no-ops for now, like SQLite often does
				log(`Ignoring unrecognized PRAGMA: ${pragmaName}`);
				break;
		}

		return null;
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `PRAGMA ${plan.pragmaName}${plan.value !== undefined ? ` = ${plan.value}` : ''}`
	};
}
