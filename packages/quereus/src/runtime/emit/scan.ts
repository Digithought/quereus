import { StatusCode, type Row } from "../../common/types.js";
import type { TableScanNode } from "../../planner/nodes/scan.js";
import { QuereusError } from "../../common/errors.js";
import type { VirtualTable } from "../../vtab/table.js";
import type { BaseModuleConfig } from "../../vtab/module.js";
import type { Instruction, RuntimeContext } from "../types.js";
import type { EmissionContext } from "../emission-context.js";
import { createValidatedInstruction } from "../emitters.js";
import { getVTableConnection, disconnectVTable } from "../utils.js";
import { buildRowDescriptor } from "../../util/row-descriptor.js";

export function emitSeqScan(plan: TableScanNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.source.tableSchema;

	// Create row descriptor mapping attribute IDs to column indices
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Look up the virtual table module during emission and record the dependency
	const moduleInfo = ctx.getVtabModule(tableSchema.vtabModuleName);
	if (!moduleInfo) {
		throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' not found`, StatusCode.ERROR);
	}

	// Capture the module info key for runtime retrieval
	const moduleKey = `vtab_module:${tableSchema.vtabModuleName}`;

	async function* run(runtimeCtx: RuntimeContext): AsyncIterable<Row> {
		// Get or create a connection for this table
		const connection = await getVTableConnection(runtimeCtx, tableSchema);

		// Use the captured module info instead of doing a fresh lookup
		const capturedModuleInfo = ctx.getCapturedSchemaObject<{ module: any, auxData?: unknown }>(moduleKey);
		if (!capturedModuleInfo) {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' was not captured during emission`, StatusCode.INTERNAL);
		}

		const module = capturedModuleInfo.module;
		if (typeof module.xConnect !== 'function') {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' does not implement xConnect`, StatusCode.MISUSE);
		}

		let vtabInstance: VirtualTable;
		try {
			const options: BaseModuleConfig = {}; // TODO: Populate options from plan.source.tableSchema.vtabArgs or similar if needed
			vtabInstance = module.xConnect(
				runtimeCtx.db,
				capturedModuleInfo.auxData,
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
			// Put cursor row into context using row descriptor
			let row: Row;
			runtimeCtx.context.set(rowDescriptor, () => row);

			const asyncRowIterable = vtabInstance.xQuery(plan.filterInfo);
			for await (row of asyncRowIterable) {
				yield row;
			}

			// Remove cursor row from context
			runtimeCtx.context.delete(rowDescriptor);
		} catch (e: any) {
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Error during xQuery on table '${tableSchema.name}': ${message}`, e instanceof QuereusError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		} finally {
			// Properly disconnect the VirtualTable instance
			await disconnectVTable(runtimeCtx, vtabInstance);
		}
	}

	return createValidatedInstruction(
		[],
		run,
		ctx,
		`scan(${plan.source.tableSchema.name})`
	);
}
