import type { ValuesNode } from '../../planner/nodes/values-node.js';
import type { SingleRowNode } from '../../planner/nodes/single-row.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue, type Row, StatusCode } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import type { EmissionContext } from '../emission-context.js';

export function emitSingleRow(plan: SingleRowNode, ctx: EmissionContext): Instruction {
	async function* run(ctx: RuntimeContext): AsyncIterable<Row> {
		yield []; // Yield one empty row
	}

	return {
		params: [],
		run,
		note: 'single_row'
	};
}

export function emitValues(plan: ValuesNode, ctx: EmissionContext): Instruction {
	const nCols = plan.getType().columns.length;

	async function* run(ctx: RuntimeContext, ...values: Array<SqlValue>): AsyncIterable<Row> {
		for (let i = 0; i < values.length; i += nCols) {
			const row = values.slice(i, i + nCols);
			yield row;
		}
	}

	// Flatten all rows into a single array of expressions
	const rowExprs = plan.rows.flatMap(row => {
		if (row.length !== nCols) {
			throw new QuereusError('All rows must have the same number of columns', StatusCode.SYNTAX, undefined, row[0]?.expression.loc?.start.line, row.at(-1)?.expression.loc?.start.column);
		}
		return row.map(expr => emitPlanNode(expr, ctx));
	});

	return {
		params: rowExprs,
		run: run as any,
		note: `values(${plan.rows.length} rows, ${plan.rows[0]?.length || 0} cols)`
	};
}
