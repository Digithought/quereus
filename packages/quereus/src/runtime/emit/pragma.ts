import type { EmissionContext } from '../emission-context.js';
import type { PragmaPlanNode } from '../../planner/nodes/pragma.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { Row, SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

const log = createLogger('runtime:emit:pragma');

export function emitPragma(plan: PragmaPlanNode, ctx: EmissionContext): Instruction {
	const run = async function* (rctx: RuntimeContext): AsyncIterable<Row> {
		const pragmaName = plan.pragmaName;
		const value = plan.value;



		if (value !== undefined) {
			// Writing mode: set the pragma value
			log(`PRAGMA ${pragmaName} = ${value}`);

			// Try to set as a database option first
			try {
				rctx.db.setOption(pragmaName, value);
				log(`Set option ${pragmaName} = ${value}`);
			} catch (error) {
				// Treat unknown pragmas as no-ops for now, like SQLite often does
				log(`Ignoring unrecognized PRAGMA: ${pragmaName}`);
			}
		} else {
			// Reading mode: get the pragma value
			log(`PRAGMA ${pragmaName} (reading)`);

			try {
				const currentValue = rctx.db.getOption(pragmaName);
				log(`Read option ${pragmaName} = ${currentValue}`);
				// Return as a single-row result with the pragma name as column
				yield [pragmaName, currentValue];
			} catch (error) {
				// If the pragma is unknown, return null or throw error depending on behavior needed
				log(`Unknown PRAGMA: ${pragmaName}`);
				throw new QuereusError(
					`Unknown pragma: ${pragmaName}`,
					StatusCode.ERROR,
					error instanceof Error ? error : undefined
				);
			}
		}
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `PRAGMA ${plan.pragmaName}${plan.value !== undefined ? ` = ${plan.value}` : ''}`
	};
}
