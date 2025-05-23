import { BTree } from 'digitree';
import type { TableSchema } from '../../../schema/table.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, DeletionMarker } from '../types.js';
import type { Layer } from './interface.js';
import { MemoryIndex } from '../index.js';
import { isDeletionMarker } from '../types.js';
import { createLogger } from '../../../common/logger.js';
import { safeJsonStringify } from '../../../util/serialization.js';
import type { Row, SqlValue } from '../../../common/types.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { StatusCode } from '../../../common/types.js';
import { QuereusError } from '../../../common/errors.js';
import { type ColumnSchema } from '../../../schema/column.js';
import type { IndexSchema } from '../../../schema/table.js';
import type { MemoryIndexEntry } from '../types.js';

let baseLayerCounter = 0;
const log = createLogger('vtab:memory:layer:base');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

export function createBaseLayerPkFunctions(schema: TableSchema): {
	keyFromEntry: (row: Row) => BTreeKeyForPrimary;
	compareKeys: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;
} {
	const pkDef = schema.primaryKeyDefinition ?? [];
	if (pkDef.length === 0) {
		throw new QuereusError(`Table schema '${schema.name}' must have a primaryKeyDefinition for key-based operations.`, StatusCode.INTERNAL);
	}

	let keyFromEntry: (row: Row) => BTreeKeyForPrimary;
	let compareKeys: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;

	if (pkDef.length === 1) {
		const colDef = pkDef[0];
		const pkColIndex = colDef.index;
		const collation = colDef.collation || 'BINARY';
		const descMultiplier = colDef.desc ? -1 : 1;

		keyFromEntry = (row: Row): BTreeKeyForPrimary => {
			if (pkColIndex < 0 || pkColIndex >= row.length) throw new QuereusError(`PK index ${pkColIndex} OOB for row len ${row.length}`, StatusCode.INTERNAL);
			return row[pkColIndex];
		};
		compareKeys = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
			return compareSqlValues(a as SqlValue, b as SqlValue, collation) * descMultiplier;
		};
	} else { // Composite PK
		const pkColDefs = pkDef; // Array of PrimaryKeyColumnDefinition
		keyFromEntry = (row: Row): BTreeKeyForPrimary => {
			return pkColDefs.map(def => {
				if (def.index < 0 || def.index >= row.length) throw new QuereusError(`PK index ${def.index} OOB for row len ${row.length}`, StatusCode.INTERNAL);
				return row[def.index];
			});
		};
		compareKeys = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
			const arrA = a as SqlValue[];
			const arrB = b as SqlValue[];
			for (let i = 0; i < pkColDefs.length; i++) {
				if (i >= arrA.length || i >= arrB.length) return arrA.length - arrB.length;
				const def = pkColDefs[i];
				const cmp = compareSqlValues(arrA[i], arrB[i], def.collation || 'BINARY');
				if (cmp !== 0) return def.desc ? -cmp : cmp;
			}
			return 0;
		};
	}
	return { keyFromEntry, compareKeys };
}

export class BaseLayer implements Layer {
	private readonly layerId: number;
	public tableSchema: TableSchema;
	private _keyFromEntry!: (row: Row) => BTreeKeyForPrimary;
	private _compareKeys!: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;
	public primaryTree: BTree<BTreeKeyForPrimary, Row>;
	public readonly secondaryIndexes: Map<string, MemoryIndex>;

	constructor(schema: TableSchema) {
		this.layerId = baseLayerCounter++;
		this.tableSchema = schema;
		this.reinitializePkFunctions();
		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(this._keyFromEntry, this._compareKeys);
		this.secondaryIndexes = new Map();
		this.rebuildAllSecondaryIndexes();
	}

	public updateSchema(newSchema: TableSchema): void {
		log(`BaseLayer for ${this.tableSchema.name}: Schema being updated to reflect ${newSchema.name}`);
		this.tableSchema = newSchema;
		this.reinitializePkFunctions();
	}

	private reinitializePkFunctions(): void {
		if (!this.tableSchema.primaryKeyDefinition || this.tableSchema.primaryKeyDefinition.length === 0) {
			throw new QuereusError(`Table '${this.tableSchema.name}' must have a primaryKeyDefinition.`, StatusCode.INTERNAL);
		}
		const pkFuncs = createBaseLayerPkFunctions(this.tableSchema);
		this._keyFromEntry = pkFuncs.keyFromEntry;
		this._compareKeys = pkFuncs.compareKeys;
	}

	private async rebuildAllSecondaryIndexes(): Promise<void> {
		this.secondaryIndexes.forEach(index => index.clear());
		if (!this.tableSchema.indexes || this.tableSchema.indexes.length === 0) return;

		const newSecondaryIndexes = new Map<string, MemoryIndex>();
		for (const indexSchema of this.tableSchema.indexes) {
			try {
				newSecondaryIndexes.set(indexSchema.name, new MemoryIndex(indexSchema, this.tableSchema.columns));
			} catch (e: any) {
				errorLog(`BaseLayer.rebuildAllSecondaryIndexes: Error creating index '${indexSchema.name}': ${e.message}`);
			}
		}
		this.secondaryIndexes.clear();
		newSecondaryIndexes.forEach((idx, name) => this.secondaryIndexes.set(name, idx));

		const firstPath = this.primaryTree.first();
		if (firstPath) {
			const iterator = this.primaryTree.ascending(firstPath);
			for (const path of iterator) {
				const currentRow = this.primaryTree.at(path);
				if (currentRow) {
					const primaryKey = this._keyFromEntry(currentRow);
					this.secondaryIndexes.forEach(index => {
						try {
							const indexKey = index.keyFromRow(currentRow);
							index.addEntry(indexKey, primaryKey);
						} catch (e: any) {
							errorLog(`BaseLayer.rebuildAllSecondaryIndexes: Error re-indexing row for index '${index.name}': ${e.message}`);
						}
					});
				}
			}
		}
	}

	getLayerId = (): number => this.layerId;
	getParent = (): Layer | null => null;
	getSchema = (): TableSchema => this.tableSchema;
	isCommitted = (): boolean => true;
	getModificationTree = (indexName: string | 'primary'): BTree<BTreeKeyForPrimary, Row> | null => indexName === 'primary' ? this.primaryTree : null;
	getSecondaryIndexTree = (indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null => this.secondaryIndexes.get(indexName)?.data ?? null;

	public getPkExtractorsAndComparators(schema: TableSchema): {
		primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number
	} {
		if (schema !== this.tableSchema) {
			warnLog("BaseLayer.getPkExtractorsAndComparators called with a schema different from its own.");
		}
		return { primaryKeyExtractorFromRow: this._keyFromEntry, primaryKeyComparator: this._compareKeys };
	}

	applyChange(
		primaryKey: BTreeKeyForPrimary,
		modification: Row | DeletionMarker,
		secondaryIndexChanges: Map<string, Array<{op: 'ADD' | 'DELETE', indexKey: BTreeKeyForIndex}>>
	): void {
		const isDeleteOperation = isDeletionMarker(modification);
		const newRowData = isDeleteOperation ? null : (modification as Row);

		secondaryIndexChanges.forEach((changes, indexName) => {
			const memoryIndex = this.secondaryIndexes.get(indexName);
			if (!memoryIndex) {
				warnLog(`BaseLayer.applyChange: Secondary index '${indexName}' not found. PK: ${safeJsonStringify(primaryKey)}.`);
				return;
			}
			changes.forEach(change => {
				if (change.op === 'DELETE') {
					memoryIndex.removeEntry(change.indexKey, primaryKey);
				} else { // ADD
					memoryIndex.addEntry(change.indexKey, primaryKey);
				}
			});
		});

		if (isDeleteOperation) {
			const path = this.primaryTree.find(primaryKey);
			if (path.on) {
				this.primaryTree.deleteAt(path);
			} else {
				warnLog(`BaseLayer.applyChange: Attempted to delete non-existent primary key ${safeJsonStringify(primaryKey)}.`);
			}
		} else if (newRowData) {
			this.primaryTree.insert(newRowData);
		}
	}

	has = (key: BTreeKeyForPrimary): boolean => this.primaryTree.get(key) !== undefined;

	async addColumnToBase(newColumnSchema: ColumnSchema, defaultValue: SqlValue): Promise<void> {
		log(`BaseLayer for ${this.tableSchema.name}: Adding column '${newColumnSchema.name}'.`);
		const oldPrimaryTree = this.primaryTree;
		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(this._keyFromEntry, this._compareKeys);

		const firstPath = oldPrimaryTree.first();
		if (firstPath) {
			const iterator = oldPrimaryTree.ascending(firstPath);
			for (const path of iterator) {
				const oldRow = oldPrimaryTree.at(path);
				if (oldRow) {
					const newRow = [...oldRow, defaultValue];
					this.primaryTree.insert(newRow);
				}
			}
		}
		await this.rebuildAllSecondaryIndexes();
	}

	async dropColumnFromBase(columnIndexInOldSchema: number): Promise<void> {
		log(`BaseLayer for ${this.tableSchema.name}: Dropping column at old index ${columnIndexInOldSchema}.`);
		const oldPrimaryTree = this.primaryTree;
		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(this._keyFromEntry, this._compareKeys);

		const firstPath = oldPrimaryTree.first();
		if (firstPath) {
			const iterator = oldPrimaryTree.ascending(firstPath);
			for (const path of iterator) {
				const oldRow = oldPrimaryTree.at(path);
				if (oldRow) {
					const newRow = oldRow.filter((_, idx) => idx !== columnIndexInOldSchema);
					this.primaryTree.insert(newRow);
				}
			}
		}
		await this.rebuildAllSecondaryIndexes();
	}

	async handleColumnRename(): Promise<void> {
		log(`BaseLayer for ${this.tableSchema.name}: Handling column rename. Rebuilding secondary indexes.`);
		await this.rebuildAllSecondaryIndexes();
	}

	async addIndexToBase(indexSchema: IndexSchema): Promise<void> {
		log(`BaseLayer for ${this.tableSchema.name}: Adding index '${indexSchema.name}'.`);
		const newMemoryIndex = new MemoryIndex(indexSchema, this.tableSchema.columns);
		const firstPath = this.primaryTree.first();
		if (firstPath) {
			const iterator = this.primaryTree.ascending(firstPath);
			for (const path of iterator) {
				const currentRow = this.primaryTree.at(path);
				if (currentRow) {
					try {
						const indexKey = newMemoryIndex.keyFromRow(currentRow);
						const primaryKey = this._keyFromEntry(currentRow);
						newMemoryIndex.addEntry(indexKey, primaryKey);
					} catch (e: any) {
						errorLog(`BaseLayer.addIndexToBase: Error populating index '${indexSchema.name}' for a row: ${e.message}`);
					}
				}
			}
		}
		this.secondaryIndexes.set(indexSchema.name, newMemoryIndex);
	}

	async dropIndexFromBase(indexName: string): Promise<void> {
		if (this.secondaryIndexes.delete(indexName)) {
			log(`BaseLayer for ${this.tableSchema.name}: Dropped index '${indexName}'.`);
		} else {
			warnLog(`BaseLayer.dropIndexFromBase: Attempted to drop non-existent index '${indexName}'.`);
		}
	}
}
