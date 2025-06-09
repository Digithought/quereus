import type { TableReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import type { Row } from '../../common/types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { getVTable, disconnectVTable } from '../utils.js';
import { createValidatedInstruction } from '../emitters.js';
import type { FilterInfo } from '../../vtab/filter-info.js';
import type { IndexInfo, IndexConstraintUsage } from '../../vtab/index-info.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export function emitTableReference(plan: TableReferenceNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for output attributes
	const rowDescriptor: RowDescriptor = [];
	const attributes = plan.getAttributes();
	attributes.forEach((attr, index) => {
		rowDescriptor[attr.id] = index;
	});

	async function* run(rctx: RuntimeContext): AsyncIterable<Row> {
		// Get the table schema
		const tableSchema = plan.tableSchema;

		// Get virtual table implementation
		const vtab = await getVTable(rctx, tableSchema);

		try {
			// Set up context for each row using row descriptor
			let row: Row;
			rctx.context.set(rowDescriptor, () => row);

			// Check if the virtual table supports xQuery
			if (typeof vtab.xQuery === 'function') {
				// Create a minimal FilterInfo for full table scan
				const defaultIndexInfo: IndexInfo = {
					nConstraint: 0,
					aConstraint: [],
					nOrderBy: 0,
					aOrderBy: [],
					aConstraintUsage: [] as IndexConstraintUsage[],
					idxNum: 0,
					idxStr: 'fullscan',
					orderByConsumed: false,
					estimatedCost: 1000,
					estimatedRows: BigInt(100),
					idxFlags: 0,
					colUsed: 0n,
				};

				const filterInfo: FilterInfo = {
					idxNum: 0,
					idxStr: 'fullscan',
					constraints: [],
					args: [],
					indexInfoOutput: defaultIndexInfo,
				};

				// Use xQuery with the filter info
				const asyncRowIterable = vtab.xQuery(filterInfo);
				for await (row of asyncRowIterable) {
					yield row;
				}
			} else {
				throw new QuereusError(`Virtual table '${tableSchema.name}' does not support xQuery.`, StatusCode.UNSUPPORTED);
			}

			// Clean up context
			rctx.context.delete(rowDescriptor);
		} finally {
			// Properly disconnect the VirtualTable instance
			await disconnectVTable(rctx, vtab);
		}
	}

	return createValidatedInstruction(
		[],
		run,
		ctx,
		`table_ref(${plan.tableSchema.schemaName}.${plan.tableSchema.name})`
	);
}
