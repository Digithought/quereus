import type { MemoryTable } from './table.js';
import type { MemoryTableConnection } from './layer/connection.js';

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
		console.error(`MemoryTable ${self.tableName}: Error during xBeginLogic: ${e.message}`);
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
		console.error(`MemoryTable ${self.tableName}: Error during xCommitLogic: ${e.message}`);
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
		console.error(`MemoryTable ${self.tableName}: Error during xRollbackLogic: ${e.message}`);
		throw e; // Re-throw
	}
	// Rollback itself is typically synchronous in its effect on the connection state
	return Promise.resolve();
}

export function createSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	try {
		const conn = ensureConnectionOrThrow(self, `SAVEPOINT ${savepointIndex}`);
		if (conn.pendingTransactionLayer === null) { // Check pending layer
			console.warn(`MemoryTable ${self.tableName}: SAVEPOINT called outside of a transaction.`);
			// Or potentially throw new Error("SAVEPOINT outside transaction"); depending on desired strictness
			return;
		}
		conn.createSavepoint(savepointIndex); // Delegate to connection
		console.log(`MemoryTable ${self.tableName}: Created savepoint at index ${savepointIndex}`);
	} catch (e: any) {
		console.error(`MemoryTable ${self.tableName}: Error during createSavepointLogic for index ${savepointIndex}: ${e.message}`);
		throw e; // Re-throw
	}
}

export function releaseSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	try {
		const conn = (self as any).connection as MemoryTableConnection | null;
		if (conn && conn.pendingTransactionLayer !== null) { // Only release if in a transaction
			conn.releaseSavepoint(savepointIndex); // Delegate to connection
			console.log(`MemoryTable ${self.tableName}: Released savepoints from index ${savepointIndex}`);
		}
	} catch (e: any) {
		console.error(`MemoryTable ${self.tableName}: Error during releaseSavepointLogic for index ${savepointIndex}: ${e.message}`);
		throw e; // Re-throw
	}
}

export function rollbackToSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	try {
		const conn = (self as any).connection as MemoryTableConnection | null;
		if (conn && conn.pendingTransactionLayer !== null) { // Only rollback if in a transaction
			conn.rollbackToSavepoint(savepointIndex); // Delegate to connection
			console.log(`MemoryTable ${self.tableName}: Rolled back to savepoint index ${savepointIndex}`);
		}
	} catch (e: any) {
		console.error(`MemoryTable ${self.tableName}: Error during rollbackToSavepointLogic for index ${savepointIndex}: ${e.message}`);
		throw e; // Re-throw
	}
}
