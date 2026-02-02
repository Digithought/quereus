/**
 * Internal database interfaces for extension packages.
 *
 * These interfaces expose internal methods needed by packages that tightly
 * integrate with Quereus's transaction management (e.g., quereus-isolation,
 * quereus-store). They are not part of the public API and may change.
 *
 * @internal
 */

import type { VirtualTableConnection } from '../vtab/connection.js';

/**
 * Internal database methods for virtual table connection management.
 *
 * Extension packages that implement custom virtual tables with transaction
 * support need access to these methods to properly coordinate with the
 * database's transaction lifecycle.
 *
 * @example
 * ```typescript
 * import type { Database, DatabaseInternal } from '@quereus/quereus';
 *
 * class MyTable extends VirtualTable {
 *   private async ensureConnection(): Promise<void> {
 *     const connection = new MyConnection(this.tableName);
 *     const dbInternal = this.db as DatabaseInternal;
 *     await dbInternal.registerConnection(connection);
 *   }
 * }
 * ```
 *
 * @internal
 */
export interface DatabaseInternal {
	/**
	 * Registers an active VirtualTable connection for transaction management.
	 *
	 * When registered, the connection will:
	 * - Receive `begin()` calls if a transaction is already active
	 * - Participate in `commit()` and `rollback()` operations
	 * - Be tracked for the lifetime of the transaction
	 *
	 * @param connection The connection to register
	 */
	registerConnection(connection: VirtualTableConnection): Promise<void>;

	/**
	 * Unregisters an active VirtualTable connection.
	 *
	 * Call this when the connection is no longer needed (e.g., on disconnect).
	 * Note: During implicit transactions, unregistration may be deferred until
	 * the transaction completes.
	 *
	 * @param connectionId The ID of the connection to unregister
	 */
	unregisterConnection(connectionId: string): void;

	/**
	 * Gets an active connection by ID.
	 *
	 * @param connectionId The connection ID to look up
	 * @returns The connection if found, undefined otherwise
	 */
	getConnection(connectionId: string): VirtualTableConnection | undefined;

	/**
	 * Gets all active connections for a specific table.
	 *
	 * Useful for checking if a connection already exists before creating a new one,
	 * enabling connection reuse within a transaction.
	 *
	 * @param tableName The name of the table (with or without schema prefix)
	 * @returns Array of connections for the table
	 */
	getConnectionsForTable(tableName: string): VirtualTableConnection[];

	/**
	 * Gets all active connections.
	 *
	 * @returns Array of all active connections
	 */
	getAllConnections(): VirtualTableConnection[];
}
