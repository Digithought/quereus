/**
 * Generic interface for VirtualTable connections that support transactions.
 * This allows different vtab modules to implement their own connection strategies
 * while providing a consistent interface for transaction operations.
 */
export interface VirtualTableConnection {
	/** Unique identifier for this connection */
	readonly connectionId: string;

	/** Name of the table this connection is associated with */
	readonly tableName: string;

	// Transaction methods
	/** Begins a transaction on this connection */
	begin(): void | Promise<void>;

	/** Commits the current transaction */
	commit(): void | Promise<void>;

	/** Rolls back the current transaction */
	rollback(): void | Promise<void>;

	/** Creates a savepoint with the given index */
	createSavepoint(index: number): void | Promise<void>;

	/** Releases a savepoint with the given index */
	releaseSavepoint(index: number): void | Promise<void>;

	/** Rolls back to a savepoint with the given index */
	rollbackToSavepoint(index: number): void | Promise<void>;

	/** Disconnects and cleans up this connection */
	disconnect(): void | Promise<void>;
}
