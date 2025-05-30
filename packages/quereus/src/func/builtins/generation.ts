import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { SqlDataType } from "../../common/types.js";
import { createTableValuedFunction } from "../registration.js";

// Generate a sequence of numbers (table-valued function)
export const generateSeriesFunc = createTableValuedFunction(
	{
		name: 'generate_series',
		numArgs: 2,
		deterministic: true,
		columns: [
			{ name: 'value', type: SqlDataType.INTEGER, nullable: false }
		]
	},
	async function* (start: SqlValue, end: SqlValue): AsyncIterable<Row> {
		const startNum = Number(start);
		const endNum = Number(end);

		if (isNaN(startNum) || isNaN(endNum)) return;

		for (let i = startNum; i <= endNum; i++) {
			yield [i];
		}
	}
);

