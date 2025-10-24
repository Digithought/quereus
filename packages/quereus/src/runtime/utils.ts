/* eslint-disable @typescript-eslint/no-explicit-any */
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { TableSchema } from '../schema/table.js';
import type { VirtualTable } from '../vtab/table.js';
import type { RuntimeContext } from './types.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import { createLogger } from '../common/logger.js';
import type { MemoryVirtualTableConnection } from '../vtab/memory/connection.js';
import type { MemoryTable } from '../vtab/memory/table.js';
import type { RowDescriptor, Attribute } from '../planner/nodes/plan-node.js';

const log = createLogger('runtime:utils');
const errorLog = log.extend('error');
export const ctxLog = createLogger('runtime:context');

export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
	return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

export async function asyncIterableToArray<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterable) {
		result.push(item);
	}
	return result;
}

/**
 * Helper to get or create a VirtualTable connection for a given table.
 * This ensures transaction consistency by reusing connections within the same context.
 */
export async function getVTableConnection(ctx: RuntimeContext, tableSchema: TableSchema): Promise<VirtualTableConnection> {
	const tableName = tableSchema.name; // Use just the table name, not fully qualified

	// Check if we already have an active connection for this table
	const existingConnections = ctx.db.getConnectionsForTable(tableName);
	if (existingConnections.length > 0) {
		log(`Reusing existing connection for table ${tableName}`);
		return existingConnections[0];
	}

	// Create a new VirtualTable instance
	const vtab = await getVTable(ctx, tableSchema);

	// Try to create a connection if the table supports it
	let connection: VirtualTableConnection;
	if (vtab.createConnection) {
		connection = await vtab.createConnection();
		log(`Created new connection ${connection.connectionId} for table ${tableName}`);
	} else if (vtab.getConnection) {
		const existingConn = vtab.getConnection();
		if (existingConn) {
			connection = existingConn;
			log(`Using existing internal connection ${connection.connectionId} for table ${tableName}`);
		} else {
			throw new QuereusError(`Table '${tableName}' does not support connections`, StatusCode.INTERNAL);
		}
	} else {
		throw new QuereusError(`Table '${tableName}' does not support connections`, StatusCode.INTERNAL);
	}

	// Register the connection with the database
	await ctx.db.registerConnection(connection);

	// Set as the active connection in the runtime context if none is set
	if (!ctx.activeConnection) {
		ctx.activeConnection = connection;
	}

	return connection;
}

/**
 * Helper to get the VirtualTable instance for a given TableReferenceNode.
 * This is the legacy method that creates ephemeral instances.
 * When reusing connections, this will also inject the existing connection into the VirtualTable.
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
	if (typeof module.connect !== 'function') {
		throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' does not implement connect`, StatusCode.MISUSE);
	}
	const vtabArgs = tableSchema.vtabArgs || {};
	const vtabInstance = module.connect(ctx.db, moduleInfo.auxData, tableSchema.vtabModuleName, tableSchema.schemaName, tableSchema.name, vtabArgs);

	// If we have an active connection for this table, inject it into the VirtualTable
	const tableName = tableSchema.name;
	const existingConnections = ctx.db.getConnectionsForTable(tableName);
	if (existingConnections.length > 0 && tableSchema.vtabModuleName === 'memory') {
		const memoryConnection = existingConnections[0] as MemoryVirtualTableConnection;
		const memoryTable = vtabInstance as MemoryTable;
		if (memoryConnection.getMemoryConnection && memoryTable.setConnection) {
			memoryTable.setConnection(memoryConnection.getMemoryConnection());
			log(`Injected existing connection into VirtualTable for table ${tableName}`);
		}
	}

	return vtabInstance;
}

/**
 * Helper to properly disconnect and unregister a VirtualTable instance.
 */
export async function disconnectVTable(ctx: RuntimeContext, vtab: VirtualTable): Promise<void> {
	// Disconnect the VirtualTable instance
	if (typeof vtab.disconnect === 'function') {
		await vtab.disconnect().catch((e: any) => {
			errorLog(`Error during disconnect for table '${vtab.tableName}': ${e}`);
		});
	}
}

/**
 * Helper function to log context push operations
 */
export function logContextPush(descriptor: RowDescriptor, note: string, attributes?: readonly Attribute[]) {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	const attrNames = attributes ? attributes.map(attr => `${attr.name}(#${attr.id})`).join(',') : 'unknown';
	ctxLog('PUSH context %s: attrs=[%s] names=[%s]', note, attrs.join(','), attrNames);
}

/**
 * Helper function to log context pop operations
 */
export function logContextPop(descriptor: RowDescriptor, note: string) {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('POP context %s: attrs=[%s]', note, attrs.join(','));
}
