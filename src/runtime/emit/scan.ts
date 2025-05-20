import { StatusCode, type Row } from "../../common/types.js";
import type { TableScanNode } from "../../planner/nodes/scan.js";
import { QuereusError } from "../../common/errors.js";
import type { VirtualTable } from "../../vtab/table.js";
import type { BaseModuleConfig } from "../../vtab/module.js";
import type { Instruction, RuntimeContext } from "../types.js";

export function emitTableScan(plan: TableScanNode): Instruction {

	async function* run(ctx: RuntimeContext): AsyncIterable<Row> {
		const tableSchema = plan.source.tableSchema;
		const moduleInfo = ctx.db._getVtabModule(tableSchema.vtabModuleName);
		if (!moduleInfo) {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' not found`, StatusCode.ERROR);
		}
		const module = moduleInfo.module;
		if (typeof module.xConnect !== 'function') {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' does not implement xConnect`, StatusCode.MISUSE);
		}

		let vtabInstance: VirtualTable;
		try {
			const options: BaseModuleConfig = {}; // TODO: Populate options from plan.source.tableSchema.vtabArgs or similar if needed
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
			throw new QuereusError(`Module '${tableSchema.vtabModuleName}' xConnect failed for table '${tableSchema.name}': ${message}`, e instanceof QuereusError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		}

		if (typeof vtabInstance.xQuery !== 'function') {
			// Fallback or error if xQuery is not available. For now, throwing an error.
			// Later, we could implement the xOpen/xFilter/xNext loop here as a fallback.
			throw new QuereusError(`Virtual table '${tableSchema.name}' does not support xQuery.`, StatusCode.UNSUPPORTED);
		}

		try {
			// Put cursor row into context
			let row: Row;
			ctx.context.set(plan, () => row);

			const asyncRowIterable = vtabInstance.xQuery(plan.filterInfo);
			for await (const [_rowid, fetched] of asyncRowIterable) {
				row = fetched;
				yield row;
			}

			// Remove cursor row from context
			ctx.context.delete(plan);
		} catch (e: any) {
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Error during xQuery on table '${tableSchema.name}': ${message}`, e instanceof QuereusError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		} finally {
			// Ensure xDisconnect is called if the vtabInstance was successfully created.
			if (vtabInstance && typeof vtabInstance.xDisconnect === 'function') {
				await vtabInstance.xDisconnect().catch(disconnectError => {
					// Log disconnect error, but don't let it hide the original query error if one occurred.
					console.error(`Error during xDisconnect for table '${tableSchema.name}': ${disconnectError}`);
				});
			}
		}
	}

	return { params: [], run };
}
