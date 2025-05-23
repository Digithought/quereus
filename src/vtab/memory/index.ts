import { BTree } from 'inheritree';
import type { Row, SqlValue } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from './types.js';
import type { IndexColumnSchema as IndexColumnSpec } from '../../schema/table.js'; // Renamed for clarity
import type { ColumnSchema } from '../../schema/column.js';
import { createMemoryTableLoggers } from './utils/logging.js';

const logger = createMemoryTableLoggers('index');

/** Definition for creating a memory index (matches IndexSchema columns usually) */
export interface IndexSpec {
	name?: string;
	columns: ReadonlyArray<IndexColumnSpec>;
}

/** Functions for extracting and comparing index keys */
interface IndexKeyFunctions {
	keyFromRow: (row: Row) => BTreeKeyForIndex;
	compareKeys: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
}

/** Represents a secondary index within a MemoryTable */
export class MemoryIndex {
	public readonly name: string | undefined;
	public readonly specColumns: ReadonlyArray<IndexColumnSpec>;
	public readonly keyFromRow: (row: Row) => BTreeKeyForIndex;
	public readonly compareKeys: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
	public data: BTree<BTreeKeyForIndex, MemoryIndexEntry>;

	constructor(spec: IndexSpec, allTableColumnsSchema: ReadonlyArray<ColumnSchema>, baseInheritreeTable?: BTree<BTreeKeyForIndex, MemoryIndexEntry>) {
		this.name = spec.name;
		this.specColumns = Object.freeze(spec.columns.map(c => ({ ...c })));

		this.validateColumnIndexes(allTableColumnsSchema);

		const keyFunctions = this.createIndexKeyFunctions();
		this.keyFromRow = keyFunctions.keyFromRow;
		this.compareKeys = keyFunctions.compareKeys;

		this.data = this.createBTree(baseInheritreeTable);
	}

	private validateColumnIndexes(allTableColumnsSchema: ReadonlyArray<ColumnSchema>): void {
		const hasInvalidIndex = this.specColumns.some(sc =>
			sc.index < 0 || sc.index >= allTableColumnsSchema.length
		);

		if (hasInvalidIndex) {
			throw new Error(`Invalid column index in index '${this.name ?? '(unnamed)'}'.`);
		}
	}

	private createIndexKeyFunctions(): IndexKeyFunctions {
		if (this.specColumns.length === 1) {
			return this.createSingleColumnKeyFunctions();
		} else {
			return this.createCompositeColumnKeyFunctions();
		}
	}

	private createSingleColumnKeyFunctions(): IndexKeyFunctions {
		const specCol = this.specColumns[0];
		const colSchemaIndex = specCol.index;
		const collation = specCol.collation || 'BINARY';
		const descMultiplier = specCol.desc ? -1 : 1;

		const keyFromRow = (row: Row): BTreeKeyForIndex => {
			this.validateRowLength(row, colSchemaIndex);
			return row[colSchemaIndex];
		};

		const compareKeys = (a: BTreeKeyForIndex, b: BTreeKeyForIndex): number => {
			return compareSqlValues(a as SqlValue, b as SqlValue, collation) * descMultiplier;
		};

		return { keyFromRow, compareKeys };
	}

	private createCompositeColumnKeyFunctions(): IndexKeyFunctions {
		const localSpecColumns = this.specColumns;

		const keyFromRow = (row: Row): BTreeKeyForIndex => {
			return localSpecColumns.map(sc => {
				this.validateRowLength(row, sc.index);
				return row[sc.index];
			});
		};

		const compareKeys = (a: BTreeKeyForIndex, b: BTreeKeyForIndex): number => {
			const arrA = a as SqlValue[];
			const arrB = b as SqlValue[];

			for (let i = 0; i < localSpecColumns.length; i++) {
				if (i >= arrA.length || i >= arrB.length) {
					return arrA.length - arrB.length;
				}

				const specCol = localSpecColumns[i];
				const comparison = compareSqlValues(arrA[i], arrB[i], specCol.collation || 'BINARY');

				if (comparison !== 0) {
					return specCol.desc ? -comparison : comparison;
				}
			}
			return 0;
		};

		return { keyFromRow, compareKeys };
	}

	private validateRowLength(row: Row, columnIndex: number): void {
		if (columnIndex < 0 || columnIndex >= row.length) {
			throw new Error(`Index key col index ${columnIndex} OOB for row len ${row.length}`);
		}
	}

	private createBTree(baseInheritreeTable?: BTree<BTreeKeyForIndex, MemoryIndexEntry>): BTree<BTreeKeyForIndex, MemoryIndexEntry> {
		return new BTree<BTreeKeyForIndex, MemoryIndexEntry>(
			(entry: MemoryIndexEntry) => entry.indexKey,
			this.compareKeys,
			baseInheritreeTable
		);
	}

	addEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const existingEntry = this.data.get(indexKey);

		if (!existingEntry) {
			this.createNewIndexEntry(indexKey, primaryKey);
		} else {
			this.addToPrimaryKeysIfNotExists(existingEntry, indexKey, primaryKey);
		}
	}

	private createNewIndexEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const newEntry: MemoryIndexEntry = {
			indexKey: indexKey,
			primaryKeys: [primaryKey]
		};
		this.data.insert(newEntry);
	}

	private addToPrimaryKeysIfNotExists(
		existingEntry: MemoryIndexEntry,
		indexKey: BTreeKeyForIndex,
		primaryKey: BTreeKeyForPrimary
	): void {
		const pkExists = existingEntry.primaryKeys.some(existingPk =>
			this.comparePrimaryKeysGlobally(existingPk, primaryKey) === 0
		);

		if (!pkExists) {
			const updatedEntry: MemoryIndexEntry = {
				...existingEntry,
				primaryKeys: [...existingEntry.primaryKeys, primaryKey]
			};
			this.data.insert(updatedEntry);
		}
	}

	removeEntry(indexKey: BTreeKeyForIndex, primaryKeyToRemove: BTreeKeyForPrimary): boolean {
		const currentEntry = this.data.get(indexKey);
		if (!currentEntry) return false;

		const filteredPrimaryKeys = this.filterOutPrimaryKey(currentEntry.primaryKeys, primaryKeyToRemove);

		if (filteredPrimaryKeys.length === currentEntry.primaryKeys.length) {
			return false; // No removal occurred
		}

		this.updateOrDeleteIndexEntry(indexKey, currentEntry, filteredPrimaryKeys);
		return true;
	}

	private filterOutPrimaryKey(
		primaryKeys: BTreeKeyForPrimary[],
		primaryKeyToRemove: BTreeKeyForPrimary
	): BTreeKeyForPrimary[] {
		return primaryKeys.filter(pk =>
			this.comparePrimaryKeysGlobally(pk, primaryKeyToRemove) !== 0
		);
	}

	private updateOrDeleteIndexEntry(
		indexKey: BTreeKeyForIndex,
		currentEntry: MemoryIndexEntry,
		newPrimaryKeys: BTreeKeyForPrimary[]
	): void {
		if (newPrimaryKeys.length === 0) {
			this.data.deleteAt(this.data.find(indexKey));
		} else {
			const updatedEntry: MemoryIndexEntry = {
				...currentEntry,
				primaryKeys: newPrimaryKeys
			};
			this.data.insert(updatedEntry);
		}
	}

	private comparePrimaryKeysGlobally(pkA: BTreeKeyForPrimary, pkB: BTreeKeyForPrimary): number {
		if (Array.isArray(pkA) && Array.isArray(pkB)) {
			return this.compareArrayPrimaryKeys(pkA, pkB);
		} else if (!Array.isArray(pkA) && !Array.isArray(pkB)) {
			return compareSqlValues(pkA as SqlValue, pkB as SqlValue);
		}

		// Mixed array/non-array case
		return Array.isArray(pkA) ? 1 : -1;
	}

	private compareArrayPrimaryKeys(pkA: SqlValue[], pkB: SqlValue[]): number {
		if (pkA.length !== pkB.length) {
			return pkA.length - pkB.length;
		}

		for (let i = 0; i < pkA.length; i++) {
			const comparison = compareSqlValues(pkA[i], pkB[i]);
			if (comparison !== 0) return comparison;
		}

		return 0;
	}

	clear(): void {
		const base = (this.data as any).baseTable as BTree<BTreeKeyForIndex, MemoryIndexEntry> | undefined;
		this.data = this.createBTree(base);
	}

	/**
	 * Detaches this index's Inheritree from its base, making it self-contained.
	 */
	public clearBase(): void {
		if (typeof (this.data as any).clearBase === 'function') {
			(this.data as any).clearBase();
		} else {
			logger.warn('Clear Base', this.name || 'unnamed', 'Inheritree instance does not have a clearBase method');
		}
	}

	get size(): number {
		return this.data.getCount();
	}
}
