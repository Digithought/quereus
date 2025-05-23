import type { ValuesNode } from '../../planner/nodes/values-node.js';
import type { SingleRowNode } from '../../planner/nodes/single-row.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';

export function emitValues(plan: ValuesNode | SingleRowNode): Instruction {
	// Handle SingleRowNode case (zero columns, one row)
	if ('instance' in plan.constructor) {
		// This is SingleRowNode.instance
		async function* runSingleRow(ctx: RuntimeContext): AsyncIterable<Row> {
			yield []; // Yield one empty row
		}
		return { params: [], run: runSingleRow };
	}

	// Handle regular ValuesNode case
	const valuesNode = plan as ValuesNode;

	// Emit all the scalar expressions in the rows
	const rowInstructions = valuesNode.rows.map(row =>
		row.map(expr => emitPlanNode(expr))
	);

	async function* run(ctx: RuntimeContext, ...allValues: SqlValue[]): AsyncIterable<Row> {
		// The scheduler flattens all instructions, so we need to reconstruct the row structure
		let valueIndex = 0;
		for (let rowIndex = 0; rowIndex < valuesNode.rows.length; rowIndex++) {
			const row: Row = [];
			for (let colIndex = 0; colIndex < valuesNode.rows[rowIndex].length; colIndex++) {
				row.push(allValues[valueIndex++]);
			}
			yield row;
		}
	}

	// Flatten all row instructions into a single params array
	const allInstructions = rowInstructions.flat();
	return { params: allInstructions, run: run as any };
}
