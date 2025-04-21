// src/vtab/memory-table.ts
import { VirtualTable } from './table';
import { VirtualTableCursor } from './cursor';
import type { VirtualTableModule } from './module';
import type { IndexInfo, IndexConstraint, IndexOrderBy } from './indexInfo';
import { IndexConstraintOp } from '../common/constants';
import type { Database } from '../core/database';
import { type SqlValue, StatusCode, SqlDataType } from '../common/types';
import { SqliteError, ConstraintError } from '../common/errors';
import type { SqliteContext } from '../func/context';
import { Latches } from '../util/latches';
import { Parser } from '../parser/parser';
import type { ColumnSchema } from '../schema/column';
import { buildColumnIndexMap, type TableSchema, findPrimaryKeyColumns } from '../schema/table';
import * as AST from '../parser/ast';
// --- Import digitree and comparison ---
import { BTree, KeyBound, KeyRange, Path } from 'digitree'; // KeyBound, KeyRange added
import { compareSqlValues } from '../util/comparison';
// ------------------------------------

// Type for rows stored internally, always including the SQLite rowid
export type MemoryTableRow = Record<string, SqlValue> & { _rowid_: bigint };
// Type alias for the BTree key (can be rowid, single PK value, or array for composite PK)
type BTreeKey = bigint | number | string | SqlValue[];

// --- Transaction Buffer Types ---
type PendingChange =
	| { type: 'INSERT', row: MemoryTableRow, key: BTreeKey }
	| { type: 'UPDATE', rowid: bigint, oldRow: MemoryTableRow, newRow: MemoryTableRow, oldKey: BTreeKey, newKey: BTreeKey }
	| { type: 'DELETE', rowid: bigint, oldRow: MemoryTableRow, oldKey: BTreeKey };
// ------------------------------

/**
 * Cursor for the MemoryTable using BTree paths and iterators.
 * Now needs to handle transaction buffers via a merged result set.
 */
class MemoryTableCursor extends VirtualTableCursor<MemoryTable> {
	// Remove BTree specific state, now uses merged results
	// private currentPath: Path<BTreeKey, MemoryTableRow> | null = null;
	// private iterator: IterableIterator<Path<BTreeKey, MemoryTableRow>> | null = null;

	// State for iterating over merged results prepared by xFilter
	private mergedResults: MemoryTableRow[] = [];
	private currentIndex: number = -1;
	private isEof: boolean = true;

	constructor(table: MemoryTable) {
		super(table);
	}

	reset(): void {
		this.mergedResults = [];
		this.currentIndex = -1;
		this.isEof = true;
	}

	getCurrentRow(): MemoryTableRow | null {
		if (this.isEof || this.currentIndex < 0 || this.currentIndex >= this.mergedResults.length) {
			return null;
		}
		return this.mergedResults[this.currentIndex];
	}

	getCurrentRowId(): bigint | null {
		const row = this.getCurrentRow();
		return row?._rowid_ ?? null;
	}

	/** Called by xFilter to set the results to iterate over */
	setResults(results: MemoryTableRow[]): void {
		this.mergedResults = results;
		this.currentIndex = -1;
		this.isEof = this.mergedResults.length === 0;
		if (!this.isEof) {
			this.advance(); // Move to the first valid row
		}
	}

	advance(): void {
		if (this.currentIndex >= this.mergedResults.length - 1) {
			this.isEof = true;
			this.currentIndex = this.mergedResults.length; // Position after the end
		} else {
			this.currentIndex++;
			this.isEof = false;
		}
	}

	eof(): boolean {
		return this.isEof;
	}
}

/**
 * An in-memory table implementation using digitree B+Tree.
 * Can be keyed by rowid (default) or declared PRIMARY KEY column(s).
 */
export class MemoryTable extends VirtualTable {
	public columns: { name: string, type: SqlDataType }[] = [];
	public primaryKeyColumnIndices: ReadonlyArray<number> = [];
	private keyFromEntry: (entry: MemoryTableRow) => BTreeKey = (row) => row._rowid_;
	public compareKeys: (a: BTreeKey, b: BTreeKey) => number = compareSqlValues as any;
	public data: BTree<BTreeKey, MemoryTableRow> | null = null;
	private nextRowid: bigint = BigInt(1);
	private readOnly: boolean;
	public rowidToKeyMap: Map<bigint, BTreeKey> | null = null;

	// --- Transaction State --- (Public for cursor access for now)
	public inTransaction: boolean = false;
	public pendingInserts: Map<BTreeKey, MemoryTableRow> | null = null; // Keyed by BTree key
	public pendingUpdates: Map<bigint, { oldRow: MemoryTableRow, newRow: MemoryTableRow, oldKey: BTreeKey, newKey: BTreeKey }> | null = null; // Keyed by rowid
	public pendingDeletes: Map<bigint, { oldRow: MemoryTableRow, oldKey: BTreeKey }> | null = null; // Keyed by rowid
	// --- Savepoint Buffer State ---
	private savepoints: {
		inserts: Map<BTreeKey, MemoryTableRow>;
		updates: Map<bigint, { oldRow: MemoryTableRow, newRow: MemoryTableRow, oldKey: BTreeKey, newKey: BTreeKey }>;
		deletes: Map<bigint, { oldRow: MemoryTableRow, oldKey: BTreeKey }>;
	}[] = [];
	// --------------------------

	constructor(
		db: Database,
		module: VirtualTableModule<any, any>,
		schemaName: string,
		tableName: string,
		readOnly: boolean = false
	) {
		super(db, module, schemaName, tableName);
		this.readOnly = readOnly;
	}

	setColumns(columns: { name: string, type: SqlDataType }[], pkIndices: ReadonlyArray<number>): void {
		this.columns = [...columns];
		this.primaryKeyColumnIndices = pkIndices;

		if (pkIndices.length === 0) {
			console.log(`MemoryTable '${this.tableName}': Using rowid as BTree key.`);
			this.primaryKeyColumnIndices = [];
			this.keyFromEntry = (row) => row._rowid_;
			this.compareKeys = compareSqlValues as any;
			this.rowidToKeyMap = null;
		} else if (pkIndices.length === 1) {
			const pkIndex = pkIndices[0];
			const pkColName = this.columns[pkIndex]?.name;
			if (!pkColName) {
				console.error(`MemoryTable '${this.tableName}': Invalid primary key index ${pkIndex}. Falling back to rowid key.`);
				this.primaryKeyColumnIndices = [];
				this.keyFromEntry = (row) => row._rowid_;
				this.compareKeys = compareSqlValues as any;
				this.rowidToKeyMap = null;
			} else {
				console.log(`MemoryTable '${this.tableName}': Using PRIMARY KEY column '${pkColName}' (index ${pkIndex}) as BTree key.`);
				this.keyFromEntry = (row) => row[pkColName] as BTreeKey;
				this.compareKeys = compareSqlValues as any;
				this.rowidToKeyMap = new Map();
			}
		} else {
			const pkColNames = pkIndices.map(idx => this.columns[idx]?.name).filter(name => !!name);
			if (pkColNames.length !== pkIndices.length) {
				console.error(`MemoryTable '${this.tableName}': Invalid composite primary key indices. Falling back to rowid key.`);
				this.primaryKeyColumnIndices = [];
				this.keyFromEntry = (row) => row._rowid_;
				this.compareKeys = compareSqlValues as any;
				this.rowidToKeyMap = null;
			} else {
				console.log(`MemoryTable '${this.tableName}': Using Composite PRIMARY KEY (${pkColNames.join(', ')}) as BTree key.`);
				this.keyFromEntry = (row) => pkColNames.map(name => row[name]);
				this.compareKeys = this.compareCompositeKeys;
				this.rowidToKeyMap = new Map();
			}
		}

		this.data = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);
	}

	private compareCompositeKeys(a: BTreeKey, b: BTreeKey): number {
		const arrA = a as SqlValue[];
		const arrB = b as SqlValue[];
		const len = Math.min(arrA.length, arrB.length);
		for (let i = 0; i < len; i++) {
			const cmp = compareSqlValues(arrA[i], arrB[i]);
			if (cmp !== 0) return cmp;
		}
		return arrA.length - arrB.length;
	}

	getRowByBTreeKey(key: BTreeKey): MemoryTableRow | null {
		// TODO: Check pending buffers
		if (!this.data) return null;
		const path = this.data.find(key);
		return path.on ? this.data.at(path) ?? null : null;
	}

	findPathByRowid(rowid: bigint): Path<BTreeKey, MemoryTableRow> | null {
		// TODO: Check pending buffers (especially if rowid maps to an updated key)
		if (!this.data) return null;
		if (this.primaryKeyColumnIndices.length === 0) {
			const path = this.data.find(rowid);
			return path.on ? path : null;
		} else if (this.rowidToKeyMap) {
			const key = this.rowidToKeyMap.get(rowid);
			if (key === undefined) return null;
			const path = this.data.find(key);
			return (path.on && this.data.at(path)?._rowid_ === rowid) ? path : null;
		} else {
			console.error("MemoryTable internal error: Missing rowidToKeyMap for PK table.");
			return null;
		}
	}

	addRow(row: Record<string, SqlValue>): bigint {
		if (!this.data) throw new Error("MemoryTable BTree not initialized.");

		const rowid = this.nextRowid++;
		const rowWithId: MemoryTableRow = { ...row, _rowid_: rowid };
		const key = this.keyFromEntry(rowWithId);

		// Check main BTree and pending inserts/updates for conflicts
		if (this.data.get(key) !== undefined || (this.inTransaction && this.pendingInserts?.has(key))) {
			// TODO: Check pendingUpdates for newKey conflicts
			const pkColName = this.getPkColNames() ?? 'rowid';
			this.nextRowid = rowid; // Roll back rowid increment
			throw new ConstraintError(`UNIQUE constraint failed: ${this.tableName}.${pkColName}`);
		}

		try {
			if (this.inTransaction) {
				// Buffer the insert
				if (!this.pendingInserts) this.pendingInserts = new Map();
				// Remove any pending delete for the same key if it exists
				if (this.pendingDeletes) {
					for (const [delRowid, delInfo] of this.pendingDeletes.entries()) {
						if (this.compareKeys(delInfo.oldKey, key) === 0) {
							this.pendingDeletes.delete(delRowid);
							break;
						}
					}
				}
				this.pendingInserts.set(key, rowWithId);
			} else {
				// Apply directly
				this.data.insert(rowWithId);
				if (this.rowidToKeyMap) {
					this.rowidToKeyMap.set(rowid, key);
				}
			}
			return rowid;
		} catch (e: any) {
			this.nextRowid = rowid;
			if (e.message?.includes("duplicate key")) {
				const pkColName = this.getPkColNames() ?? 'rowid';
				throw new ConstraintError(`UNIQUE constraint failed: ${this.tableName}.${pkColName}`);
			}
			throw e;
		}
	}

	updateRow(rowid: bigint, newData: Record<string, SqlValue>): boolean {
		if (!this.data) throw new Error("MemoryTable BTree not initialized.");

		let existingRow: MemoryTableRow | undefined | null;
		let oldKey: BTreeKey | undefined;
		let path: Path<BTreeKey, MemoryTableRow> | null = null;
		let isPendingInsert = false;

		// Check pending updates/inserts first, then main BTree
		if (this.inTransaction) {
			const pendingUpdate = this.pendingUpdates?.get(rowid);
			if (pendingUpdate) {
				existingRow = pendingUpdate.newRow; // Update the already updated row
				oldKey = pendingUpdate.newKey;
			} else {
				// Check pending inserts
				for (const [key, row] of this.pendingInserts?.entries() ?? []) {
					if (row._rowid_ === rowid) {
						existingRow = row;
						oldKey = key;
						isPendingInsert = true;
						break;
					}
				}
			}
			// Check pending deletes (cannot update a deleted row)
			if (this.pendingDeletes?.has(rowid)) {
				return false;
			}
		}

		// If not found in buffers, check main BTree
		if (!existingRow) {
			path = this.findPathByRowid(rowid);
			if (!path) return false; // Row doesn't exist
			existingRow = this.data.at(path);
			if (!existingRow) return false;
			oldKey = this.keyFromEntry(existingRow);
		}
		if (!oldKey) throw new Error("Old key not found during update"); // Should not happen

		const potentialNewRow: MemoryTableRow = { ...existingRow, ...newData, _rowid_: rowid };
		const newKey = this.keyFromEntry(potentialNewRow);

		// Check for potential UNIQUE constraint violations (including buffers)
		const conflictingRow = this.data.get(newKey);
		const conflictingPendingInsert = this.inTransaction && this.pendingInserts?.get(newKey);
		// TODO: Check pendingUpdates for newKey conflicts
		if (this.compareKeys(newKey, oldKey) !== 0 && (conflictingRow || conflictingPendingInsert)) {
			const pkColName = this.getPkColNames() ?? 'rowid';
			throw new ConstraintError(`UNIQUE constraint failed: ${this.tableName}.${pkColName}`);
		}

		try {
			if (this.inTransaction) {
				// Buffer the update
				if (!this.pendingUpdates) this.pendingUpdates = new Map();
				if (isPendingInsert) {
					// Update the pending insert directly
					this.pendingInserts?.set(newKey, potentialNewRow);
					if (this.compareKeys(newKey, oldKey) !== 0) {
						this.pendingInserts?.delete(oldKey);
					}
				} else {
					// Add to pending updates (or update existing pending update)
					this.pendingUpdates.set(rowid, { oldRow: existingRow, newRow: potentialNewRow, oldKey, newKey });
				}
				return true;
			} else {
				// Apply directly
				if (this.compareKeys(newKey, oldKey) !== 0) {
					if (!path) path = this.data.find(oldKey);
					if (!path || !path.on) throw new Error("Cannot find original row path for key change update");
					this.data.deleteAt(path);
					if (this.rowidToKeyMap) this.rowidToKeyMap.delete(rowid);
					this.data.insert(potentialNewRow);
					if (this.rowidToKeyMap) this.rowidToKeyMap.set(rowid, newKey);
					return true;
				} else {
					if (!path) path = this.data.find(oldKey);
					if (!path || !path.on) throw new Error("Cannot find original row path for same key update");
					this.data.updateAt(path, potentialNewRow);
					return true;
				}
			}
		} catch (e) {
			console.error("Failed to update row:", e);
			// Rollback potential direct BTree changes if error occurred
			if (!this.inTransaction && this.compareKeys(newKey, oldKey) !== 0) {
				try { if (path) this.data.deleteAt(path); this.data.insert(existingRow); if (this.rowidToKeyMap) this.rowidToKeyMap.set(rowid, oldKey); } catch { } // Best effort rollback
			}
			throw e;
		}
	}

	deleteRow(rowid: bigint): boolean {
		if (!this.data) throw new Error("MemoryTable BTree not initialized.");

		if (this.inTransaction) {
			// Check if it's a pending insert -> just remove it
			let foundPendingInsert = false;
			if (this.pendingInserts) {
				for (const [key, row] of this.pendingInserts.entries()) {
					if (row._rowid_ === rowid) {
						this.pendingInserts.delete(key);
						foundPendingInsert = true;
						break;
					}
				}
			}
			if (foundPendingInsert) return true;

			// Check if it's a pending update -> revert to delete
			const pendingUpdate = this.pendingUpdates?.get(rowid);
			if (pendingUpdate) {
				if (!this.pendingDeletes) this.pendingDeletes = new Map();
				this.pendingDeletes.set(rowid, { oldRow: pendingUpdate.oldRow, oldKey: pendingUpdate.oldKey });
				this.pendingUpdates?.delete(rowid);
				return true;
			}

			// If not in insert/update buffers, mark for deletion
			const path = this.findPathByRowid(rowid); // Find original row in BTree
			if (!path) return false; // Already deleted or never existed
			const oldRow = this.data.at(path);
			if (!oldRow) return false;
			const oldKey = this.keyFromEntry(oldRow);

			if (!this.pendingDeletes) this.pendingDeletes = new Map();
			this.pendingDeletes.set(rowid, { oldRow, oldKey });
			return true;

		} else {
			// Apply directly
			const path = this.findPathByRowid(rowid);
			if (!path) return false;
			try {
				this.data.deleteAt(path);
				if (this.rowidToKeyMap) {
					this.rowidToKeyMap.delete(rowid);
				}
				return true;
			} catch (e) {
				console.error("BTree deleteAt failed:", e);
				return false;
			}
		}
	}

	clear(): void {
		if (this.data) {
			this.data = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);
		}
		if (this.rowidToKeyMap) {
			this.rowidToKeyMap.clear();
		}
		this.nextRowid = BigInt(1);
	}

	get size(): number {
		return this.data?.getCount() ?? 0;
	}

	getRowIds(): bigint[] {
		if (!this.data) return [];
		const ids: bigint[] = [];
		for (const path of this.data.ascending(this.data.first())) {
			const row = this.data.at(path);
			if (row) ids.push(row._rowid_);
		}
		return ids;
	}

	getAllRows(): MemoryTableRow[] {
		if (!this.data) return [];
		const rows: MemoryTableRow[] = [];
		for (const path of this.data.ascending(this.data.first())) {
			const row = this.data.at(path);
			if (row) rows.push(row);
		}
		return rows;
	}

	isReadOnly(): boolean {
		return this.readOnly;
	}

	private getPkColNames(): string | null {
		if (this.primaryKeyColumnIndices.length === 0) return null;
		return this.primaryKeyColumnIndices.map(idx => this.columns[idx]?.name ?? '?').join(', ');
	}

	// --- Savepoint Management Methods ---
	createSavepoint(savepointIndex: number): void {
		if (!this.inTransaction) return; // No-op if not in transaction
		// Ensure savepoint stack has correct depth
		while (this.savepoints.length < savepointIndex) {
			// If VDBE skipped indices (shouldn't happen), fill with previous state
			console.warn(`MemoryTable ${this.tableName}: Filling missing savepoint index ${this.savepoints.length}`);
			const previousState = this.savepoints.length > 0 ? this.savepoints[this.savepoints.length - 1] : this.createBufferSnapshot();
			this.savepoints.push(previousState);
		}
		// Store a snapshot of the *current* buffer state
		this.savepoints[savepointIndex] = this.createBufferSnapshot();
		console.log(`MemoryTable ${this.tableName}: Created savepoint at index ${savepointIndex}`);
	}

	releaseSavepoint(savepointIndex: number): void {
		if (!this.inTransaction) return;
		// Release means discarding savepoints *at or after* this index
		if (savepointIndex >= 0 && savepointIndex < this.savepoints.length) {
			this.savepoints.length = savepointIndex; // Truncate the array
			 console.log(`MemoryTable ${this.tableName}: Released savepoints from index ${savepointIndex}`);
		}
	}

	rollbackToSavepoint(savepointIndex: number): void {
		if (!this.inTransaction) return;
		if (savepointIndex < 0 || savepointIndex >= this.savepoints.length) {
			console.error(`MemoryTable ${this.tableName}: Invalid savepoint index ${savepointIndex} for rollback.`);
			// Should maybe throw an error?
			return;
		}

		// Restore buffer state from the specified savepoint
		const savedState = this.savepoints[savepointIndex];
		this.pendingInserts = new Map(savedState.inserts);
		this.pendingUpdates = new Map(savedState.updates);
		this.pendingDeletes = new Map(savedState.deletes);

		// Discard subsequent savepoints
		this.savepoints.length = savepointIndex + 1; // Keep the one we rolled back to
		console.log(`MemoryTable ${this.tableName}: Rolled back to savepoint index ${savepointIndex}`);
	}

	private createBufferSnapshot(): {
		inserts: Map<BTreeKey, MemoryTableRow>;
		updates: Map<bigint, { oldRow: MemoryTableRow, newRow: MemoryTableRow, oldKey: BTreeKey, newKey: BTreeKey }>;
		deletes: Map<bigint, { oldRow: MemoryTableRow, oldKey: BTreeKey }>;
	} {
		// Create deep copies of the maps to capture the state
		return {
			inserts: new Map(this.pendingInserts ?? []), // Deep copy needed if rows are mutable?
			updates: new Map(this.pendingUpdates ?? []), // Deep copy needed?
			deletes: new Map(this.pendingDeletes ?? []), // Deep copy needed?
		};
		// NOTE: If MemoryTableRow objects within these maps are mutated directly elsewhere,
		// a deeper clone would be necessary here. For now, assume SqlValue is immutable
		// and row objects are replaced, not mutated.
	}
	// ----------------------------------
}

/**
 * A module that provides in-memory table functionality using digitree.
 */
export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableCursor> {
	private static SCHEMA_VERSION = 1;
	private tables: Map<string, MemoryTable> = new Map();

	private config: { readOnly?: boolean; };

	constructor(config: { readOnly?: boolean } = {}) {
		this.config = config;
	}

	async xCreate(db: Database, pAux: unknown, args: ReadonlyArray<string>): Promise<MemoryTable> {
		if (args.length < 3) { throw new SqliteError("Invalid memory table declaration: schema and table name required", StatusCode.ERROR); }
		const schemaName = args[1];
		const tableName = args[2];
		const tableKey = this.getTableKey(schemaName, tableName);
		if (this.tables.has(tableKey)) { throw new SqliteError(`Memory table '${tableName}' already exists in schema '${schemaName}'`, StatusCode.ERROR); }

		const createTableSql = args.find(arg => arg.trim().toUpperCase().startsWith("CREATE TABLE"));

		const table = new MemoryTable(db, this, schemaName, tableName, !!this.config.readOnly);
		this.tables.set(tableKey, table);

		const sqlToParse = createTableSql ?? `CREATE TABLE "${tableName}" (value)`;
		await this.setupSchema(db, table, sqlToParse);

		return table;
	}

	async xConnect(db: Database, pAux: unknown, args: ReadonlyArray<string>): Promise<MemoryTable> {
		if (args.length < 3) { throw new SqliteError("Invalid memory table connection request", StatusCode.ERROR); }
		const schemaName = args[1];
		const tableName = args[2];
		const tableKey = this.getTableKey(schemaName, tableName);
		const existingTable = this.tables.get(tableKey);
		if (existingTable) {
			return existingTable;
		}
		return this.xCreate(db, pAux, args);
	}

	async xDisconnect(table: MemoryTable): Promise<void> {
		console.log(`Memory table '${table.tableName}' disconnected`);
	}

	async xDestroy(table: MemoryTable): Promise<void> {
		table.clear();
		const tableKey = this.getTableKey(table.schemaName, table.tableName);
		this.tables.delete(tableKey);
		console.log(`Memory table '${table.tableName}' destroyed`);
	}

	/** Create a new cursor for scanning the virtual table. */
	async xOpen(table: MemoryTable): Promise<MemoryTableCursor> {
		return new MemoryTableCursor(table);
	}

	/** Close a virtual table cursor. */
	async xClose(cursor: MemoryTableCursor): Promise<void> {
		cursor.reset();
	}

	xBestIndex(table: MemoryTable, indexInfo: IndexInfo): number {
		const constraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		const pkIndices = table.primaryKeyColumnIndices;
		const keyIsRowid = pkIndices.length === 0;
		let currentArg = 1;
		const tableSize = table.size || 1;

		const PLANS = {
			FULL_ASC: 0,
			KEY_EQ: 1,
			KEY_RANGE_ASC: 2,
			FULL_DESC: 3,
			KEY_RANGE_DESC: 4,
		};

		let bestPlan = {
			idxNum: PLANS.FULL_ASC,
			cost: tableSize * 10.0,
			rows: BigInt(tableSize),
			usedConstraintIndices: new Set<number>(),
			boundConstraintIndices: { lower: -1, upper: -1 },
			orderByConsumed: false,
			isDesc: false,
			lowerBoundOp: null as IndexConstraintOp | null,
			upperBoundOp: null as IndexConstraintOp | null,
		};

		const eqConstraintsMap = new Map<number, number>();
		let canUseEqPlan = pkIndices.length > 0;

		for (let i = 0; i < indexInfo.nConstraint; i++) {
			const constraint = indexInfo.aConstraint[i];
			if (constraint.op === IndexConstraintOp.EQ && constraint.usable) {
				if (keyIsRowid && constraint.iColumn === -1) {
					eqConstraintsMap.set(-1, i);
					break;
				} else if (pkIndices.includes(constraint.iColumn)) {
					eqConstraintsMap.set(constraint.iColumn, i);
				}
			}
		}
		if (pkIndices.length > 0) {
			for (const pkIdx of pkIndices) {
				if (!eqConstraintsMap.has(pkIdx)) {
					canUseEqPlan = false;
					break;
				}
			}
		} else {
			canUseEqPlan = eqConstraintsMap.has(-1);
		}

		if (canUseEqPlan) {
			const planEqCost = Math.log2(tableSize + 1) + 1.0;
			const planEqRows = BigInt(1);
			if (planEqCost < bestPlan.cost) {
				const usedIndices = new Set(eqConstraintsMap.values());
				bestPlan = {
					...bestPlan,
					idxNum: PLANS.KEY_EQ,
					cost: planEqCost,
					rows: planEqRows,
					usedConstraintIndices: usedIndices,
					orderByConsumed: true,
				};
			}
		}

		const firstPkIndex = pkIndices[0] ?? -1;
		let lowerBoundConstraint: { index: number, op: IndexConstraintOp } | null = null;
		let upperBoundConstraint: { index: number, op: IndexConstraintOp } | null = null;
		for (let i = 0; i < indexInfo.nConstraint; i++) {
			const c = indexInfo.aConstraint[i];
			if (c.iColumn === firstPkIndex && c.usable) {
				if (c.op === IndexConstraintOp.GT || c.op === IndexConstraintOp.GE) {
					if (!lowerBoundConstraint || (c.op > lowerBoundConstraint.op)) {
						lowerBoundConstraint = { index: i, op: c.op };
					}
				} else if (c.op === IndexConstraintOp.LT || c.op === IndexConstraintOp.LE) {
					if (!upperBoundConstraint || (c.op < upperBoundConstraint.op)) {
						upperBoundConstraint = { index: i, op: c.op };
					}
				}
			}
		}

		if (lowerBoundConstraint || upperBoundConstraint) {
			const planRangeRows = BigInt(Math.max(1, Math.floor(tableSize / 4)));
			const planRangeCost = Math.log2(tableSize + 1) * 2.0 + Number(planRangeRows);
			if (planRangeCost < bestPlan.cost) {
				const usedIndices = new Set<number>();
				if (lowerBoundConstraint) usedIndices.add(lowerBoundConstraint.index);
				if (upperBoundConstraint) usedIndices.add(upperBoundConstraint.index);

				bestPlan = {
					...bestPlan,
					idxNum: PLANS.KEY_RANGE_ASC,
					cost: planRangeCost,
					rows: planRangeRows,
					usedConstraintIndices: usedIndices,
					boundConstraintIndices: {
						lower: lowerBoundConstraint?.index ?? -1,
						upper: upperBoundConstraint?.index ?? -1
					},
					lowerBoundOp: lowerBoundConstraint?.op ?? null,
					upperBoundOp: upperBoundConstraint?.op ?? null,
				};
			}
		}

		let canConsumeOrder = false;
		let isOrderDesc = false;
		if (indexInfo.nOrderBy === pkIndices.length && pkIndices.length > 0) {
			canConsumeOrder = pkIndices.every((pkIdx, i) =>
				indexInfo.aOrderBy[i].iColumn === pkIdx &&
				indexInfo.aOrderBy[i].desc === indexInfo.aOrderBy[0].desc
			);
			if (canConsumeOrder) isOrderDesc = indexInfo.aOrderBy[0].desc;
		} else if (indexInfo.nOrderBy === 1 && keyIsRowid && indexInfo.aOrderBy[0].iColumn === -1) {
			canConsumeOrder = true;
			isOrderDesc = indexInfo.aOrderBy[0].desc;
		}

		if (canConsumeOrder) {
			if (bestPlan.idxNum === PLANS.FULL_ASC || bestPlan.idxNum === PLANS.KEY_RANGE_ASC) {
				bestPlan.orderByConsumed = true;
				bestPlan.isDesc = isOrderDesc;
				if (bestPlan.idxNum === PLANS.FULL_ASC) {
					bestPlan.idxNum = isOrderDesc ? PLANS.FULL_DESC : PLANS.FULL_ASC;
					bestPlan.cost *= 0.9;
				} else {
					bestPlan.idxNum = isOrderDesc ? PLANS.KEY_RANGE_DESC : PLANS.KEY_RANGE_ASC;
					bestPlan.cost *= 0.9;
				}
			}
		}

		indexInfo.idxNum = bestPlan.idxNum;
		indexInfo.estimatedCost = bestPlan.cost;
		indexInfo.estimatedRows = bestPlan.rows;
		indexInfo.orderByConsumed = bestPlan.orderByConsumed;
		indexInfo.idxFlags = (bestPlan.idxNum === PLANS.KEY_EQ) ? 1 : 0;

		currentArg = 1;
		bestPlan.usedConstraintIndices.forEach(constraintIndex => {
			constraintUsage[constraintIndex].argvIndex = currentArg++;
			constraintUsage[constraintIndex].omit = true;
		});
		indexInfo.aConstraintUsage = constraintUsage;

		let idxStrParts = [`plan=${bestPlan.idxNum}`];
		if (bestPlan.orderByConsumed) idxStrParts.push(`order=${bestPlan.isDesc ? 'DESC' : 'ASC'}`);
		if (bestPlan.lowerBoundOp) idxStrParts.push(`lb_op=${bestPlan.lowerBoundOp}`);
		if (bestPlan.upperBoundOp) idxStrParts.push(`ub_op=${bestPlan.upperBoundOp}`);
		if (bestPlan.usedConstraintIndices.size > 0) idxStrParts.push(`constraints=[${[...bestPlan.usedConstraintIndices].join(',')}]`);
		indexInfo.idxStr = idxStrParts.join(',');

		return StatusCode.OK;
	}

	async xFilter(cursor: MemoryTableCursor, idxNum: number, idxStr: string | null, args: ReadonlyArray<SqlValue>): Promise<void> {
		cursor.reset();
		const table = cursor.table;
		const btree = table.data;
		const inTransaction = table.inTransaction;
		const pendingInserts = table.pendingInserts;
		const pendingUpdates = table.pendingUpdates;
		const pendingDeletes = table.pendingDeletes;

		if (!btree) throw new SqliteError("MemoryTable BTree not initialized in xFilter.", StatusCode.INTERNAL);

		let btreeIterator: IterableIterator<Path<BTreeKey, MemoryTableRow>> | null = null;
		let argIdx = 0;
		let isDesc = false;

		const planParams = new Map<string, string>();
		idxStr?.split(',').forEach(part => {
			const eqIdx = part.indexOf('=');
			if (eqIdx > 0) {
				planParams.set(part.substring(0, eqIdx), part.substring(eqIdx + 1));
			}
		});
		isDesc = planParams.get('order') === 'DESC';

		// --- Determine BTree scan range/iterator based on plan ---
		try {
			// (Simplified logic from before - just get the BTree iterator)
			// TODO: Refine range/key creation based on idxNum/args/planParams
			switch (idxNum) {
				case 1: // KEY_EQ
				case 2: // KEY_RANGE_ASC
				case 4: // KEY_RANGE_DESC
					// Placeholder: Assume full scan for merging simplicity for now
					btreeIterator = isDesc ? btree.descending(btree.last()) : btree.ascending(btree.first());
					break;
				case 3: // FULL_DESC
					btreeIterator = btree.descending(btree.last());
					break;
				case 0: // FULL_ASC
				default:
					btreeIterator = btree.ascending(btree.first());
					break;
			}
		} catch (e) {
			console.error(`Error preparing BTree iterator (idxNum=${idxNum}):`, e);
			cursor.reset(); // Ensure cursor is reset on error
			throw e;
		}

		// --- Prepare Merged Results ---
		const finalResults: MemoryTableRow[] = [];
		if (!inTransaction) {
			// No transaction - just iterate BTree
			if (btreeIterator) {
				for (const path of btreeIterator) {
					const row = btree.at(path);
					if (row) {
						finalResults.push(row); // TODO: Apply filter args if needed
					}
				}
			}
		} else {
			// Transaction active - merge BTree and buffers
			const btreeRows = new Map<BTreeKey, MemoryTableRow>();
			const compareKeys = (table as any).compareKeys; // Access private compare fn
			const keyFromEntry = (table as any).keyFromEntry; // Access private key fn

			// 1. Gather relevant BTree rows (respecting range if implemented)
			if (btreeIterator) {
				for (const path of btreeIterator) {
					const row = btree.at(path);
					if (row && !pendingDeletes?.has(row._rowid_)) { // Skip deleted rows
						const key = keyFromEntry(row);
						btreeRows.set(key, row);
					}
				}
			}

			// 2. Apply pending updates to the gathered BTree rows
			if (pendingUpdates) {
				for (const [rowid, updateInfo] of pendingUpdates.entries()) {
					// If the original key was in our BTree set, replace the row data
					if (btreeRows.has(updateInfo.oldKey)) {
						btreeRows.set(updateInfo.oldKey, updateInfo.newRow); // Update in place (key doesn't change map entry)
						// If the key *also* changed, remove the old key entry and add the new one
						if (compareKeys(updateInfo.oldKey, updateInfo.newKey) !== 0) {
							btreeRows.delete(updateInfo.oldKey);
							btreeRows.set(updateInfo.newKey, updateInfo.newRow);
						}
					}
					// If the original row was *not* in the initial btreeRows set
					// (e.g. due to range scan), but the *new* key falls into range,
					// we might need to add it. This requires checking filter args. Skipped for now.
				}
			}

			// 3. Add pending inserts (apply filter args if needed)
			const mergedRows = new Map(btreeRows);
			if (pendingInserts) {
				for (const [key, row] of pendingInserts.entries()) {
					// TODO: Check if inserted row matches filter args if provided
					mergedRows.set(key, row);
				}
			}

			// 4. Convert map values to array and sort
			finalResults.push(...mergedRows.values());
			finalResults.sort((a, b) => {
				const keyA = keyFromEntry(a);
				const keyB = keyFromEntry(b);
				const cmp = compareKeys(keyA, keyB);
				return isDesc ? -cmp : cmp;
			});
		}

		// --- Set results in cursor ---
		cursor.setResults(finalResults);
	}

	async xNext(cursor: MemoryTableCursor): Promise<void> {
		// Advance the merged list iterator
		cursor.advance();
	}

	async xEof(cursor: MemoryTableCursor): Promise<boolean> {
		// Check the merged list iterator
		return cursor.eof();
	}

	xColumn(cursor: MemoryTableCursor, context: SqliteContext, columnIndex: number): number {
		// Read from the current row in the merged list
		const row = cursor.getCurrentRow();
		if (!row) {
			context.resultNull();
			return StatusCode.OK;
		}

		if (columnIndex === -1) {
			context.resultInt64(row._rowid_);
			return StatusCode.OK;
		}

		if (columnIndex < 0 || columnIndex >= cursor.table.columns.length) {
			context.resultError(`Invalid column index ${columnIndex}`, StatusCode.RANGE);
			return StatusCode.RANGE;
		}
		const columnName = cursor.table.columns[columnIndex].name;

		// Access potentially non-existent columns safely
		const value = Object.prototype.hasOwnProperty.call(row, columnName) ? row[columnName] : null;
		context.resultValue(value ?? null);
		return StatusCode.OK;
	}

	async xRowid(cursor: MemoryTableCursor): Promise<bigint> {
		// Read from the current row in the merged list
		const rowid = cursor.getCurrentRowId();
		if (rowid === null) {
			throw new SqliteError("Cursor is not pointing to a valid row", StatusCode.MISUSE);
		}
		return rowid;
	}

	async xUpdate(table: MemoryTable, values: SqlValue[], rowidFromOpcode: bigint | null): Promise<{ rowid?: bigint }> {
		// Simplified interpretation based on our addRow/updateRow/deleteRow
		if (table.isReadOnly()) {
			throw new SqliteError(`Table '${table.tableName}' is read-only`, StatusCode.READONLY);
		}
		const release = await Latches.acquire(`MemoryTable.xUpdate:${table.schemaName}.${table.tableName}`);

		try {
			if (values.length === 1 && typeof values[0] === 'bigint') {
				// DELETE: values[0] is the rowid to delete
				table.deleteRow(values[0]);
				return {};
			} else if (values.length > 1 && values[0] === null) {
				// INSERT: values[0]=NULL, values[1..] are column values
				const data = Object.fromEntries(table.columns.map((col, idx) => [col.name, values[idx + 1]]));
				const newRowid = table.addRow(data);
				return { rowid: newRowid };
			} else if (values.length > 1 && typeof values[0] === 'bigint') {
				// UPDATE: values[0]=rowid, values[1..] are new column values
				const targetRowid = values[0];
				const data = Object.fromEntries(table.columns.map((col, idx) => [col.name, values[idx + 1]]));
				const updated = table.updateRow(targetRowid, data);
				if (!updated) throw new SqliteError(`Update failed for rowid ${targetRowid}`, StatusCode.ERROR);
				return {};
			} else {
				throw new SqliteError("Unsupported arguments for xUpdate", StatusCode.ERROR);
			}
		} finally {
			release();
		}
	}

	async xBegin(table: MemoryTable): Promise<void> {
		// Acquire latch to ensure atomicity of starting transaction state
		const release = await Latches.acquire(`MemoryTable.xBegin:${table.schemaName}.${table.tableName}`);
		try {
			if (table.inTransaction) {
				// Nested transactions might require savepoint logic (not implemented)
				console.warn(`MemoryTable ${table.tableName}: Nested transaction started without savepoint support.`);
			} else {
				table.inTransaction = true;
				table.pendingInserts = new Map();
				table.pendingUpdates = new Map();
				table.pendingDeletes = new Map();
			}
		} finally {
			release();
		}
	}

	async xCommit(table: MemoryTable): Promise<void> {
		const release = await Latches.acquire(`MemoryTable.xCommit:${table.schemaName}.${table.tableName}`);
		try {
			if (!table.inTransaction) return; // Commit without begin is no-op
			if (!table.data) throw new Error("BTree missing during commit");

			// Apply pending changes
			// Order matters: Deletes, Updates (handle key changes), Inserts

			// 1. Deletes
			if (table.pendingDeletes) {
				for (const [rowid, delInfo] of table.pendingDeletes.entries()) {
					const path = table.data.find(delInfo.oldKey); // Find by original key
					if (path.on) {
						try {
							table.data.deleteAt(path);
							if (table.rowidToKeyMap) table.rowidToKeyMap.delete(rowid);
						} catch (e) {
							console.error(`Commit: Failed to delete rowid ${rowid} with key ${delInfo.oldKey}`, e);
							// Continue applying other changes?
						}
					}
				}
			}

			// 2. Updates
			if (table.pendingUpdates) {
				for (const [rowid, upInfo] of table.pendingUpdates.entries()) {
					const keyChanged = table.compareKeys(upInfo.oldKey, upInfo.newKey) !== 0;
					if (keyChanged) {
						// Delete old entry first (if it wasn't already deleted above)
						if (!table.pendingDeletes?.has(rowid)) {
							const oldPath = table.data.find(upInfo.oldKey);
							if (oldPath.on) {
								try { table.data.deleteAt(oldPath); } catch (e) { console.warn(`Commit Update: Failed to delete old key ${upInfo.oldKey}`, e); }
							}
						}
						if (table.rowidToKeyMap) table.rowidToKeyMap.delete(rowid); // Remove old mapping
						// Insert new entry
						try {
							table.data.insert(upInfo.newRow);
							if (table.rowidToKeyMap) table.rowidToKeyMap.set(rowid, upInfo.newKey);
						} catch (e) {
							console.error(`Commit: Failed to insert updated rowid ${rowid} with new key ${upInfo.newKey}`, e);
						}
					} else {
						// Update in place
						const path = table.data.find(upInfo.oldKey);
						if (path.on) {
							try { table.data.updateAt(path, upInfo.newRow); } catch (e) { console.error(`Commit: Failed to update in-place rowid ${rowid} with key ${upInfo.oldKey}`, e); }
						} else {
							console.warn(`Commit Update: Rowid ${rowid} with key ${upInfo.oldKey} not found for in-place update.`);
						}
					}
				}
			}

			// 3. Inserts
			if (table.pendingInserts) {
				for (const [key, row] of table.pendingInserts.entries()) {
					try {
						table.data.insert(row);
						if (table.rowidToKeyMap) table.rowidToKeyMap.set(row._rowid_, key);
					} catch (e) {
						console.error(`Commit: Failed to insert rowid ${row._rowid_} with key ${key}`, e);
					}
				}
			}

			// Clear transaction state
			table.pendingInserts = null;
			table.pendingUpdates = null;
			table.pendingDeletes = null;
			table.inTransaction = false;

		} finally {
			release();
		}
	}

	async xRollback(table: MemoryTable): Promise<void> {
		const release = await Latches.acquire(`MemoryTable.xRollback:${table.schemaName}.${table.tableName}`);
		try {
			if (!table.inTransaction) return; // Rollback without begin is no-op
			// Just discard pending changes
			table.pendingInserts = null;
			table.pendingUpdates = null;
			table.pendingDeletes = null;
			table.inTransaction = false;
		} finally {
			release();
		}
	}

	async xSync(table: MemoryTable): Promise<void> { /* No-op */ }

	async xRename(table: MemoryTable, newName: string): Promise<void> {
		const oldTableKey = this.getTableKey(table.schemaName, table.tableName);
		const newTableKey = this.getTableKey(table.schemaName, newName);

		if (oldTableKey === newTableKey) return;
		if (this.tables.has(newTableKey)) {
			throw new SqliteError(`Cannot rename memory table: target name '${newName}' already exists in schema '${table.schemaName}'`);
		}

		this.tables.delete(oldTableKey);
		(table as any).tableName = newName;
		this.tables.set(newTableKey, table);

		console.log(`Memory table renamed from '${oldTableKey}' to '${newName}'`);
	}

	// --- Savepoint Hooks ---
	async xSavepoint(table: MemoryTable, savepointIndex: number): Promise<void> {
		table.createSavepoint(savepointIndex);
	}

	async xRelease(table: MemoryTable, savepointIndex: number): Promise<void> {
		table.releaseSavepoint(savepointIndex);
	}

	async xRollbackTo(table: MemoryTable, savepointIndex: number): Promise<void> {
		table.rollbackToSavepoint(savepointIndex);
	}
	// -----------------------

	private getTableKey(schemaName: string, tableName: string): string {
		return `${schemaName.toLowerCase()}.${tableName.toLowerCase()}`;
	}

	private async setupSchema(db: Database, table: MemoryTable, createTableSql: string): Promise<void> {
		const moduleName = table.module.constructor.name;
		const safeCreateTableSql = createTableSql.replace(/"/g, '""');
		const createVirtualTableSql = `CREATE VIRTUAL TABLE "${table.schemaName}"."${table.tableName}" USING ${moduleName}("${safeCreateTableSql}")`;

		const initialTableSchema = db.schemaManager.declareVtab(table.schemaName, createVirtualTableSql, table);

		let parsedColumns: { name: string, type: SqlDataType }[] = [];
		let primaryKeyColNames: string[] = [];
		try {
			const parser = new Parser();
			const ast = parser.parse(createTableSql);
			if (ast.type === 'createTable') {
				const createTableAst = ast as AST.CreateTableStmt;
				parsedColumns = createTableAst.columns.map(colDef => {
					let affinity = SqlDataType.TEXT;
					const typeName = colDef.dataType?.toUpperCase() || '';
					if (typeName.includes('INT')) affinity = SqlDataType.INTEGER;
					else if (typeName.includes('REAL') || typeName.includes('FLOAT') || typeName.includes('DOUBLE')) affinity = SqlDataType.FLOAT;
					else if (typeName.includes('BLOB')) affinity = SqlDataType.BLOB;
					else if (typeName.includes('NUMERIC')) affinity = SqlDataType.FLOAT;
					else if (typeName.includes('BOOL')) affinity = SqlDataType.INTEGER;
					else if (typeName.length > 0) affinity = SqlDataType.TEXT;
					return { name: colDef.name, type: affinity };
				});

				let foundPk = false;
				createTableAst.constraints.forEach(constraint => {
					if (constraint.type === 'primaryKey' && constraint.columns) {
						if (foundPk) throw new Error("Multiple primary keys defined");
						primaryKeyColNames = constraint.columns;
						foundPk = true;
					}
				});
				if (!foundPk) {
					createTableAst.columns.forEach(colDef => {
						if (colDef.constraints.some(c => c.type === 'primaryKey')) {
							if (foundPk) throw new Error("Multiple primary keys defined");
							primaryKeyColNames = [colDef.name];
							foundPk = true;
						}
					});
				}
			} else { throw new Error(`Expected CREATE TABLE, got ${ast.type}`); }
		} catch (e: any) {
			throw new SqliteError(`Invalid CREATE TABLE definition provided to MemoryTable module: ${e.message}`, StatusCode.ERROR);
		}

		const pkIndices = primaryKeyColNames
			.map(pkName => parsedColumns.findIndex(pc => pc.name.toLowerCase() === pkName.toLowerCase()))
			.filter(idx => idx !== -1);

		if (pkIndices.length !== primaryKeyColNames.length) {
			console.warn(`MemoryTable '${table.tableName}': Some PRIMARY KEY columns not found in definition. Using rowid key.`);
			pkIndices.length = 0;
		}

		table.setColumns(parsedColumns, pkIndices);

		const finalColumns: ColumnSchema[] = table.columns.map((c, index) => ({
			name: c.name,
			affinity: c.type,
			notNull: false,
			primaryKey: pkIndices.includes(index),
			pkOrder: pkIndices.includes(index) ? pkIndices.indexOf(index) + 1 : 0,
			defaultValue: null,
			collation: 'BINARY',
			hidden: false,
			generated: false,
		}));

		const finalTableSchema: TableSchema = {
			...initialTableSchema,
			columns: Object.freeze(finalColumns),
			columnIndexMap: Object.freeze(buildColumnIndexMap(finalColumns)),
			primaryKeyColumns: Object.freeze(pkIndices),
		};

		const targetSchema = db.schemaManager.getSchema(table.schemaName);
		if (targetSchema) {
			targetSchema.addTable(finalTableSchema);
			console.log(`MemoryTable '${table.tableName}' schema finalized and registered.`);
		} else {
			console.error(`Schema ${table.schemaName} not found when finalizing MemoryTable schema.`);
		}
	}
}
