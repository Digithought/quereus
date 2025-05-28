import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { TableSchema } from '../schema/table.js';
import type { VirtualTable } from '../vtab/table.js';
import type { RuntimeContext } from './types.js';
import type { TableReferenceNode } from "../planner/nodes/reference.js";
import { registerActiveVTab, unregisterActiveVTab } from './emit/transaction.js';

export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
	return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Helper to get the VirtualTable instance for a given TableReferenceNode.
 */
export async function getVTable(ctx: RuntimeContext, tableSchema: TableSchema): Promise<VirtualTable> {
	// All tables are virtual, so vtabModuleName should always be present.
	if (!tableSchema.vtabModuleName) {
		throw new QuereusError(`Table schema for '${tableSchema.name}' is missing vtabModuleName.`, StatusCode.INTERNAL);
	}
	const moduleInfo = ctx.db._getVtabModule(tableSchema.vtabModuleName);
	if (!moduleInfo) {
		throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' not found for table '${tableSchema.name}'`, StatusCode.ERROR);
	}
	const module = moduleInfo.module;
	if (typeof module.xConnect !== 'function') {
		throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' does not implement xConnect`, StatusCode.MISUSE);
	}
	const vtabArgs = tableSchema.vtabArgs || {};
	const vtabInstance = module.xConnect(ctx.db, moduleInfo.auxData, tableSchema.vtabModuleName, tableSchema.schemaName, tableSchema.name, vtabArgs);

	// Register the VirtualTable instance for transaction operations
	registerActiveVTab(ctx, vtabInstance);

	return vtabInstance;
}

/**
 * Helper to properly disconnect and unregister a VirtualTable instance.
 */
export async function disconnectVTable(ctx: RuntimeContext, vtab: VirtualTable): Promise<void> {
	// Unregister the VirtualTable instance from transaction operations
	unregisterActiveVTab(ctx, vtab);

	// Disconnect the VirtualTable instance
	if (typeof vtab.xDisconnect === 'function') {
		await vtab.xDisconnect().catch((e: any) => {
			console.error(`Error during xDisconnect for table '${vtab.tableName}': ${e}`);
		});
	}
}
