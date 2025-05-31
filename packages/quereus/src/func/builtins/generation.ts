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
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: true,
			columns: [
				{
					name: 'value',
					type: {
						typeClass: 'scalar',
						affinity: SqlDataType.INTEGER,
						nullable: false,
						isReadOnly: true
					},
					generated: true
				}
			],
			keys: [[{ index: 0 }]],
			rowConstraints: []
		}
	},
	async function* (start: SqlValue, end: SqlValue): AsyncIterable<Row> {
		const startNum = Number(start);
		const endNum = Number(end);

		if (isNaN(startNum) || isNaN(endNum)) return;

		for (let i = startNum; i <= endNum; ++i) {
			yield [i];
		}
	}
);

