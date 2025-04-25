// src/vtab/memory-table.ts
import { VirtualTable } from '../table';
import { VirtualTableCursor } from '../cursor';
import type { VirtualTableModule, BaseModuleConfig, SchemaChangeInfo } from '../module';
import type { IndexInfo } from '../indexInfo';
import type { Database } from '../../core/database';
import { type SqlValue, SqlDataType } from '../../common/types';
import { BTree, Path } from 'digitree';
import { compareSqlValues } from '../../util/comparison';
import type { P4SortKey } from '../../vdbe/instruction';
import { type TableSchema } from '../../schema/table';
import { getAffinity } from '../../schema/column'; // Use value import for getAffinity
import type { Expression, ColumnDef } from '../../parser/ast';
import * as Logic from './table-logic';
import * as SchemaLogic from './table-schema';
import * as TrxLogic from './table-trx';
import * as MutationLogic from './table-mutation';

// Type for rows stored internally, always including the SQLite rowid
export type MemoryTableRow = Record<string, SqlValue> & { _rowid_: bigint };
// Type alias for the BTree key (can be rowid, single PK value, or array for composite PK)
export type BTreeKey = bigint | number | string | SqlValue[];

export interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: string | undefined, collation?: string }[];
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	checkConstraints?: ReadonlyArray<{ name?: string, expr: Expression }>;
	readOnly?: boolean;
}

/**
 * An in-memory table implementation using digitree B+Tree.
 * Can be keyed by rowid (default) or declared PRIMARY KEY column(s).
 * Method implementations call helper functions in table-xxx.ts
 */
export class MemoryTable extends VirtualTable {
	public columns: { name: string, type: SqlDataType, collation?: string }[] = [];
	public primaryKeyColumnIndices: ReadonlyArray<number> = [];
	public keyFromEntry: (entry: MemoryTableRow) => BTreeKey = (row) => row._rowid_;
	public compareKeys: (a: BTreeKey, b: BTreeKey) => number = compareSqlValues as any;
	public data: BTree<BTreeKey, MemoryTableRow> | null = null;
	/* @internal */ nextRowid: bigint = BigInt(1); // Made internal
	private readOnly: boolean;
	public rowidToKeyMap: Map<bigint, BTreeKey> | null = null;
	public isSorter: boolean = false;
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

		// Initialize BTree with key/compare functions
		this.data = new BTree<BTreeKey, MemoryTableRow>(this.keyFromEntry, this.compareKeys);
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

	getRowByBTreeKey(key: BTreeKey): MemoryTableRow | null {
		// TODO: Check pending buffers
		if (!this.data) return null;
		const path = this.data.find(key);
		return path.on ? this.data.at(path) ?? null : null;
	}

	findPathByRowid(rowid: bigint): Path<BTreeKey, MemoryTableRow> | null {
		// TODO: Check pending buffers
		if (!this.data) return null;
		if (!this.rowidToKeyMap && this.columns.length > 0 && this.primaryKeyColumnIndices.length > 0) {
			console.error(`MemoryTable ${this.tableName}: Attempt to find by rowid without rowidToKeyMap on a keyed table.`);
			return null;
		} else if (this.rowidToKeyMap) {
			const key = this.rowidToKeyMap.get(rowid);
			if (key === undefined) return null;
			const path = this.data.find(key);
			return (path.on && this.data.at(path)?._rowid_ === rowid) ? path : null;
		} else {
			const path = this.data.find(rowid);
			return path.on ? path : null;
		}
	}

	// --- Simple Accessors --- //
	get size(): number {
		// Note: This size doesn't reflect pending transaction buffers
		return this.data?.getCount() ?? 0;
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
	/* @internal */ _configureAsSorter(sortInfo: P4SortKey): void { Logic.configureAsSorterLogic(this, sortInfo); }
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
}


