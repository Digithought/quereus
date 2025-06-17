import { BTree } from 'inheritree';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from './types.js';
import type { IndexColumnSchema as IndexColumnSpec } from '../../schema/table.js'; // Renamed for clarity
import type { ColumnSchema } from '../../schema/column.js';
import { quereusError } from '../../common/errors.js';

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
			quereusError(`Invalid column index in index '${this.name ?? '(unnamed)'}'.`, StatusCode.INTERNAL);
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
			quereusError(`Index key col index ${columnIndex} OOB for row len ${row.length}`, StatusCode.INTERNAL);
		}
	}

	private createBTree(baseInheritreeTable?: BTree<BTreeKeyForIndex, MemoryIndexEntry>): BTree<BTreeKeyForIndex, MemoryIndexEntry> {
		return new BTree<BTreeKeyForIndex, MemoryIndexEntry>(
			(entry: MemoryIndexEntry) => entry.indexKey,
			this.compareKeys,
			baseInheritreeTable
		);
	}

	/** Adds a mapping from index key to primary key */
	addEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const path = this.data.find(indexKey);
		if (path.on) {
			// Entry exists, add to the existing set of primary keys
			const existingEntry = this.data.at(path)!;
			existingEntry.primaryKeys.add(primaryKey);
		} else {
			// Create new entry with a Set containing the primary key
			const newEntry: MemoryIndexEntry = {
				indexKey,
				primaryKeys: new Set([primaryKey])
			};
			this.data.insert(newEntry);
		}
	}

	/** Removes a mapping from index key to primary key */
	removeEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const path = this.data.find(indexKey);
		if (path.on) {
			const entry = this.data.at(path)!;
			entry.primaryKeys.delete(primaryKey);

			// If no primary keys remain, remove the entire entry
			if (entry.primaryKeys.size === 0) {
				this.data.deleteAt(path);
			}
		}
	}

	/** Returns the primary keys for a given index key */
	getPrimaryKeys(indexKey: BTreeKeyForIndex): BTreeKeyForPrimary[] {
		const entry = this.data.get(indexKey);
		return entry ? Array.from(entry.primaryKeys) : [];
	}

	/** Gets the count of unique index values */
	get size(): number {
		return this.data.getCount();
	}

	/** Clears all entries from the index */
	clear(): void {
		const base = (this.data as any).baseTable as BTree<BTreeKeyForIndex, MemoryIndexEntry> | undefined;
		this.data = this.createBTree(base);
	}

	/** Clears the base inheritance for this index (used during layer collapse) */
	clearBase(): void {
		if (typeof (this.data as any).clearBase === 'function') {
			(this.data as any).clearBase();
		}
	}
}
