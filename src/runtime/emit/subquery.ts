import type { SqlValue } from "../../common/types.js";
import type { InNode } from "../../planner/nodes/subquery.js";
import { emitPlanNode } from "../emitters.js";
import type { RuntimeContext } from "../types.js";

export function emitIn(plan: InNode) {
	async function run(ctx: RuntimeContext, condition: SqlValue, input: AsyncIterable<SqlValue[]>): Promise<SqlValue> {
		for await (const row of input) {
			if (plan.comparator(row[0], condition) === 0) {
				return true;
			}
		}
		return false;
	}

	return { params: [ emitPlanNode(plan.condition), emitPlanNode(plan.source) ], run };
}
