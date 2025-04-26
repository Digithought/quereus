// src/vtab/memory-table.ts
import { VirtualTable } from '../table.js';
import { VirtualTableCursor } from '../cursor.js';
import type { VirtualTableModule, BaseModuleConfig, SchemaChangeInfo } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import type { Database } from '../../core/database.js';
import { type SqlValue, SqlDataType, StatusCode } from '../../common/types.js';
import { BTree, Path } from "digitree";
import { compareSqlValues } from '../../util/comparison.js';
import type { P4SortKey } from '../../vdbe/instruction.js';
import { type TableSchema, type IndexSchema } from '../../schema/table.js';
import { getAffinity } from '../../schema/column.js';
import type { Expression, ColumnDef } from '../../parser/ast.js';
import * as Logic from './table-logic.js';
import * as SchemaLogic from './table-schema.js';
import * as TrxLogic from './table-trx.js';
import * as MutationLogic from './table-mutation.js';
import { MemoryIndex, type IndexSpec } from './index.js';
import { SqliteError } from '../../common/errors.js';

// Type for rows stored internally, always including the SQLite rowid
export type MemoryTableRow = Record<string, SqlValue> & { _rowid_: bigint };
// Type alias for the BTree key (can be rowid, single PK value, or array for composite PK)
export type BTreeKey = bigint | number | string | SqlValue[];

export interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: string | undefined, collation?: string }[];
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	checkConstraints?: ReadonlyArray<{ name?: string, expr: Expression }>;
	readOnly?: boolean;
	indexes?: ReadonlyArray<IndexSpec>; // <-- Add optional indexes configuration
}

/**
 * An in-memory table implementation using digitree B+Tree.
 * Can be keyed by rowid (default) or declared PRIMARY KEY column(s).
 * Supports secondary indexes.
 * Method implementations call helper functions in table-xxx.ts
 */
export class MemoryTable extends VirtualTable {
	public columns: { name: string, type: SqlDataType, collation?: string }[] = [];
	public primaryKeyColumnIndices: ReadonlyArray<number> = [];
	public keyFromEntry: (entry: MemoryTableRow) => BTreeKey = (row) => row._rowid_;
	public compareKeys: (a: BTreeKey, b: BTreeKey) => number = compareSqlValues as any;
	public primaryTree: BTree<BTreeKey, MemoryTableRow> | null = null; // Renamed from data
	public secondary: Map<string, MemoryIndex> = new Map(); // <-- Added secondary index map
	/* @internal */ nextRowid: bigint = BigInt(1);
	private readOnly: boolean;
	public rowidToKeyMap: Map<bigint, BTreeKey> | null = null;
	public tableSchema: TableSchema | undefined = undefined;

	// --- Transaction State --- (Kept public for potential external access/inspection)
	public inTransaction: boolean = false;
	public pendingInserts: Map<BTreeKey, MemoryTableRow> | null = null;
	public pendingUpdates: Map<bigint, { oldRow: MemoryTableRow, newRow: MemoryTableRow, oldKey: BTreeKey, newKey: BTreeKey }> | null = null;
	public pendingDeletes: Map<bigint, { oldRow: MemoryTableRow, oldKey: BTreeKey }> | null = null;
	// --- Savepoint Buffer State --- (Made internal via comment)
	/* @internal */
	savepoints: {
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
		this.secondary = new Map(); // Initialize secondary index map
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
			// console.log(`MemoryTable '${this.tableName}': Using rowid as BTree key.`);
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
				// console.log(`MemoryTable '${this.tableName}': Using PRIMARY KEY column '${pkColName}' (index ${pkIndex}, ${isDesc ? 'DESC' : 'ASC'}) as BTree key.`);
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
				// console.log(`MemoryTable '${this.tableName}': Using Composite PRIMARY KEY (${pkCols.map(c => `${c.name} ${c.desc ? 'DESC' : 'ASC'}`).join(', ')}) as BTree key.`);
				this.keyFromEntry = (row) => pkColNames.map(name => row[name]);
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => this.compareCompositeKeysWithOrder(a, b, pkCols.map(c => c.desc), pkCols.map(c => c.collation));
				this.rowidToKeyMap = new Map();
			}
		}

		// Initialize PRIMARY BTree with key/compare functions
		this.primaryTree = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);
	}
	// ----------------------------------------------------

	/* @internal */
	compareCompositeKeysWithOrder(
		a: BTreeKey,
		b: BTreeKey,
		directions: ReadonlyArray<boolean>,
		collations: ReadonlyArray<string> = []
	): number {
		const arrA = a as SqlValue[];
		const arrB = b as SqlValue[];
		const len = Math.min(arrA.length, arrB.length);
		for (let i = 0; i < len; i++) {
			const dirMultiplier = directions[i] ? -1 : 1;
			const collation = collations[i] || 'BINARY';
			const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
			if (cmp !== 0) return cmp;
		}
		return arrA.length - arrB.length;
	}

	// --- New method to add and populate a secondary index ---
	/* @internal */
	addIndex(spec: IndexSpec): void {
		if (!this.primaryTree) {
			throw new Error("Cannot add index before primary tree is initialized.");
		}
		const indexName = spec.name ?? `_auto_${this.secondary.size + 1}`;
		if (this.secondary.has(indexName)) {
			throw new Error(`Index with name '${indexName}' already exists on table '${this.tableName}'.`);
		}

		console.log(`MemoryTable '${this.tableName}': Creating index '${indexName}'...`);
		const newIndex = new MemoryIndex(spec, this.columns);

		// Populate the new index from the primary tree data
		// TODO: Handle population within a transaction (use pending buffers?)
		// For now, assume this happens at CREATE time before transactions.
		try {
			for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
				const row = this.primaryTree.at(path);
				if (row) {
					newIndex.addEntry(row);
				}
			}
		} catch (e) {
			console.error(`MemoryTable '${this.tableName}': Failed to populate index '${indexName}':`, e);
			// Don't add the partially populated index
			throw e; // Re-throw
		}

		this.secondary.set(indexName, newIndex);
		console.log(`MemoryTable '${this.tableName}': Index '${indexName}' created successfully (${newIndex.size} entries).`);
	}

	/* @internal */
	dropIndex(name: string): boolean {
		const index = this.secondary.get(name);
		if (index) {
			index.clear(); // Clear BTree data
			return this.secondary.delete(name);
		}
		return false;
	}

	/** Get list of indexes for planning */
	getIndexList(): MemoryIndex[] {
		return Array.from(this.secondary.values());
	}

	// --- Method to create an ephemeral index for sorting --- //
	/* @internal */
	createEphemeralSorterIndex(sortInfo: P4SortKey): MemoryIndex {
		console.log(`MemoryTable ${this.tableName}: Creating ephemeral sorter index...`);
		if (!this.primaryTree) {
			throw new Error("Cannot create sorter index before primary tree is initialized.");
		}

		// Define key extraction and comparison based on sortInfo
		const sorterColumnMap = this.columns.map(c => c.name);
		const sortKeyFromRow = (row: MemoryTableRow): BTreeKey => {
			const keyValues = sortInfo.keyIndices.map(index => {
				const colName = sorterColumnMap[index];
				return colName ? row[colName] : null;
			});
			keyValues.push(row._rowid_); // Tie-breaker
			return keyValues;
		};

		const sortCompareKeys = (a: BTreeKey, b: BTreeKey): number => {
			const arrA = a as SqlValue[];
			const arrB = b as SqlValue[];
			const len = Math.min(arrA.length, arrB.length) - 1; // Exclude rowid tie-breaker
			for (let i = 0; i < len; i++) {
				const dirMultiplier = sortInfo.directions[i] ? -1 : 1;
				const collation = sortInfo.collations?.[i] || 'BINARY';
				const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
				if (cmp !== 0) return cmp;
			}
			// Compare rowids as tie-breaker
			const rowidA = arrA[len];
			const rowidB = arrB[len];
			return compareSqlValues(rowidA as SqlValue, rowidB as SqlValue);
		};

		// Create a temporary BTree to hold sorted row *copies*
		// Keyed by the sort key, value is the row itself.
		let sorterTree = new BTree<BTreeKey, MemoryTableRow>(sortKeyFromRow, sortCompareKeys);

		// Populate the sorter tree
		// TODO: Consider if this needs to merge pending transaction buffers?
		// Typically SorterOpen happens before modifications in the VDBE plan.
		try {
			for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
				const row = this.primaryTree.at(path);
				if (row) {
					// Store a copy of the row
					sorterTree.insert({ ...row });
				}
			}
		} catch (e) {
			console.error(`MemoryTable '${this.tableName}': Failed to populate ephemeral sorter index:`, e);
			throw e;
		}

		// Create a MemoryIndex-like object wrapper around the sorter tree.
		// Note: This isn't a true secondary index (value isn't rowid), and its BTree differs.
		// It's used specifically by the cursor for iteration.
		const ephemeralIndex: MemoryIndex = {
			name: '_sorter_',
			columns: Object.freeze(sortInfo.keyIndices),
			directions: Object.freeze(sortInfo.directions),
			// Ensure collation array always has strings
			collations: Object.freeze(sortInfo.collations?.map(c => c ?? 'BINARY') ?? sortInfo.keyIndices.map(() => 'BINARY')),
			keyFromRow: sortKeyFromRow,
			compareKeys: sortCompareKeys,
			// HACK: The 'data' BTree here stores <SortKey, RowObject>, not <IndexKey, RowId>
			// We need to cast this carefully in the cursor.
			// Cast to unknown first to bypass strict type checking for this specific case.
			data: sorterTree as unknown as BTree<[BTreeKey, bigint], [BTreeKey, bigint]>, // Acknowledge type override
			addEntry: (row) => { throw new Error("Cannot addEntry to ephemeral sorter index"); },
			removeEntry: (row) => { throw new Error("Cannot removeEntry from ephemeral sorter index"); },
			// Clear by creating a new BTree instance
			clear: () => { sorterTree = new BTree<BTreeKey, MemoryTableRow>(sortKeyFromRow, sortCompareKeys); },
			get size(): number { return sorterTree.getCount(); }
		};

		console.log(`MemoryTable ${this.tableName}: Ephemeral sorter index created (${ephemeralIndex.size} rows).`);
		return ephemeralIndex;
	}

	getRowByBTreeKey(key: BTreeKey): MemoryTableRow | null {
		// TODO: Check pending buffers
		if (!this.primaryTree) return null;
		const path = this.primaryTree.find(key);
		return path.on ? this.primaryTree.at(path) ?? null : null;
	}

	findPathByRowid(rowid: bigint): Path<BTreeKey, MemoryTableRow> | null {
		// TODO: Check pending buffers
		if (!this.primaryTree) return null;
		if (!this.rowidToKeyMap && this.columns.length > 0 && this.primaryKeyColumnIndices.length > 0) {
			console.error(`MemoryTable ${this.tableName}: Attempt to find by rowid without rowidToKeyMap on a keyed table.`);
			return null;
		} else if (this.rowidToKeyMap) {
			const key = this.rowidToKeyMap.get(rowid);
			if (key === undefined) return null;
			const path = this.primaryTree.find(key);
			return (path.on && this.primaryTree.at(path)?._rowid_ === rowid) ? path : null;
		} else {
			// Key is rowid
			const path = this.primaryTree.find(rowid);
			return path.on ? path : null;
		}
	}

	// --- Simple Accessors --- //
	get size(): number {
		// Note: This size doesn't reflect pending transaction buffers or secondary indexes
		return this.primaryTree?.getCount() ?? 0;
	}

	isReadOnly(): boolean {
		return this.readOnly;
	}

	public getPkColNames(): string | null {
		if (this.primaryKeyColumnIndices.length === 0) return null;
		return this.primaryKeyColumnIndices.map(idx => this.columns[idx]?.name ?? '?').join(', ');
	}

	// --- Methods Delegated to Logic File --- //
	/* @internal */ addRow(row: Record<string, SqlValue>): { rowid?: bigint } { return MutationLogic.addRowLogic(this, row); }
	/* @internal */ updateRow(rowid: bigint, newData: Record<string, SqlValue>): boolean { return MutationLogic.updateRowLogic(this, rowid, newData); }
	/* @internal */ deleteRow(rowid: bigint): boolean { return MutationLogic.deleteRowLogic(this, rowid); }
	/* @internal */ clear(): void { MutationLogic.clearLogic(this); }
	/* @internal */ createSavepoint(savepointIndex: number): void { TrxLogic.createSavepointLogic(this, savepointIndex); }
	/* @internal */ releaseSavepoint(savepointIndex: number): void { TrxLogic.releaseSavepointLogic(this, savepointIndex); }
	/* @internal */ rollbackToSavepoint(savepointIndex: number): void { TrxLogic.rollbackToSavepointLogic(this, savepointIndex); }
	/* @internal */ createBufferSnapshot(): any { return TrxLogic.createBufferSnapshotLogic(this); }
	/* @internal */ _addColumn(columnDef: ColumnDef): void { SchemaLogic.addColumnLogic(this, columnDef); }
	/* @internal */ _dropColumn(columnName: string): void { SchemaLogic.dropColumnLogic(this, columnName); }
	/* @internal */ _renameColumn(oldName: string, newName: string): void { SchemaLogic.renameColumnLogic(this, oldName, newName); }

	// --- Implement abstract methods from VirtualTable by calling logic functions --- //
	async xOpen(): Promise<VirtualTableCursor<this, any>> { return Logic.xOpenLogic(this) as unknown as VirtualTableCursor<this, any>; }
	xBestIndex(indexInfo: IndexInfo): number { return Logic.xBestIndexLogic(this, indexInfo); }
	async xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint; }> { return MutationLogic.xUpdateLogic(this, values, rowid); }
	async xBegin(): Promise<void> { return TrxLogic.xBeginLogic(this); }
	async xCommit(): Promise<void> { return TrxLogic.xCommitLogic(this); }
	async xRollback(): Promise<void> { return TrxLogic.xRollbackLogic(this); }
	async xSync(): Promise<void> { return Logic.xSyncLogic(this); }
	async xRename(newName: string): Promise<void> { return SchemaLogic.xRenameLogic(this, newName); }
	async xSavepoint(savepointIndex: number): Promise<void> { return TrxLogic.createSavepointLogic(this, savepointIndex); }
	async xRelease(savepointIndex: number): Promise<void> { return TrxLogic.releaseSavepointLogic(this, savepointIndex); }
	async xRollbackTo(savepointIndex: number): Promise<void> { return TrxLogic.rollbackToSavepointLogic(this, savepointIndex); }
	async xAlterSchema(changeInfo: SchemaChangeInfo): Promise<void> { return SchemaLogic.xAlterSchemaLogic(this, changeInfo); }
	async xDisconnect(): Promise<void> { return Logic.xDisconnectLogic(this); }
	// ---------------------------------------------------- //

	// --- Index DDL Methods --- //
	async xCreateIndex(indexInfo: IndexSchema): Promise<void> {
		// addIndex is synchronous, but the interface expects async
		try {
			this.addIndex(indexInfo);
			// TODO: Persist index definition? Currently schema is rebuilt on connect.
			// We might need to update the TableSchema stored in the SchemaManager.
		} catch (e) {
			console.error(`Failed to create index '${indexInfo.name}' via xCreateIndex:`, e);
			if (e instanceof SqliteError) throw e;
			throw new SqliteError(`Failed to create index: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR);
		}
	}

	async xDropIndex(indexName: string): Promise<void> {
		try {
			const dropped = this.dropIndex(indexName);
			if (!dropped) {
				throw new SqliteError(`Index not found: ${indexName}`);
			}
			// TODO: Persist index definition removal?
		} catch (e) {
			console.error(`Failed to drop index '${indexName}' via xDropIndex:`, e);
			if (e instanceof SqliteError) throw e;
			throw new SqliteError(`Failed to drop index: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR);
		}
	}
	// ------------------------- //
}


