import { BTree } from 'inheritree';
import type { TableSchema } from '../../../schema/table.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import type { Layer } from './interface.js';
import { MemoryIndex } from '../index.js';
import { safeJsonStringify } from '../../../util/serialization.js';
import type { Row, SqlValue } from '../../../common/types.js';
import { type ColumnSchema } from '../../../schema/column.js';
import type { IndexSchema } from '../../../schema/table.js';
import { createPrimaryKeyFunctions, type PrimaryKeyFunctions } from '../utils/primary-key.js';
import { createMemoryTableLoggers } from '../utils/logging.js';

let baseLayerCounter = 0;
const logger = createMemoryTableLoggers('layer:base');

export class BaseLayer implements Layer {
	private readonly layerId: number;
	public tableSchema: TableSchema;
	private primaryKeyFunctions!: PrimaryKeyFunctions;
	public primaryTree: BTree<BTreeKeyForPrimary, Row>;
	public readonly secondaryIndexes: Map<string, MemoryIndex>;

	constructor(schema: TableSchema) {
		this.layerId = baseLayerCounter++;
		this.tableSchema = schema;
		this.initializePrimaryKeyFunctions();

		// Use the same key extraction pattern as TransactionLayer for consistency
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);
		this.secondaryIndexes = new Map();
		this.rebuildAllSecondaryIndexes();
	}

	public updateSchema(newSchema: TableSchema): void {
		logger.operation('Schema Update', this.tableSchema.name, {
			from: this.tableSchema.name,
			to: newSchema.name
		});
		this.tableSchema = newSchema;
		this.initializePrimaryKeyFunctions();
	}

	private initializePrimaryKeyFunctions(): void {
		this.primaryKeyFunctions = createPrimaryKeyFunctions(this.tableSchema);
	}

	public async rebuildAllSecondaryIndexes(): Promise<void> {
		this.clearExistingSecondaryIndexes();

		if (!this.hasSecondaryIndexes()) {
			return;
		}

		const newIndexes = this.createSecondaryIndexes();
		this.populateSecondaryIndexes(newIndexes);
		this.replaceSecondaryIndexes(newIndexes);
	}

	private clearExistingSecondaryIndexes(): void {
		this.secondaryIndexes.forEach(index => index.clear());
	}

	private hasSecondaryIndexes(): boolean {
		return Boolean(this.tableSchema.indexes && this.tableSchema.indexes.length > 0);
	}

	private createSecondaryIndexes(): Map<string, MemoryIndex> {
		const newIndexes = new Map<string, MemoryIndex>();

		for (const indexSchema of this.tableSchema.indexes!) {
			try {
				const memoryIndex = new MemoryIndex(indexSchema, this.tableSchema.columns);
				newIndexes.set(indexSchema.name, memoryIndex);
			} catch (e: any) {
				logger.error('Create Index', this.tableSchema.name, e, { indexName: indexSchema.name });
			}
		}

		return newIndexes;
	}

	private populateSecondaryIndexes(newIndexes: Map<string, MemoryIndex>): void {
		const firstPath = this.primaryTree.first();
		if (!firstPath) return;

		const iterator = this.primaryTree.ascending(firstPath);
		for (const path of iterator) {
			const currentValue = this.primaryTree.at(path);
			if (currentValue) {
				const currentRow = currentValue as Row;
				this.addRowToSecondaryIndexes(currentRow, newIndexes);
			}
		}
	}

	private addRowToSecondaryIndexes(row: Row, indexes: Map<string, MemoryIndex>): void {
		const primaryKey = this.primaryKeyFunctions.extractFromRow(row);

		indexes.forEach(index => {
			try {
				const indexKey = index.keyFromRow(row);
				index.addEntry(indexKey, primaryKey);
			} catch (e: any) {
				logger.error('Re-index Row', this.tableSchema.name, e, { indexName: index.name });
			}
		});
	}

	private replaceSecondaryIndexes(newIndexes: Map<string, MemoryIndex>): void {
		this.secondaryIndexes.clear();
		newIndexes.forEach((idx, name) => this.secondaryIndexes.set(name, idx));
	}

	getLayerId = (): number => this.layerId;
	getParent = (): Layer | null => null;
	getSchema = (): TableSchema => this.tableSchema;
	isCommitted = (): boolean => true;

	getModificationTree = (indexName: string | 'primary'): BTree<BTreeKeyForPrimary, Row> | null =>
		indexName === 'primary' ? this.primaryTree : null;

	getSecondaryIndexTree = (indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null =>
		this.secondaryIndexes.get(indexName)?.data ?? null;

	public getPkExtractorsAndComparators(schema: TableSchema): {
		primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number
	} {
		if (schema !== this.tableSchema) {
			logger.warn('PK Extractors', this.tableSchema.name, 'Called with different schema');
		}
		return {
			primaryKeyExtractorFromRow: this.primaryKeyFunctions.extractFromRow,
			primaryKeyComparator: this.primaryKeyFunctions.compare
		};
	}

	applyChange(
		primaryKey: BTreeKeyForPrimary,
		modification: Row,
		secondaryIndexChanges: Map<string, Array<{op: 'ADD' | 'DELETE', indexKey: BTreeKeyForIndex}>>
	): void {
		this.applySecondaryIndexChanges(primaryKey, secondaryIndexChanges);
		this.applyPrimaryChange(primaryKey, modification);
	}

	private applySecondaryIndexChanges(
		primaryKey: BTreeKeyForPrimary,
		secondaryIndexChanges: Map<string, Array<{op: 'ADD' | 'DELETE', indexKey: BTreeKeyForIndex}>>
	): void {
		secondaryIndexChanges.forEach((changes, indexName) => {
			const memoryIndex = this.secondaryIndexes.get(indexName);
			if (!memoryIndex) {
				logger.warn('Apply Change', this.tableSchema.name, 'Secondary index not found', {
					indexName,
					primaryKey: safeJsonStringify(primaryKey)
				});
				return;
			}

			changes.forEach(change => {
				if (change.op === 'DELETE') {
					memoryIndex.removeEntry(change.indexKey, primaryKey);
				} else {
					memoryIndex.addEntry(change.indexKey, primaryKey);
				}
			});
		});
	}

	private applyPrimaryChange(primaryKey: BTreeKeyForPrimary, modification: Row): void {
		this.primaryTree.insert(modification);
	}

	has = (key: BTreeKeyForPrimary): boolean => {
		const value = this.primaryTree.get(key);
		return value !== undefined;
	};

	async addColumnToBase(newColumnSchema: ColumnSchema, defaultValue: SqlValue): Promise<void> {
		logger.operation('Add Column', this.tableSchema.name, {
			columnName: newColumnSchema.name,
			defaultValue
		});

		const oldPrimaryTree = this.primaryTree;

		// First, reinitialize primary key functions with the updated schema (which already includes the new column)
		this.initializePrimaryKeyFunctions();

		// Create new primary tree with the updated schema and migrate data
		this.recreatePrimaryTreeWithNewColumn(oldPrimaryTree, defaultValue);

		await this.rebuildAllSecondaryIndexes();
	}

	private recreatePrimaryTreeWithNewColumn(
		oldTree: BTree<BTreeKeyForPrimary, Row>,
		defaultValue: SqlValue
	): void {
		// Use the updated primary key functions for the new tree
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);

		const firstPath = oldTree.first();
		if (!firstPath) return;

		const iterator = oldTree.ascending(firstPath);
		for (const path of iterator) {
			const oldValue = oldTree.at(path);
			if (oldValue) {
				const oldRow = oldValue as Row;
				const newRow = [...oldRow, defaultValue];
				this.primaryTree.insert(newRow);
			}
		}
	}

	async dropColumnFromBase(columnIndexInOldSchema: number): Promise<void> {
		logger.operation('Drop Column', this.tableSchema.name, {
			columnIndex: columnIndexInOldSchema
		});

		const oldPrimaryTree = this.primaryTree;
		this.recreatePrimaryTreeWithoutColumn(oldPrimaryTree, columnIndexInOldSchema);
		await this.rebuildAllSecondaryIndexes();
	}

	private recreatePrimaryTreeWithoutColumn(oldTree: BTree<BTreeKeyForPrimary, Row>, columnIndex: number): void {
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);

		const firstPath = oldTree.first();
		if (!firstPath) return;

		const iterator = oldTree.ascending(firstPath);
		for (const path of iterator) {
			const oldValue = oldTree.at(path);
			if (oldValue) {
				const oldRow = oldValue as Row;
				const newRow = oldRow.filter((_, idx) => idx !== columnIndex);
				this.primaryTree.insert(newRow);
			}
		}
	}

	async handleColumnRename(): Promise<void> {
		logger.operation('Handle Column Rename', this.tableSchema.name);
		await this.rebuildAllSecondaryIndexes();
	}

	async addIndexToBase(indexSchema: IndexSchema): Promise<void> {
		logger.operation('Add Index', this.tableSchema.name, {
			indexName: indexSchema.name
		});

		const newMemoryIndex = new MemoryIndex(indexSchema, this.tableSchema.columns);
		this.populateNewIndex(newMemoryIndex);
		this.secondaryIndexes.set(indexSchema.name, newMemoryIndex);
	}

	private populateNewIndex(newIndex: MemoryIndex): void {
		const firstPath = this.primaryTree.first();
		if (!firstPath) return;

		const iterator = this.primaryTree.ascending(firstPath);
		for (const path of iterator) {
			const currentValue = this.primaryTree.at(path);
			if (currentValue) {
				const currentRow = currentValue as Row;
				try {
					const indexKey = newIndex.keyFromRow(currentRow);
					const primaryKey = this.primaryKeyFunctions.extractFromRow(currentRow);
					newIndex.addEntry(indexKey, primaryKey);
				} catch (e: any) {
					logger.error('Populate Index', this.tableSchema.name, e, {
						indexName: newIndex.name
					});
				}
			}
		}
	}

	async dropIndexFromBase(indexName: string): Promise<void> {
		if (this.secondaryIndexes.delete(indexName)) {
			logger.operation('Drop Index', this.tableSchema.name, { indexName });
		} else {
			logger.warn('Drop Index', this.tableSchema.name, 'Index not found', { indexName });
		}
	}
}
