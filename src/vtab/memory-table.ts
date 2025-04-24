// src/vtab/memory-table.ts
import { VirtualTable } from './table';
import { VirtualTableCursor } from './cursor';
import type { VirtualTableModule, BaseModuleConfig } from './module';
import type { IndexInfo, IndexConstraint, IndexOrderBy } from './indexInfo';
import { IndexConstraintOp, ConflictResolution } from '../common/constants';
import type { Database } from '../core/database';
import { type SqlValue, StatusCode, SqlDataType } from '../common/types';
import { SqliteError, ConstraintError } from '../common/errors';
import type { SqliteContext } from '../func/context';
import { Latches } from '../util/latches';
import { FunctionContext } from '../func/context';
import type { FunctionSchema } from '../schema/function';
// import { Parser } from '../parser/parser';
// import type { ColumnSchema } from '../schema/column';
// import { buildColumnIndexMap, type TableSchema, findPrimaryKeyDefinition, getPrimaryKeyIndices } from '../schema/table';
// import * as AST from '../parser/ast';
// --- Import digitree and comparison ---
import { BTree, KeyBound, KeyRange, Path } from 'digitree'; // KeyBound, KeyRange added
import { compareSqlValues } from '../util/comparison';
// --- Add P4SortKey import ---
import type { P4SortKey } from '../vdbe/instruction'; // Import P4SortKey
// ------------------------------------

// Type for rows stored internally, always including the SQLite rowid
export type MemoryTableRow = Record<string, SqlValue> & { _rowid_: bigint };
// Type alias for the BTree key (can be rowid, single PK value, or array for composite PK)
type BTreeKey = bigint | number | string | SqlValue[];

// --- Define Configuration Interface ---
interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: SqlDataType, collation?: string }[];
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	readOnly?: boolean;
}
// ------------------------------------

/**
 * Cursor for the MemoryTable using BTree paths and iterators.
 * Now needs to handle transaction buffers via a merged result set.
 */
export class MemoryTableCursor extends VirtualTableCursor<MemoryTable> {
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

	// Add getter method for mergedResults
	// TODO: make this return a cursor
	getMergedResults(): MemoryTableRow[] {
		return this.mergedResults;
	}
}

/**
 * An in-memory table implementation using digitree B+Tree.
 * Can be keyed by rowid (default) or declared PRIMARY KEY column(s).
 */
export class MemoryTable extends VirtualTable {
	public columns: { name: string, type: SqlDataType, collation?: string }[] = [];
	public primaryKeyColumnIndices: ReadonlyArray<number> = [];
	public keyFromEntry: (entry: MemoryTableRow) => BTreeKey = (row) => row._rowid_;
	public compareKeys: (a: BTreeKey, b: BTreeKey) => number = compareSqlValues as any;
	public data: BTree<BTreeKey, MemoryTableRow> | null = null;
	private nextRowid: bigint = BigInt(1);
	private readOnly: boolean;
	public rowidToKeyMap: Map<bigint, BTreeKey> | null = null;
	public isSorter: boolean = false;
	// public sorterColumnMap: ColumnSchema[] | null = null; // Removed usage

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

	// --- Updated setColumns to use primaryKeyDefinition ---
	setColumns(columns: { name: string, type: SqlDataType, collation?: string }[], pkDef: ReadonlyArray<{ index: number; desc: boolean }>): void {
		this.columns = [...columns];

		if (pkDef.length === 0) {
			console.log(`MemoryTable '${this.tableName}': Using rowid as BTree key.`);
			this.keyFromEntry = (row) => row._rowid_;
			// Explicitly define compareKeys for rowid (bigint)
			// Ensure compareSqlValues handles BTreeKey which might be bigint
			this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
			this.rowidToKeyMap = null;
		} else if (pkDef.length === 1) {
			const { index: pkIndex, desc: isDesc } = pkDef[0];
			const pkColName = this.columns[pkIndex]?.name;
			const pkCollation = this.columns[pkIndex]?.collation || 'BINARY'; // Get collation from column
			if (!pkColName) {
				console.error(`MemoryTable '${this.tableName}': Invalid primary key index ${pkIndex}. Falling back to rowid key.`);
				this.keyFromEntry = (row) => row._rowid_;
				// Ensure compareSqlValues handles BTreeKey which might be bigint
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
				this.rowidToKeyMap = null;
			} else {
				console.log(`MemoryTable '${this.tableName}': Using PRIMARY KEY column '${pkColName}' (index ${pkIndex}, ${isDesc ? 'DESC' : 'ASC'}) as BTree key.`);
				this.primaryKeyColumnIndices = Object.freeze([pkIndex]);
				this.keyFromEntry = (row) => row[pkColName] as BTreeKey;
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => {
					// Cast needed as compareSqlValues takes SqlValue, but BTreeKey might be SqlValue[]
					// This case is for single PK, so it should be SqlValue
					const cmp = compareSqlValues(a as SqlValue, b as SqlValue, pkCollation);
					return isDesc ? -cmp : cmp;
				};
				this.rowidToKeyMap = new Map();
			}
		} else {
			const pkCols = pkDef.map(def => ({
				name: this.columns[def.index]?.name,
				desc: def.desc,
				collation: this.columns[def.index]?.collation || 'BINARY' // Get collation from column
			}));
			if (pkCols.some(c => !c.name)) {
				console.error(`MemoryTable '${this.tableName}': Invalid composite primary key indices. Falling back to rowid key.`);
				this.keyFromEntry = (row) => row._rowid_;
				// Ensure compareSqlValues handles BTreeKey which might be bigint
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
				this.rowidToKeyMap = null;
			} else {
				const pkColNames = pkCols.map(c => c.name!); // Safe due to check above
				console.log(`MemoryTable '${this.tableName}': Using Composite PRIMARY KEY (${pkCols.map(c => `${c.name} ${c.desc ? 'DESC' : 'ASC'}`).join(', ')}) as BTree key.`);
				this.keyFromEntry = (row) => pkColNames.map(name => row[name]);
				// Use the dedicated composite key comparison function
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => this.compareCompositeKeysWithOrder(a, b, pkCols.map(c => c.desc), pkCols.map(c => c.collation));
				this.rowidToKeyMap = new Map();
			}
		}

		// Initialize BTree if not already done
		// Or re-initialize if key structure changed (which setColumns implies)
		this.data = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);
	}
	// ----------------------------------------------------

	private compareCompositeKeysWithOrder(
		a: BTreeKey,
		b: BTreeKey,
		directions: ReadonlyArray<boolean>,
		collations: ReadonlyArray<string> = []  // Add collations parameter with default empty array
	): number {
		const arrA = a as SqlValue[];
		const arrB = b as SqlValue[];
		const len = Math.min(arrA.length, arrB.length);
		for (let i = 0; i < len; i++) {
			const dirMultiplier = directions[i] ? -1 : 1;
			const collation = collations[i] || 'BINARY'; // Use specified collation or default to BINARY
			const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
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
		if (!this.rowidToKeyMap && this.columns.length > 0) { // Check if it's a non-rowid key table
			// This case should use rowidToKeyMap, error if map is missing
			console.error(`MemoryTable ${this.tableName}: Attempt to find by rowid without rowidToKeyMap on a keyed table.`);
			return null;
		} else if (this.rowidToKeyMap) {
			const key = this.rowidToKeyMap.get(rowid);
			if (key === undefined) return null;
			const path = this.data.find(key);
			return (path.on && this.data.at(path)?._rowid_ === rowid) ? path : null;
		} else {
			// It's a rowid-keyed table
			const path = this.data.find(rowid);
			return path.on ? path : null;
		}
	}

	addRow(row: Record<string, SqlValue>): { rowid?: bigint } {
		if (!this.data) throw new Error("MemoryTable BTree not initialized.");

		const rowid = this.nextRowid; // Get potential rowid *before* conflict check
		const rowWithId: MemoryTableRow = { ...row, _rowid_: rowid };
		const key = this.keyFromEntry(rowWithId);
		let existingKeyFound = false;

		// Check main BTree for conflicts
		if (this.data.get(key) !== undefined) {
			existingKeyFound = true;
		}

		// Check pending inserts/updates for conflicts if in transaction
		if (!existingKeyFound && this.inTransaction) { // Optimization: Skip buffer check if already found in BTree
			if (this.pendingInserts?.has(key)) {
				existingKeyFound = true;
			} else if (this.pendingUpdates) {
				for (const update of this.pendingUpdates.values()) {
					if (this.compareKeys(update.newKey, key) === 0) {
						existingKeyFound = true;
						break;
					}
				}
			}
		}

		if (existingKeyFound) {
			// Don't increment nextRowid
			// Return empty object to signal conflict
			return {}; // CONFLICT DETECTED
		}

		// --- No conflict found, proceed with insert --- //
		this.nextRowid++; // Increment rowid only if no conflict

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
			return { rowid: rowid }; // SUCCESS - return new rowid
		} catch (e: any) {
			// Catch unexpected BTree errors during the actual insert
			this.nextRowid = rowid; // Rollback rowid increment on unexpected error
			// Rethrow unexpected errors
			throw new SqliteError(`Internal BTree error during insert: ${e.message}`, StatusCode.INTERNAL);
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
		const keyChanged = this.compareKeys(newKey, oldKey) !== 0;

		// Check for potential UNIQUE constraint violations if the key changed
		if (keyChanged) {
			let conflictingKeyFound = false;
			if (this.data.get(newKey) !== undefined) conflictingKeyFound = true;
			if (!conflictingKeyFound && this.inTransaction) {
				if (this.pendingInserts?.has(newKey)) conflictingKeyFound = true;
				else if (this.pendingUpdates) {
					for (const update of this.pendingUpdates.values()) {
						if (update.newRow._rowid_ !== rowid && this.compareKeys(update.newKey, newKey) === 0) {
							conflictingKeyFound = true;
							break;
						}
					}
				}
			}
			if (conflictingKeyFound) {
				const pkColName = this.getPkColNames() ?? 'rowid';
				throw new ConstraintError(`UNIQUE constraint failed: ${this.tableName}.${pkColName}`);
			}
		}

		try {
			if (this.inTransaction) {
				// Buffer the update
				if (!this.pendingUpdates) this.pendingUpdates = new Map();
				if (isPendingInsert) {
					// Update the pending insert directly
					this.pendingInserts?.set(newKey, potentialNewRow);
					if (keyChanged) {
						this.pendingInserts?.delete(oldKey);
					}
				} else {
					// Add to pending updates (or update existing pending update)
					// Capture the *original* row before this update if it came from BTree
					const originalRowFromBtree = this.pendingUpdates.has(rowid) ? this.pendingUpdates.get(rowid)!.oldRow : existingRow;
					this.pendingUpdates.set(rowid, { oldRow: originalRowFromBtree, newRow: potentialNewRow, oldKey, newKey });
				}
				return true;
			} else {
				// Apply directly
				if (keyChanged) {
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
			// Let ConstraintError propagate up to xUpdate
			if (e instanceof ConstraintError) throw e;
			console.error("Failed to update row:", e);
			// Rollback potential direct BTree changes if error occurred
			if (!this.inTransaction && keyChanged) {
				try { if (path) this.data.deleteAt(path); this.data.insert(existingRow); if (this.rowidToKeyMap) this.rowidToKeyMap.set(rowid, oldKey); } catch { } // Best effort rollback
			}
			throw new SqliteError(`Internal BTree error during update: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
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

	public getPkColNames(): string | null {
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

	// --- Internal method to configure as sorter ---
	/** @internal Configures the BTree for sorting based on provided criteria */
	_configureAsSorter(sortInfo: P4SortKey): void {
		if (this.isSorter) {
			console.warn(`MemoryTable ${this.tableName}: Already configured as sorter.`);
			return;
		}
		console.log(`MemoryTable ${this.tableName}: Configuring BTree for sorting with keys:`, sortInfo.keyIndices, `directions:`, sortInfo.directions);

		// Store the effective schema used by the sorter (assuming it matches the current columns)
		// Create simple mapping for sorter key extraction
		const sorterColumnMap = this.columns.map(c => c.name);
		// Removed ColumnSchema object creation

		const keyFromEntry = (row: MemoryTableRow): BTreeKey => {
			const keyValues = sortInfo.keyIndices.map(index => {
				// if (!this.sorterColumnMap) throw new Error("Sorter column map not set during key extraction"); // Removed check
				const colName = sorterColumnMap[index]; // Use simple name map
				return colName ? (row as any)[colName] : null;
			});
			keyValues.push(row._rowid_); // Always add rowid for tie-breaking
			return keyValues;
		};

		const compareKeys = (a: BTreeKey, b: BTreeKey): number => {
			const arrA = a as SqlValue[];
			const arrB = b as SqlValue[];
			const len = Math.min(arrA.length, arrB.length) - 1;

			for (let i = 0; i < len; i++) {
				const dirMultiplier = sortInfo.directions[i] ? -1 : 1;
				const collation = sortInfo.collations?.[i] || 'BINARY'; // Use collation from sort key or default
				const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
				if (cmp !== 0) return cmp;
			}
			const rowidA = arrA[len];
			const rowidB = arrB[len];
			return compareSqlValues(rowidA, rowidB);
		};

		this.keyFromEntry = keyFromEntry;
		this.compareKeys = compareKeys;
		this.isSorter = true;
		this.data = new BTree<BTreeKey, MemoryTableRow>(keyFromEntry, compareKeys);
		this.rowidToKeyMap = null;
	}
	// --------------------------------------------
}

/**
 * A module that provides in-memory table functionality using digitree.
 */
export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableCursor, MemoryTableConfig> {
	private static SCHEMA_VERSION = 1;
	private tables: Map<string, MemoryTable> = new Map();

	constructor() {}

	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		const tableKey = `${schemaName.toLowerCase()}.${tableName.toLowerCase()}`;
		if (this.tables.has(tableKey)) {
			throw new SqliteError(`Memory table '${tableName}' already exists in schema '${schemaName}'`, StatusCode.ERROR);
		}

		const table = new MemoryTable(db, this, schemaName, tableName, !!options.readOnly);
		this.tables.set(tableKey, table);

		// Directly set schema from options
		table.setColumns(options.columns, options.primaryKey ?? []);

		console.log(`MemoryTable '${tableName}' created (Schema set directly from options)`);
		return table;
	}

	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		const tableKey = `${schemaName.toLowerCase()}.${tableName.toLowerCase()}`;
		const existingTable = this.tables.get(tableKey);
		if (existingTable) {
			console.log(`MemoryTable '${tableName}' connected (found existing instance)`);
			return existingTable;
		}
		// If not existing, create it synchronously using xCreate
		console.log(`MemoryTable '${tableName}' not found, creating new instance via xConnect...`);
		return this.xCreate(db, pAux, moduleName, schemaName, tableName, options);
	}

	async xDisconnect(table: MemoryTable): Promise<void> {
		console.log(`Memory table '${table.tableName}' disconnected`);
	}

	async xDestroy(table: MemoryTable): Promise<void> {
		table.clear();
		// Use table properties directly
		const tableKey = `${table.schemaName.toLowerCase()}.${table.tableName.toLowerCase()}`;
		this.tables.delete(tableKey);
		console.log(`Memory table '${table.tableName}' destroyed`);
	}

	/** Create a new cursor for scanning the virtual table. */
	async xOpen(table: MemoryTable): Promise<MemoryTableCursor> {
		if (!table.data) {
			// Initialize BTree here if not done by setColumns (e.g., if constructor doesn't call it)
			table.data = new BTree<BTreeKey, MemoryTableRow>(table.keyFromEntry, table.compareKeys);
		}
		return new MemoryTableCursor(table);
	}

	/** Close a virtual table cursor. */
	async xClose(cursor: MemoryTableCursor): Promise<void> {
		cursor.reset();
	}

	xBestIndex(table: MemoryTable, indexInfo: IndexInfo): number {
		// --- Add check for sorter table ---
		if (table.isSorter) {
			// This table is just used for sorting, return a basic full-scan plan.
			// Cost should be low as it implies data is already prepared.
			indexInfo.idxNum = 0; // Use plan 0 (full scan)
			indexInfo.estimatedCost = 1.0; // Very low cost
			indexInfo.estimatedRows = BigInt(table.size || 1);
			indexInfo.orderByConsumed = true; // The output *is* the sorted order
			indexInfo.idxFlags = 0;
			// No constraints are used by the sorter itself
			indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
			indexInfo.idxStr = "sortplan"; // Indicate this is the sort plan
			return StatusCode.OK;
		}
		// --- End sorter check ---

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
			// TODO: only sort if needed
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

	async xUpdate(table: MemoryTable, values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }> {
		// Simplified interpretation based on our addRow/updateRow/deleteRow
		if (table.isReadOnly()) {
			throw new SqliteError(`Table '${table.tableName}' is read-only`, StatusCode.READONLY);
		}
		const release = await Latches.acquire(`MemoryTable.xUpdate:${table.schemaName}.${table.tableName}`);
		const onConflict = (values as any)._onConflict || ConflictResolution.ABORT; // Get conflict policy passed via VUpdate P4

		try {
			if (values.length === 1 && typeof values[0] === 'bigint') {
				// DELETE: values[0] is the rowid to delete
				table.deleteRow(values[0]);
				return {};
			} else if (values.length > 1 && values[0] === null) {
				// INSERT: values[0]=NULL, values[1..] are column values
				const data = Object.fromEntries(table.columns.map((col, idx) => [col.name, values[idx + 1]]));
				// Call addRow and check result directly
				const addResult = table.addRow(data);
				if (addResult.rowid !== undefined) {
					// Success
					return { rowid: addResult.rowid };
				} else {
					// Conflict occurred (addRow returned {})
					if (onConflict === ConflictResolution.IGNORE) {
						return {}; // Indicate ignore
					} else {
						// Throw appropriate constraint error for ABORT/FAIL etc.
						const pkColName = table.getPkColNames() ?? 'rowid'; // Reuse helper
						throw new ConstraintError(`UNIQUE constraint failed: ${table.tableName}.${pkColName}`);
					}
				}
			} else if (values.length > 1 && typeof values[0] === 'bigint') {
				// UPDATE: values[0]=rowid, values[1..] are new column values
				const targetRowid = values[0];
				const data = Object.fromEntries(table.columns.map((col, idx) => [col.name, values[idx + 1]]));
				try {
					const updated = table.updateRow(targetRowid, data);
					if (!updated) throw new SqliteError(`Update failed for rowid ${targetRowid}`, StatusCode.NOTFOUND); // NOTFOUND might be better
					return {}; // Update doesn't return rowid in this Promise structure
				} catch (e) {
					if (e instanceof ConstraintError && onConflict === ConflictResolution.IGNORE) {
						// Conflict on UPDATE (e.g., changing PK to existing value)
						return {}; // Indicate ignore
					} else {
						// Re-throw other errors or ABORT/FAIL etc. conflicts
						throw e;
					}
				}
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
		const oldTableKey = `${table.schemaName.toLowerCase()}.${table.tableName.toLowerCase()}`;
		const newTableKey = `${table.schemaName.toLowerCase()}.${newName.toLowerCase()}`;

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

	// --- Add seekRelative method ---
	async seekRelative(cursor: MemoryTableCursor, basePointer: any, offset: number): Promise<SqlValue | null> {
		// Operate on the results populated by xFilter, assuming they represent the relevant partition/order.
		// Use the getter method to access the results
		const results = cursor.getMergedResults(); // Use getter here
		if (!results || results.length === 0) {
			return null; // No results to seek within
		}

		// Find the index of the base pointer (rowid) in the current results
		// Assuming basePointer is the rowid (_rowid_ is bigint)
		let baseIndex = -1;
		for (let i = 0; i < results.length; i++) {
			if (results[i]._rowid_ === basePointer) {
				baseIndex = i;
				break;
			}
		}

		if (baseIndex === -1 || baseIndex + offset < 0 || baseIndex + offset >= results.length) {
			return null; // Out of bounds
		}

		return results[baseIndex + offset]._rowid_;
	}

	// --- Add xColumnAtPointer ---
	async xColumnAtPointer(cursor: MemoryTableCursor, pointer: any, colIdx: number): Promise<SqlValue | null> {
		const results = cursor.getMergedResults();
		if (!results || results.length === 0) return null;

		let targetRow: MemoryTableRow | undefined;
		try {
			const targetRowId = BigInt(pointer);
			targetRow = results.find(row => row._rowid_ === targetRowId);
		} catch (e) {
			console.error("xColumnAtPointer: Could not convert pointer to BigInt", pointer, e);
			throw new SqliteError(`xColumnAtPointer: Invalid pointer ${pointer}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
		}

		if (!targetRow) {
			console.warn(`xColumnAtPointer: Rowid ${pointer} not found in cursor results.`);
			return null;
		}

		if (colIdx === -1) { // Request for rowid
			return targetRow._rowid_;
		}

		const tableCols = cursor.table.columns;
		if (colIdx < 0 || colIdx >= tableCols.length) {
			console.error(`xColumnAtPointer: Invalid column index ${colIdx}`);
			return null;
		}

		const colName = tableCols[colIdx].name;
		return Object.prototype.hasOwnProperty.call(targetRow, colName) ? targetRow[colName] : null;
	}
	// ---------------------------

	// --- Add xAggregateFrame ---
	async xAggregateFrame(
		cursor: MemoryTableCursor,
		funcDef: FunctionSchema,
		frameStartPtr: any,
		frameEndPtr: any,
		argColIdx: number
	): Promise<SqlValue> {
		const results = cursor.getMergedResults();
		if (!results || results.length === 0) {
			// Handle aggregation over empty frame - usually NULL or default value
			const aggCtx = new FunctionContext(cursor.table.db, funcDef.userData); // Need DB access
			if (funcDef.xFinal) {
				funcDef.xFinal(aggCtx);
				return aggCtx._getResult() ?? null;
			} else {
				return null; // Or throw error if xFinal is required?
			}
		}

		// Find start and end indices in the results array
		let startIndex = -1;
		let endIndex = -1;

		try {
			const startRowId = BigInt(frameStartPtr);
			startIndex = results.findIndex(row => row._rowid_ === startRowId);
		} catch (e) {
			throw new SqliteError(`xAggregateFrame: Invalid start pointer ${frameStartPtr}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
		}

		// Handle frameEndPtr (could be null for UNBOUNDED FOLLOWING - treat as end of results)
		if (frameEndPtr === null) {
			endIndex = results.length - 1;
		} else {
			try {
				const endRowId = BigInt(frameEndPtr);
				endIndex = results.findIndex(row => row._rowid_ === endRowId);
			} catch (e) {
				throw new SqliteError(`xAggregateFrame: Invalid end pointer ${frameEndPtr}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
			}
		}

		if (startIndex === -1) {
			throw new SqliteError(`xAggregateFrame: Start pointer row ${frameStartPtr} not found in cursor results`, StatusCode.INTERNAL);
		}
		if (endIndex === -1 && frameEndPtr !== null) {
			throw new SqliteError(`xAggregateFrame: End pointer row ${frameEndPtr} not found in cursor results`, StatusCode.INTERNAL);
		}
		if (startIndex > endIndex) {
			// Frame is empty due to ordering/pointer issues
			startIndex = 0; // Set indices to make slice empty
			endIndex = -1;
		}

		// Initialize aggregate context
		const aggCtx = new FunctionContext(cursor.table.db, funcDef.userData);
		const argArray: SqlValue[] = []; // Reusable array for arguments

		// Iterate over the frame slice
		for (let i = startIndex; i <= endIndex; i++) {
			const row = results[i];
			let argValue: SqlValue = null;
			if (argColIdx >= 0) {
				const tableCols = cursor.table.columns;
				if (argColIdx >= tableCols.length) throw new Error(`Invalid argColIdx ${argColIdx}`);
				const colName = tableCols[argColIdx].name;
				argValue = Object.prototype.hasOwnProperty.call(row, colName) ? row[colName] : null;
			}

			aggCtx._clear(); // Clear previous result/error
			// Prepare args for xStep (might be 0 args for COUNT(*))
			if (funcDef.numArgs > 0) {
				argArray[0] = argValue;
			} else {
				argArray.length = 0;
			}

			try {
				if (funcDef.xStep) {
					funcDef.xStep(aggCtx, argArray);
					const stepError = aggCtx._getError();
					if (stepError) throw stepError;
				} else {
					throw new Error(`Aggregate function ${funcDef.name} missing xStep`);
				}
			} catch (e) {
				throw new SqliteError(`Error during ${funcDef.name} xStep: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR, e instanceof Error ? e : undefined);
			}
		}

		// Finalize the result
		aggCtx._clear();
		try {
			if (funcDef.xFinal) {
				funcDef.xFinal(aggCtx);
				const finalError = aggCtx._getError();
				if (finalError) throw finalError;
				return aggCtx._getResult() ?? null;
			} else if (funcDef.xValue) {
				// Some aggregates might just use xValue if state maps directly to result
				funcDef.xValue(aggCtx);
				return aggCtx._getResult() ?? null;
			} else {
				// Return accumulator directly if no xFinal/xValue (e.g., for simpler internal aggregates?)
				// This might be incorrect for standard aggregates.
				console.warn(`Aggregate function ${funcDef.name} missing xFinal/xValue, returning accumulator.`);
				return aggCtx._getAggregateContextRef() ?? null;
			}
		} catch (e) {
			throw new SqliteError(`Error during ${funcDef.name} xFinal/xValue: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR, e instanceof Error ? e : undefined);
		}
	}
	// -------------------------
}
