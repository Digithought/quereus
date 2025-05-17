import { StatusCode, type Row } from "../../common/types.js";
import type { TableScanNode } from "../../planner/nodes/scan.js";
import { SqliterError } from "../../common/errors.js";
import type { VirtualTable } from "../../vtab/table.js";
import type { BaseModuleConfig } from "../../vtab/module.js";
import type { Instruction, RuntimeContext } from "../types.js";

export function emitTableScan(plan: TableScanNode): Instruction {

	async function *run(ctx: RuntimeContext): AsyncIterable<Row> {
		const tableSchema = plan.source.tableSchema;
		const moduleInfo = ctx.db._getVtabModule(tableSchema.vtabModuleName);
		if (!moduleInfo) {
			throw new SqliterError(`Virtual table module '${tableSchema.vtabModuleName}' not found`, StatusCode.ERROR);
		}
		const module = moduleInfo.module;
		if (typeof module.xConnect !== 'function') {
			throw new SqliterError(`Virtual table module '${tableSchema.vtabModuleName}' does not implement xConnect`, StatusCode.MISUSE);
		}

		let vtabInstance: VirtualTable;
		try {
			const options: BaseModuleConfig = {};
			vtabInstance = module.xConnect(
				ctx.db,
				moduleInfo.auxData,
				tableSchema.vtabModuleName,
				tableSchema.schemaName,
				tableSchema.name,
				options
			);
		} catch (e: any) {
			const message = e instanceof Error ? e.message : String(e);
			throw new SqliterError(`Module '${tableSchema.vtabModuleName}' xConnect failed for table '${tableSchema.name}': ${message}`, e instanceof SqliterError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		}

		// TODO: separately converting vtable interface to use async iterable.  Then we can enable the following code.

		// const cursor = await vtabInstance.xFilter(plan.idxNum, plan.idxStr, [], [], plan.indexInfo);
		// let row: Row;
		// ctx.context.set(plan, () => row);
		// for (row of cursor) {
		// 	yield row;
		// }
		// ctx.context.delete(plan);

		throw new SqliterError("Not implemented", StatusCode.UNSUPPORTED);
	}

	return { params: [], run };
}
