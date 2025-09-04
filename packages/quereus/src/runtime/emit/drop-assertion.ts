import type { DropAssertionNode } from '../../planner/nodes/drop-assertion-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:drop-assertion');

export function emitDropAssertion(plan: DropAssertionNode, _ctx: EmissionContext): Instruction {

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getMainSchema(); // Look in main schema for now

		const existing = schema.getAssertion(plan.name);
		if (!existing) {
			if (plan.ifExists) {
				log('Assertion %s not found, but IF EXISTS specified', plan.name);
				return null;
			}
			throw new QuereusError(
				`Assertion ${plan.name} not found`,
				StatusCode.NOTFOUND
			);
		}

		const removed = schema.removeAssertion(plan.name);
		if (!removed && !plan.ifExists) {
			throw new QuereusError(
				`Failed to remove assertion ${plan.name}`,
				StatusCode.INTERNAL
			);
		}

		log('Dropped assertion %s', plan.name);
		return null;
	}

	return {
		params: [],
		run: run as InstructionRun,
		note: `dropAssertion(${plan.name})`
	};
}
