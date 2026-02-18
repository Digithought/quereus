import type { JoinNode } from '../../planner/nodes/join-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row, OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { compareSqlValues } from '../../util/comparison.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import type { Attribute } from '../../planner/nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

const log = createLogger('runtime:emit:join');

/**
 * Emits a nested loop join instruction.
 * This is a simple nested loop implementation for inner/left/cross joins.
 */
export function emitLoopJoin(plan: JoinNode, ctx: EmissionContext): Instruction {
	// Create row descriptors for left and right inputs
	const leftAttributes = plan.left.getAttributes();
	const leftRowDescriptor = buildRowDescriptor(leftAttributes);

	const rightAttributes = plan.right.getAttributes();
	const rightRowDescriptor = buildRowDescriptor(rightAttributes);

	// NOTE: rightSource must be re-startable (optimizer facilitates through cache node)
	async function* run(rctx: RuntimeContext, leftSource: AsyncIterable<Row>, rightCallback: (ctx: RuntimeContext) => AsyncIterable<Row>, conditionCallback?: (ctx: RuntimeContext) => OutputValue): AsyncIterable<Row> {
		const joinType = plan.joinType;

		log('Starting %s join between %d left attrs and %d right attrs',
			joinType.toUpperCase(), leftAttributes.length, rightAttributes.length);

		if (joinType === 'right' || joinType === 'full') {
			throw new QuereusError(
				`${joinType.toUpperCase()} JOIN is not supported yet`,
				StatusCode.UNSUPPORTED
			);
		}

		// Create row slots for efficient context management
		const leftSlot = createRowSlot(rctx, leftRowDescriptor);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor);

		try {
			// Process left side and join with right (pure streaming)
			for await (const leftRow of leftSource) {
				// Set up left context
				leftSlot.set(leftRow);

				let leftMatched = false;

				// Stream through right side for each left row
				for await (const rightRow of rightCallback(rctx)) {
					// Set up right context
					rightSlot.set(rightRow);

					// Evaluate join condition
					let conditionMet = true;

					if (conditionCallback) {
						// Evaluate the join condition using the callback provided by scheduler
						const conditionResult = await conditionCallback(rctx);
						conditionMet = !!conditionResult; // Convert to boolean
					} else if (plan.usingColumns) {
						// Handle USING condition: check equality of specified columns
						conditionMet = evaluateUsingCondition(leftRow, rightRow, plan.usingColumns, leftAttributes, rightAttributes);
					} else if (joinType === 'cross') {
						// Cross join - always true
						conditionMet = true;
					}

					if (conditionMet) {
						leftMatched = true;
						yield [...leftRow, ...rightRow] as Row;
					}
				}

				// Handle outer join semantics - null padding for unmatched left rows
				if (!leftMatched && joinType === 'left') {
					// Create null-padded row for left outer join
					const nullPadding = new Array(rightAttributes.length).fill(null) as Row;
					// Update the right slot so downstream resolveAttribute sees
					// nulls instead of stale data from a previous inner iteration.
					rightSlot.set(nullPadding);
					const outputRow = [...leftRow, ...nullPadding] as Row;
					yield outputRow;
				}
			}

		} finally {
			leftSlot.close();
			rightSlot.close();
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitCallFromPlan(plan.right, ctx);

	// Build the params array - include condition callback if present
	const params = [leftInstruction, rightInstruction];
	if (plan.condition) {
		const conditionInstruction = emitCallFromPlan(plan.condition, ctx);
		params.push(conditionInstruction);
	}

	return {
		params,
		run: run as InstructionRun,
		note: `${plan.joinType} join (nested loop)`
	};
}

/**
 * Evaluates USING condition by comparing specified columns from left and right rows
 */
function evaluateUsingCondition(
	leftRow: Row,
	rightRow: Row,
	usingColumns: readonly string[],
	leftAttributes: readonly Attribute[],
	rightAttributes: readonly Attribute[]
): boolean {
	for (const columnName of usingColumns) {
		const leftColName = columnName.toLowerCase();
		const rightColName = columnName.toLowerCase();

		// Find column indices in left and right
		const leftIndex = leftAttributes.findIndex(attr => attr.name.toLowerCase() === leftColName);
		const rightIndex = rightAttributes.findIndex(attr => attr.name.toLowerCase() === rightColName);

		if (leftIndex === -1 || rightIndex === -1) {
			// Column not found - should not happen if planner is correct
			return false;
		}

		const leftValue = leftRow[leftIndex];
		const rightValue = rightRow[rightIndex];

		// Compare using SQL semantics
		if (compareSqlValues(leftValue, rightValue) !== 0) {
			return false;
		}
	}

	return true; // All USING columns match
}
