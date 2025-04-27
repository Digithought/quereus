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

/** Type for rows stored internally, always including the SQLite rowid */
export type MemoryTableRow = Record<string, SqlValue> & { _rowid_: bigint };

/** Type alias for the BTree key (can be rowid, single PK value, or array for composite PK) */
export type BTreeKey = bigint | number | string | SqlValue[];

/** Configuration for memory table creation */
export interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: string | undefined, collation?: string }[];
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	checkConstraints?: ReadonlyArray<{ name?: string, expr: Expression }>;
	readOnly?: boolean;
	indexes?: ReadonlyArray<IndexSpec>;
}

/**
 * An in-memory table implementation using digitree B+Tree.
 * Supports primary keys, secondary indexes, and transactions.
 */
export class MemoryTable extends VirtualTable {
	public columns: { name: string, type: SqlDataType, collation?: string }[] = [];
	public primaryKeyColumnIndices: ReadonlyArray<number> = [];
	public keyFromEntry: (entry: MemoryTableRow) => BTreeKey = (row) => row._rowid_;
	public compareKeys: (a: BTreeKey, b: BTreeKey) => number = compareSqlValues as any;
	public primaryTree: BTree<BTreeKey, MemoryTableRow> | null = null;
	public secondary: Map<string, MemoryIndex> = new Map();
	/* @internal */ nextRowid: bigint = BigInt(1);
	private readOnly: boolean;
	public rowidToKeyMap: Map<bigint, BTreeKey> | null = null;
	public tableSchema: TableSchema | undefined = undefined;

	// Transaction State
	public inTransaction: boolean = false;
	public pendingInserts: Map<BTreeKey, MemoryTableRow> | null = null;
	public pendingUpdates: Map<bigint, { oldRow: MemoryTableRow, newRow: MemoryTableRow, oldKey: BTreeKey, newKey: BTreeKey }> | null = null;
	public pendingDeletes: Map<bigint, { oldRow: MemoryTableRow, oldKey: BTreeKey }> | null = null;

	/* @internal */
	savepoints: {
		inserts: Map<BTreeKey, MemoryTableRow>;
		updates: Map<bigint, { oldRow: MemoryTableRow, newRow: MemoryTableRow, oldKey: BTreeKey, newKey: BTreeKey }>;
		deletes: Map<bigint, { oldRow: MemoryTableRow, oldKey: BTreeKey }>;
	}[] = [];

	constructor(
		db: Database,
		module: VirtualTableModule<any, any>,
		schemaName: string,
		tableName: string,
		readOnly: boolean = false
	) {
		super(db, module, schemaName, tableName);
		this.readOnly = readOnly;
		this.secondary = new Map();
	}

	/**
	 * Sets up the columns and key extraction strategy for this table
	 */
	setColumns(columns: { name: string, type: string | undefined, collation?: string }[], pkDef: ReadonlyArray<{ index: number; desc: boolean }>): void {
		// Convert input columns (with string type) to internal format (with SqlDataType affinity)
		this.columns = columns.map(col => ({
			name: col.name,
			type: getAffinity(col.type), // Determine affinity here
			collation: col.collation
		}));

		this.primaryKeyColumnIndices = Object.freeze(pkDef.map(def => def.index)); // Store indices directly

		if (pkDef.length === 0) {
			this.keyFromEntry = (row) => row._rowid_;
			this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
			this.rowidToKeyMap = null;
		} else if (pkDef.length === 1) {
			const { index: pkIndex, desc: isDesc } = pkDef[0];
			const pkCol = this.columns[pkIndex];
			const pkColName = pkCol?.name;
			const pkCollation = pkCol?.collation || 'BINARY';
			if (!pkColName) {
				console.error(`MemoryTable '${this.tableName}': Invalid primary key index ${pkIndex}. Falling back to rowid key.`);
				this.primaryKeyColumnIndices = [];
				this.keyFromEntry = (row) => row._rowid_;
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
				this.rowidToKeyMap = null;
			} else {
				this.keyFromEntry = (row) => row[pkColName] as BTreeKey;
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => {
					const cmp = compareSqlValues(a as SqlValue, b as SqlValue, pkCollation);
					return isDesc ? -cmp : cmp;
				};
				this.rowidToKeyMap = new Map();
			}
		} else {
			const pkCols = pkDef.map(def => {
				const col = this.columns[def.index];
				return {
					name: col?.name,
					desc: def.desc,
					collation: col?.collation || 'BINARY'
				};
			});
			if (pkCols.some(c => !c.name)) {
				console.error(`MemoryTable '${this.tableName}': Invalid composite primary key indices. Falling back to rowid key.`);
				this.primaryKeyColumnIndices = [];
				this.keyFromEntry = (row) => row._rowid_;
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => compareSqlValues(a as SqlValue, b as SqlValue);
				this.rowidToKeyMap = null;
			} else {
				const pkColNames = pkCols.map(c => c.name!);
				this.keyFromEntry = (row) => pkColNames.map(name => row[name]);
				this.compareKeys = (a: BTreeKey, b: BTreeKey): number => this.compareCompositeKeysWithOrder(a, b, pkCols.map(c => c.desc), pkCols.map(c => c.collation));
				this.rowidToKeyMap = new Map();
			}
		}

		// Initialize PRIMARY BTree with key/compare functions
		this.primaryTree = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);
	}

	/**
	 * Compares two composite keys with respect to column direction and collation
	 */
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

	/**
	 * Adds and populates a secondary index for this table
	 */
	/* @internal */
	addIndex(spec: IndexSpec): void {
		if (!this.primaryTree) {
			throw new Error("Cannot add index before primary tree is initialized.");
		}
		const indexName = spec.name ?? `_auto_${this.secondary.size + 1}`;
		if (this.secondary.has(indexName)) {
			throw new Error(`Index with name '${indexName}' already exists on table '${this.tableName}'.`);
		}

		const newIndex = new MemoryIndex(spec, this.columns);

		// Populate the new index from primary tree data
		try {
			for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
				const row = this.primaryTree.at(path);
				if (row) {
					newIndex.addEntry(row);
				}
			}
		} catch (e) {
			throw e;
		}

		this.secondary.set(indexName, newIndex);
	}

	/**
	 * Drops a secondary index from this table
	 */
	/* @internal */
	dropIndex(name: string): boolean {
		const index = this.secondary.get(name);
		if (index) {
			index.clear();
			return this.secondary.delete(name);
		}
		return false;
	}

	/** Gets list of indexes for planning */
	getIndexList(): MemoryIndex[] {
		return Array.from(this.secondary.values());
	}

	/**
	 * Creates an ephemeral index for sorting operations
	 */
	/* @internal */
	createEphemeralSorterIndex(sortInfo: P4SortKey): MemoryIndex {
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

		// Create a temporary BTree to hold sorted row copies
		let sorterTree = new BTree<BTreeKey, MemoryTableRow>(sortKeyFromRow, sortCompareKeys);

		// Populate the sorter tree
		try {
			for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
				const row = this.primaryTree.at(path);
				if (row) {
					// Store a copy of the row
					sorterTree.insert({ ...row });
				}
			}
		} catch (e) {
			throw e;
		}

		// Create a MemoryIndex-like wrapper around the sorter tree
		const ephemeralIndex: MemoryIndex = {
			name: '_sorter_',
			columns: Object.freeze(sortInfo.keyIndices),
			directions: Object.freeze(sortInfo.directions),
			collations: Object.freeze(sortInfo.collations?.map(c => c ?? 'BINARY') ?? sortInfo.keyIndices.map(() => 'BINARY')),
			keyFromRow: sortKeyFromRow,
			compareKeys: sortCompareKeys,
			// Cast to unknown first to bypass strict type checking for this specific case
			data: sorterTree as unknown as BTree<[BTreeKey, bigint], [BTreeKey, bigint]>,
			addEntry: () => { throw new Error("Cannot addEntry to ephemeral sorter index"); },
			removeEntry: () => { throw new Error("Cannot removeEntry from ephemeral sorter index"); },
			clear: () => { sorterTree = new BTree<BTreeKey, MemoryTableRow>(sortKeyFromRow, sortCompareKeys); },
			get size(): number { return sorterTree.getCount(); }
		};

		return ephemeralIndex;
	}

	/**
	 * Gets a row using the primary BTree key
	 */
	getRowByBTreeKey(key: BTreeKey): MemoryTableRow | null {
		if (!this.primaryTree) return null;
		const path = this.primaryTree.find(key);
		return path.on ? this.primaryTree.at(path) ?? null : null;
	}

	/**
	 * Finds the BTree path for a given rowid
	 */
	findPathByRowid(rowid: bigint): Path<BTreeKey, MemoryTableRow> | null {
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

	/**
	 * Gets the current count of rows in the table
	 */
	get size(): number {
		return this.primaryTree?.getCount() ?? 0;
	}

	/**
	 * Checks if the table is read-only
	 */
	isReadOnly(): boolean {
		return this.readOnly;
	}

	/**
	 * Gets primary key column names as string for error messages
	 */
	public getPkColNames(): string | null {
		if (this.primaryKeyColumnIndices.length === 0) return null;
		return this.primaryKeyColumnIndices.map(idx => this.columns[idx]?.name ?? '?').join(', ');
	}

	// Methods delegated to logic files
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

	// VirtualTable methods implemented via delegation
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

	// Index DDL methods
	async xCreateIndex(indexInfo: IndexSchema): Promise<void> {
		try {
			this.addIndex(indexInfo);
		} catch (e) {
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
		} catch (e) {
			if (e instanceof SqliteError) throw e;
			throw new SqliteError(`Failed to drop index: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR);
		}
	}
}


