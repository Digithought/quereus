import { QuereusError } from '../common/errors';
import { StatusCode } from '../common/types';
import type { TableSchema } from '../schema/table';
import type { VirtualTable } from '../vtab/table';
import type { RuntimeContext } from './types';
import type { TableReferenceNode } from "../planner/nodes/reference.js";

export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
	return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Helper to get the VirtualTable instance for a given TableReferenceNode.
 */
export async function getVTable(ctx: RuntimeContext, tableSchema: TableSchema): VirtualTable {
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
	return module.xConnect(ctx.db, moduleInfo.auxData, tableSchema.vtabModuleName, tableSchema.schemaName, tableSchema.name, vtabArgs);
}
