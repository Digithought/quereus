import type { AnyVirtualTableModule, SchemaChangeInfo } from './module.js';
import type { Database } from '../core/database.js';
import type { TableSchema } from '../schema/table.js';
import type { MaybePromise, Row, SqlValue, CompareFn } from '../common/types.js';
import type { IndexSchema } from '../schema/table.js';
import type { FilterInfo } from './filter-info.js';
import type { RowOp } from '../common/types.js';
import type { ConflictResolution } from '../common/constants.js';
import type { VirtualTableConnection } from './connection.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { VTableEventEmitter } from './events.js';

/**
 * Arguments passed to VirtualTable.update() method.
 */
export interface UpdateArgs {
	/** The operation to perform (insert, update, delete) */
	operation: RowOp;
	/** For INSERT/UPDATE, the values to insert/update. For DELETE, undefined */
	values: Row | undefined;
	/** For UPDATE/DELETE, the old key values of the row to modify. Undefined for INSERT */
	oldKeyValues?: Row;
	/** Conflict resolution mode (defaults to ABORT if unspecified) */
	onConflict?: ConflictResolution;
	/** Optional: Deterministic SQL statement that reproduces this mutation (if logMutations is enabled) */
	mutationStatement?: string;
}

/**
 * Base class representing a virtual table instance.
 * Module implementations should subclass this to provide specific table behavior.
 */
export abstract class VirtualTable {
	public readonly module: AnyVirtualTableModule;
	public readonly db: Database;
	public readonly tableName: string;
	public readonly schemaName: string;
	public errorMessage?: string;
	public tableSchema?: TableSchema;

	/**
	 * When true, the update() method will receive a mutationStatement parameter
	 * containing a deterministic SQL statement that reproduces the mutation.
	 * This enables replication, audit logging, and change data capture.
	 */
	public wantStatements?: boolean;

	constructor(db: Database, module: AnyVirtualTableModule, schemaName: string, tableName: string) {
		this.db = db;
		this.module = module;
		this.schemaName = schemaName;
		this.tableName = tableName;
	}

	/**
	 * Sets an error message for the VTable
	 * @param message The error message string
	 */
	protected setErrorMessage(message: string | undefined): void {
		this.errorMessage = message;
	}

	/**
	 * Disconnects from this virtual table connection instance
	 * Called when the database connection closes or the statement is finalized
	 * @throws QuereusError on failure
	 */
	abstract disconnect(): Promise<void>;

	/**
	 * (Optional) Opens a direct data stream for this virtual table based on filter criteria.
	 * This is an alternative to the cursor-based open/filter/next model.
	 * @param filterInfo Information from getBestAccessPlan and query parameters.
	 * @returns An AsyncIterable yielding Row tuples.
	 * @throws QuereusError on failure
	 */
	query?(filterInfo: FilterInfo): AsyncIterable<Row>;

	/**
	 * Executes a pushed-down plan subtree.
	 * Called when the module indicated support via supports() method.
	 *
	 * @param db The database connection
	 * @param plan The plan node to execute
	 * @param ctx Optional context from supports() assessment
	 * @returns Async iterable of rows resulting from the plan execution
	 */
	executePlan?(
		db: Database,
		plan: PlanNode,
		ctx?: unknown
	): AsyncIterable<Row>;

	/**
	 * Performs an INSERT, UPDATE, or DELETE operation
	 * @param args Arguments object containing operation details and optional mutation statement
	 * @returns new row for INSERT/UPDATE, undefined for DELETE
	 * @throws QuereusError or ConstraintError on failure
	 */
	abstract update(args: UpdateArgs): Promise<Row | undefined>;

	/**
	 * (Optional) Creates a new connection for transaction support.
	 * If implemented, this enables proper transaction isolation for this table.
	 * @returns A new VirtualTableConnection instance
	 */
	createConnection?(): MaybePromise<VirtualTableConnection>;

	/**
	 * (Optional) Gets the current connection for this table instance.
	 * Used when the table maintains a single connection internally.
	 * @returns The current VirtualTableConnection instance, if any
	 */
	getConnection?(): VirtualTableConnection | undefined;

	/**
	 * Begins a transaction on this virtual table
	 */
	begin?(): Promise<void>;

	/**
	 * Syncs changes within the virtual table transaction
	 */
	sync?(): Promise<void>;

	/**
	 * Commits the virtual table transaction
	 */
	commit?(): Promise<void>;

	/**
	 * Rolls back the virtual table transaction
	 */
	rollback?(): Promise<void>;

	/**
	 * Renames the virtual table
	 * @param newName The new name for the table
	 */
	rename?(newName: string): Promise<void>;

	/**
	 * Begins a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	savepoint?(savepointIndex: number): Promise<void>;

	/**
	 * Releases a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	release?(savepointIndex: number): Promise<void>;

	/**
	 * Rolls back to a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	rollbackTo?(savepointIndex: number): Promise<void>;

	/**
	 * Modifies the schema of this virtual table
	 * @param changeInfo Object describing the schema modification
	 * @throws QuereusError or ConstraintError on failure
	 */
	alterSchema?(changeInfo: SchemaChangeInfo): Promise<void>;

	/**
	 * Creates a secondary index on the virtual table
	 * @param indexInfo The index definition
	 */
	createIndex?(indexInfo: IndexSchema): Promise<void>;

	/**
	 * Drops a secondary index from the virtual table
	 * @param indexName The name of the index to drop
	 */
	dropIndex?(indexName: string): Promise<void>;

	/**
	 * Gets the event emitter for this table, if the module supports mutation/schema events.
	 * @returns Event emitter, or undefined if not supported
	 */
	getEventEmitter?(): VTableEventEmitter | undefined;

	// --- Isolation Layer Support ---

	/**
	 * Extract primary key values from a row.
	 * Override in subclasses that support isolation layer wrapping.
	 */
	extractPrimaryKey?(row: Row): SqlValue[];

	/**
	 * Compare two rows by primary key.
	 * Override in subclasses that support isolation layer wrapping.
	 * @returns negative if a < b, 0 if equal, positive if a > b
	 */
	comparePrimaryKey?(a: SqlValue[], b: SqlValue[]): number;

	/**
	 * Get primary key column indices.
	 * Override in subclasses that support isolation layer wrapping.
	 */
	getPrimaryKeyIndices?(): number[];

	/**
	 * Get a comparator function for a specific index.
	 * Used when merging index scans from overlay and underlying tables.
	 * @param indexName The name of the index
	 * @returns Comparator function, or undefined if index doesn't exist
	 */
	getIndexComparator?(indexName: string): CompareFn | undefined;
}
