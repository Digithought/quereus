import type { MemoryTable } from './table.js';
import type { MemoryTableConnection } from './layer/connection.js';
import { createLogger } from '../../common/logger.js'; // Import logger

const log = createLogger('vtab:memory:table-trx'); // Create logger
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log; // Use base log for debug level

// Helper to ensure connection exists, throws if not for operations requiring it
function ensureConnectionOrThrow(self: MemoryTable, operation: string): MemoryTableConnection {
	const conn = (self as any).ensureConnection(); // Use internal method to get/create connection
	if (!conn) {
		throw new Error(`MemoryTable ${self.tableName}: Cannot ${operation} without an active connection.`);
	}
	return conn;
}

export function xBeginLogic(self: MemoryTable): Promise<void> {
	try {
		// ensureConnection() handles initializing the connection state if needed
		const conn = ensureConnectionOrThrow(self, 'BEGIN');
		conn.begin(); // Delegate to connection's begin method
	} catch (e: any) {
		// Use namespaced error logger
		errorLog(`Error during xBeginLogic for table %s: %s`, self.tableName, e.message);
		throw e; // Re-throw
	}
	return Promise.resolve();
}

export async function xCommitLogic(self: MemoryTable): Promise<void> {
	try {
		// Commit only makes sense if a connection exists and is in a transaction
		const conn = (self as any).connection as MemoryTableConnection | null; // Type assertion
		if (conn && conn.pendingTransactionLayer !== null) { // Check pending layer
			await conn.commit(); // Delegate commit processing entirely to the connection
		} else {
			// Commit without begin/connection is a no-op
		}
	} catch (e: any) {
		// Use namespaced error logger
		errorLog(`Error during xCommitLogic for table %s: %s`, self.tableName, e.message);
		throw e; // Re-throw
	}
}

export async function xRollbackLogic(self: MemoryTable): Promise<void> {
	try {
		// Rollback only makes sense if a connection exists and is in a transaction
		const conn = (self as any).connection as MemoryTableConnection | null; // Type assertion
		if (conn && conn.pendingTransactionLayer !== null) { // Check pending layer
			conn.rollback(); // Delegate rollback processing entirely to the connection
		} else {
			// Rollback without begin/connection is a no-op
		}
	} catch (e: any) {
		// Use namespaced error logger
		errorLog(`Error during xRollbackLogic for table %s: %s`, self.tableName, e.message);
		throw e; // Re-throw
	}
	// Rollback itself is typically synchronous in its effect on the connection state
	return Promise.resolve();
}

export function createSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	try {
		const conn = ensureConnectionOrThrow(self, `SAVEPOINT ${savepointIndex}`);
		if (conn.pendingTransactionLayer === null) { // Check pending layer
			// Use namespaced warn logger
			warnLog(`SAVEPOINT called outside of a transaction for table %s.`, self.tableName);
			// Or potentially throw new Error("SAVEPOINT outside transaction"); depending on desired strictness
			return;
		}
		conn.createSavepoint(savepointIndex); // Delegate to connection
		// Use namespaced debug logger
		debugLog(`Created savepoint at index %d for table %s`, savepointIndex, self.tableName);
	} catch (e: any) {
		// Use namespaced error logger
		errorLog(`Error during createSavepointLogic for table %s, index %d: %s`, self.tableName, savepointIndex, e.message);
		throw e; // Re-throw
	}
}

export function releaseSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	try {
		const conn = (self as any).connection as MemoryTableConnection | null;
		if (conn && conn.pendingTransactionLayer !== null) { // Only release if in a transaction
			conn.releaseSavepoint(savepointIndex); // Delegate to connection
			// Use namespaced debug logger
			debugLog(`Released savepoints from index %d for table %s`, savepointIndex, self.tableName);
		}
	} catch (e: any) {
		// Use namespaced error logger
		errorLog(`Error during releaseSavepointLogic for table %s, index %d: %s`, self.tableName, savepointIndex, e.message);
		throw e; // Re-throw
	}
}

export function rollbackToSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	try {
		const conn = (self as any).connection as MemoryTableConnection | null;
		if (conn && conn.pendingTransactionLayer !== null) { // Only rollback if in a transaction
			conn.rollbackToSavepoint(savepointIndex); // Delegate to connection
			// Use namespaced debug logger
			debugLog(`Rolled back to savepoint index %d for table %s`, savepointIndex, self.tableName);
		}
	} catch (e: any) {
		// Use namespaced error logger
		errorLog(`Error during rollbackToSavepointLogic for table %s, index %d: %s`, self.tableName, savepointIndex, e.message);
		throw e; // Re-throw
	}
}
