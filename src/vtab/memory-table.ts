// src/vtab/memory-table.ts
import { VirtualTable } from './table';
import { VirtualTableCursor } from './cursor';
import type { VirtualTableModule, BaseModuleConfig } from './module';
import type { IndexConstraint, IndexOrderBy } from './indexInfo';
import type { Database } from '../core/database';
import { type SqlValue, StatusCode, SqlDataType } from '../common/types';
import { SqliteError, ConstraintError } from '../common/errors';
import { FunctionContext } from '../func/context';
import type { FunctionSchema } from '../schema/function';
import { BTree, KeyBound, KeyRange, Path } from 'digitree';
import { compareSqlValues } from '../util/comparison';
import type { P4SortKey } from '../vdbe/instruction';
import { buildColumnIndexMap, findPrimaryKeyDefinition, type TableSchema, columnDefToSchema } from '../schema/table';
import { type ColumnSchema, getAffinity } from '../schema/column'; // Use value import for getAffinity
import type { Expression, ColumnDef } from '../parser/ast';
// -----------------------------------------------------------

// Type for rows stored internally, always including the SQLite rowid
export type MemoryTableRow = Record<string, SqlValue> & { _rowid_: bigint };
// Type alias for the BTree key (can be rowid, single PK value, or array for composite PK)
export type BTreeKey = bigint | number | string | SqlValue[];

export interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: string | undefined, collation?: string }[]; // <-- Change type to string | undefined
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	checkConstraints?: ReadonlyArray<{ name?: string, expr: Expression }>; // <-- Add check constraints
	readOnly?: boolean;
}
// ------------------------------------

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
	public tableSchema: TableSchema | undefined = undefined;

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

	setColumns(columns: { name: string, type: string | undefined, collation?: string }[], pkDef: ReadonlyArray<{ index: number; desc: boolean }>): void {
		// Convert input columns (with string type) to internal format (with SqlDataType affinity)
		this.columns = columns.map(col => ({
			name: col.name,
			type: getAffinity(col.type), // Determine affinity here
			collation: col.collation
		}));

		this.primaryKeyColumnIndices = Object.freeze(pkDef.map(def => def.index)); // Store indices directly

		if (pkDef.length === 0) {
			console.log(`MemoryTable '${this.tableName}': Using rowid as BTree key.`);
			this.keyFromEntry = (row) => row._rowid_;
			this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
			this.rowidToKeyMap = null;
		} else if (pkDef.length === 1) {
			const { index: pkIndex, desc: isDesc } = pkDef[0];
			const pkCol = this.columns[pkIndex]; // Use internal columns with affinity
			const pkColName = pkCol?.name;
			const pkCollation = pkCol?.collation || 'BINARY';
			if (!pkColName) {
				console.error(`MemoryTable '${this.tableName}': Invalid primary key index ${pkIndex}. Falling back to rowid key.`);
				this.primaryKeyColumnIndices = []; // Reset PK indices
				this.keyFromEntry = (row) => row._rowid_;
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
				this.rowidToKeyMap = null;
			} else {
				console.log(`MemoryTable '${this.tableName}': Using PRIMARY KEY column '${pkColName}' (index ${pkIndex}, ${isDesc ? 'DESC' : 'ASC'}) as BTree key.`);
				this.keyFromEntry = (row) => row[pkColName] as BTreeKey;
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => {
					const cmp = compareSqlValues(a as SqlValue, b as SqlValue, pkCollation);
					return isDesc ? -cmp : cmp;
				};
				this.rowidToKeyMap = new Map();
			}
		} else {
			const pkCols = pkDef.map(def => {
				const col = this.columns[def.index]; // Use internal columns
				return {
					name: col?.name,
					desc: def.desc,
					collation: col?.collation || 'BINARY'
				};
			});
			if (pkCols.some(c => !c.name)) {
				console.error(`MemoryTable '${this.tableName}': Invalid composite primary key indices. Falling back to rowid key.`);
				this.primaryKeyColumnIndices = []; // Reset PK indices
				this.keyFromEntry = (row) => row._rowid_;
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
				this.rowidToKeyMap = null;
			} else {
				const pkColNames = pkCols.map(c => c.name!); // Safe due to check above
				console.log(`MemoryTable '${this.tableName}': Using Composite PRIMARY KEY (${pkCols.map(c => `${c.name} ${c.desc ? 'DESC' : 'ASC'}`).join(', ')}) as BTree key.`);
				this.keyFromEntry = (row) => pkColNames.map(name => row[name]);
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => this.compareCompositeKeysWithOrder(a, b, pkCols.map(c => c.desc), pkCols.map(c => c.collation));
				this.rowidToKeyMap = new Map();
			}
		}

		// Initialize BTree with key/compare functions
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
		if (!this.rowidToKeyMap && this.columns.length > 0 && this.primaryKeyColumnIndices.length > 0) { // Check if it's a non-rowid key table
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

	// --- Add internal schema modification methods ---

	/** @internal Adds a new column to the table schema and data */
	_addColumn(columnDef: ColumnDef): void {
		if (this.isReadOnly()) {
			throw new SqliteError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		}
		if (!this.data) throw new Error("MemoryTable BTree not initialized.");

		const newColNameLower = columnDef.name.toLowerCase();
		if (this.columns.some(c => c.name.toLowerCase() === newColNameLower)) {
			throw new SqliteError(`Duplicate column name: ${columnDef.name}`, StatusCode.ERROR);
		}

		// TODO: Parse default value and NOT NULL constraints from columnDef.constraints
		const defaultValue = null; // For now, default to NULL

		// Create ColumnSchema from ColumnDef
		const newColumnSchema = columnDefToSchema(columnDef);
		const newColumnAffinity = getAffinity(columnDef.dataType); // Get affinity from original type

		// 1. Update Schema Definitions
		const oldColumns = [...this.columns];
		const oldTableSchema = this.tableSchema;
		// Push to internal columns using determined affinity
		this.columns.push({ name: newColumnSchema.name, type: newColumnAffinity, collation: newColumnSchema.collation });

		// Rebuild TableSchema (simplest way to update map and keep immutable pattern)
		if (oldTableSchema) {
			const updatedColumnsSchema = [...oldTableSchema.columns, newColumnSchema];
			this.tableSchema = Object.freeze({
				...oldTableSchema,
				columns: updatedColumnsSchema,
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
				// PK definition doesn't change
			});
		}

		// 2. Update Data (Slow part!)
		try {
			// Apply to main BTree
			const updatedRows: MemoryTableRow[] = [];
			for (const path of this.data.ascending(this.data.first())) {
				const row = this.data.at(path);
				if (row) {
					const newRow = { ...row, [newColumnSchema.name]: defaultValue };
					updatedRows.push(newRow); // Store updated rows
					this.data.deleteAt(path); // Remove old row
					if (this.rowidToKeyMap && this.keyFromEntry(row) !== row._rowid_) { // Only delete if not rowid keyed
						this.rowidToKeyMap.delete(row._rowid_);
					}
				}
			}
			// Re-insert updated rows
			for (const row of updatedRows) {
				this.data.insert(row);
				if (this.rowidToKeyMap && this.keyFromEntry(row) !== row._rowid_) { // Only add if not rowid keyed
					this.rowidToKeyMap.set(row._rowid_, this.keyFromEntry(row));
				}
			}

			// Apply to pending transaction buffers (add the new column with default value)
			if (this.inTransaction) {
				const addProp = (row: Record<string, any>) => { row[newColumnSchema.name] = defaultValue; };
				this.pendingInserts?.forEach(addProp);
				this.pendingUpdates?.forEach(update => { addProp(update.oldRow); addProp(update.newRow); });
				this.pendingDeletes?.forEach(del => { addProp(del.oldRow); });
				this.savepoints.forEach(sp => {
					sp.inserts?.forEach(addProp);
					sp.updates?.forEach(update => { addProp(update.oldRow); addProp(update.newRow); });
					sp.deletes?.forEach(del => { addProp(del.oldRow); });
				});
			}
			console.log(`MemoryTable ${this.tableName}: Added column ${newColumnSchema.name}`);

		} catch (e) {
			// Rollback schema changes on error
			this.columns = oldColumns;
			this.tableSchema = oldTableSchema;
			// Data rollback is hard here, maybe need temp BTree? For now, log error.
			console.error(`Error adding column ${columnDef.name}, data might be inconsistent.`, e);
			throw new SqliteError(`Failed to add column ${columnDef.name}: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
		}
	}

	/** @internal Drops a column from the table schema and data */
	_dropColumn(columnName: string): void {
		if (this.isReadOnly()) {
			throw new SqliteError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		}
		if (!this.data) throw new Error("MemoryTable BTree not initialized.");

		const colNameLower = columnName.toLowerCase();
		const colIndex = this.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
		if (colIndex === -1) {
			throw new SqliteError(`Column not found: ${columnName}`, StatusCode.ERROR);
		}

		// Check if it's part of the primary key using tableSchema
		if (!this.tableSchema) {
			// Should not happen if table is initialized correctly
			throw new SqliteError(`Internal Error: Table schema not found for ${this.tableName} during DROP COLUMN.`, StatusCode.INTERNAL);
		}
		// Fix PK Check:
		if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
			throw new SqliteError(`Cannot drop column '${columnName}' because it is part of the primary key`, StatusCode.CONSTRAINT);
		}
		// Check table constraints (CHECK, FOREIGN KEY) - requires parsing schema TODO

		// 1. Update Schema Definitions
		const oldColumns = [...this.columns];
		const oldTableSchema = this.tableSchema; // Keep ref to full old schema
		this.columns.splice(colIndex, 1);
		// Adjust PK indices stored directly on the instance (needed for keyFromEntry etc. if PK remains)
		this.primaryKeyColumnIndices = this.primaryKeyColumnIndices.map(idx => idx > colIndex ? idx - 1 : idx);

		// Rebuild TableSchema
		const updatedColumnsSchema = oldTableSchema.columns.filter((_, idx) => idx !== colIndex);
		// Rebuild PK definition with updated indices
		const updatedPkDefinition = oldTableSchema.primaryKeyDefinition.map(def => {
			// This logic is slightly flawed if multiple PK columns exist and one *before* the target is also dropped
			// But for single drop, it works.
			return { ...def, index: def.index > colIndex ? def.index - 1 : def.index };
		});

		this.tableSchema = Object.freeze({
			...oldTableSchema,
			columns: updatedColumnsSchema,
			columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
			primaryKeyDefinition: updatedPkDefinition,
		});

		// 2. Update Data (Slow part!)
		try {
			// Apply to main BTree
			const updatedRows: MemoryTableRow[] = [];
			for (const path of this.data.ascending(this.data.first())) {
				const row = this.data.at(path);
				if (row) {
					const { [columnName]: _, ...newRow } = row; // Remove property
					updatedRows.push(newRow as MemoryTableRow);
					this.data.deleteAt(path);
					// Fix comparison: Check if key is NOT rowid
					if (this.rowidToKeyMap && this.keyFromEntry(row) !== row._rowid_) {
						this.rowidToKeyMap.delete(row._rowid_);
					}
				}
			}
			// Re-insert updated rows
			for (const row of updatedRows) {
				this.data.insert(row);
				// Fix comparison: Check if key is NOT rowid
				if (this.rowidToKeyMap && this.keyFromEntry(row) !== row._rowid_) {
					this.rowidToKeyMap.set(row._rowid_, this.keyFromEntry(row));
				}
			}

			// Apply to pending transaction buffers
			if (this.inTransaction) {
				const removeProp = (row: Record<string, any>) => { delete row[columnName]; };
				this.pendingInserts?.forEach(removeProp);
				this.pendingUpdates?.forEach(update => { removeProp(update.oldRow); removeProp(update.newRow); });
				this.pendingDeletes?.forEach(del => { removeProp(del.oldRow); });
				// Savepoints
				this.savepoints.forEach(sp => {
					sp.inserts?.forEach(removeProp);
					sp.updates?.forEach(update => { removeProp(update.oldRow); removeProp(update.newRow); });
					sp.deletes?.forEach(del => { removeProp(del.oldRow); });
				});
			}
			console.log(`MemoryTable ${this.tableName}: Dropped column ${columnName}`);
		} catch (e) {
			// Rollback schema changes
			this.columns = oldColumns;
			this.tableSchema = oldTableSchema;
			this.primaryKeyColumnIndices = oldTableSchema?.primaryKeyDefinition.map(def => def.index) ?? [];
			// Data rollback is hard...
			console.error(`Error dropping column ${columnName}, data might be inconsistent.`, e);
			throw new SqliteError(`Failed to drop column ${columnName}: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
		}
	}

	/** @internal Renames a column in the table schema and data */
	_renameColumn(oldName: string, newName: string): void {
		if (this.isReadOnly()) {
			throw new SqliteError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		}
		if (!this.data) throw new Error("MemoryTable BTree not initialized.");

		const oldNameLower = oldName.toLowerCase();
		const newNameLower = newName.toLowerCase();
		const colIndex = this.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);

		if (colIndex === -1) {
			throw new SqliteError(`Column not found: ${oldName}`, StatusCode.ERROR);
		}
		if (this.columns.some(c => c.name.toLowerCase() === newNameLower)) {
			throw new SqliteError(`Duplicate column name: ${newName}`, StatusCode.ERROR);
		}
		// Check if it's part of the primary key - DISALLOW for now due to complexity
		if (!this.tableSchema) {
			throw new SqliteError(`Internal Error: Table schema not found for ${this.tableName} during RENAME COLUMN.`, StatusCode.INTERNAL);
		}
		// Fix PK Check:
		if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
			throw new SqliteError(`Cannot rename column '${oldName}' because it is part of the primary key`, StatusCode.CONSTRAINT);
			// If allowed later, need to update keyFromEntry, compareKeys, rowidToKeyMap, and rebuild BTree potentially
		}
		// Check table constraints (CHECK, FOREIGN KEY refs *to* this col) - TODO

		// 1. Update Schema Definitions
		const oldColumns = [...this.columns];
		const oldTableSchema = this.tableSchema; // Keep ref to full old schema

		this.columns[colIndex].name = newName; // Update name in place

		// Rebuild TableSchema
		const updatedColumnsSchema = oldTableSchema.columns.map((colSchema, idx) =>
			idx === colIndex ? { ...colSchema, name: newName } : colSchema
		);
		this.tableSchema = Object.freeze({
			...oldTableSchema,
			columns: updatedColumnsSchema,
			columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
			// PK def doesn't change name if rename is disallowed for PKs
		});

		// 2. Update Data (Slow part!)
		try {
			// Apply to main BTree (key doesn't change since we disallow PK rename)
			for (const path of this.data.ascending(this.data.first())) {
				const row = this.data.at(path);
				if (row && Object.prototype.hasOwnProperty.call(row, oldName)) {
					const { [oldName]: value, ...rest } = row;
					const newRow = { ...rest, [newName]: value };
					// Don't need to delete/re-insert if key didn't change, just update
					this.data.updateAt(path, newRow as MemoryTableRow);
				} else if (row) {
					// Row exists but somehow missing oldName? Keep it as is.
					console.warn(`Rowid ${row._rowid_} missing column ${oldName} during rename to ${newName}`);
				}
			}

			// Apply to pending transaction buffers
			if (this.inTransaction) {
				const renameProp = (row: Record<string, any>) => {
					if (Object.prototype.hasOwnProperty.call(row, oldName)) {
						row[newName] = row[oldName];
						delete row[oldName];
					}
				};
				this.pendingInserts?.forEach(renameProp);
				this.pendingUpdates?.forEach(update => { renameProp(update.oldRow); renameProp(update.newRow); });
				this.pendingDeletes?.forEach(del => { renameProp(del.oldRow); });
				// Savepoints
				this.savepoints.forEach(sp => {
					sp.inserts?.forEach(renameProp);
					sp.updates?.forEach(update => { renameProp(update.oldRow); renameProp(update.newRow); });
					sp.deletes?.forEach(del => { renameProp(del.oldRow); });
				});
			}
			console.log(`MemoryTable ${this.tableName}: Renamed column ${oldName} to ${newName}`);
		} catch (e) {
			// Rollback schema changes
			this.columns = oldColumns;
			this.tableSchema = oldTableSchema;
			// Data rollback (rename properties back)
			try {
				for (const path of this.data.ascending(this.data.first())) {
					const row = this.data.at(path);
					if (row && Object.prototype.hasOwnProperty.call(row, newName)) {
						row[oldName] = row[newName];
						delete row[newName];
						this.data.updateAt(path, row);
					}
				}
				// TODO: Rollback buffers too
			} catch (rollbackError) {
				console.error("Error rolling back rename operation data:", rollbackError);
			}
			console.error(`Error renaming column ${oldName} to ${newName}, data might be inconsistent.`, e);
			throw new SqliteError(`Failed to rename column ${oldName} to ${newName}: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
		}
	}

	// -----------------------------------------
}


