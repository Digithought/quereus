import { BTree } from 'digitree';
import type { Row, SqlValue } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex } from './types.js';
import { createLogger } from '../../common/logger.js';
import type { IndexColumnSchema as IndexColumnSpec } from '../../schema/table.js'; // Renamed for clarity
import type { ColumnSchema } from '../../schema/column.js';

const log = createLogger('vtab:memory:index');
const errorLog = log.extend('error');

/** Definition for creating a memory index (matches IndexSchema columns usually) */
export interface IndexSpec {
	name?: string;
	columns: ReadonlyArray<IndexColumnSpec>;
}

interface MemoryIndexEntry {
	indexKey: BTreeKeyForIndex;
	primaryKeys: BTreeKeyForPrimary[];
}

/** Represents a secondary index within a MemoryTable */
export class MemoryIndex {
	public readonly name: string | undefined;
	public readonly specColumns: ReadonlyArray<IndexColumnSpec>;
	public readonly keyFromRow: (row: Row) => BTreeKeyForIndex;
	public readonly compareKeys: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
	public data: BTree<BTreeKeyForIndex, MemoryIndexEntry>;

	constructor(spec: IndexSpec, allTableColumnsSchema: ReadonlyArray<ColumnSchema>) {
		this.name = spec.name;
		this.specColumns = Object.freeze(spec.columns.map(c => ({ ...c })));

		if (this.specColumns.some(sc => sc.index < 0 || sc.index >= allTableColumnsSchema.length)) {
			throw new Error(`Invalid column index in index '${this.name ?? '(unnamed)'}'.`);
		}

		if (this.specColumns.length === 1) {
			const specCol = this.specColumns[0];
			const colSchemaIndex = specCol.index;
			const collation = specCol.collation || 'BINARY';
			const descMultiplier = specCol.desc ? -1 : 1;

			this.keyFromRow = (row: Row): BTreeKeyForIndex => {
				if (colSchemaIndex < 0 || colSchemaIndex >= row.length) throw new Error(`Index key col index ${colSchemaIndex} OOB for row len ${row.length}`);
				return row[colSchemaIndex];
			}
			this.compareKeys = (a: BTreeKeyForIndex, b: BTreeKeyForIndex): number => {
				return compareSqlValues(a as SqlValue, b as SqlValue, collation) * descMultiplier;
			};
		} else {
			const localSpecColumns = this.specColumns;
			this.keyFromRow = (row: Row): BTreeKeyForIndex => {
				return localSpecColumns.map(sc => {
					if (sc.index < 0 || sc.index >= row.length) throw new Error(`Index key col index ${sc.index} OOB for row len ${row.length}`);
					return row[sc.index];
				});
			}
			this.compareKeys = (a: BTreeKeyForIndex, b: BTreeKeyForIndex): number => {
				const arrA = a as SqlValue[];
				const arrB = b as SqlValue[];
				for (let i = 0; i < localSpecColumns.length; i++) {
					if (i >= arrA.length || i >= arrB.length) return arrA.length - arrB.length;
					const specCol = localSpecColumns[i];
					const cmp = compareSqlValues(arrA[i], arrB[i], specCol.collation || 'BINARY');
					if (cmp !== 0) return specCol.desc ? -cmp : cmp;
				}
				return 0;
			};
		}

		this.data = new BTree<BTreeKeyForIndex, MemoryIndexEntry>(
			(entry: MemoryIndexEntry) => entry.indexKey,
			this.compareKeys
		);
	}

	addEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		let entry = this.data.get(indexKey);
		if (!entry) {
			entry = { indexKey: indexKey, primaryKeys: [primaryKey] };
			this.data.insert(entry);
		} else {
			const pkExists = entry.primaryKeys.some(existingPk =>
				this.comparePrimaryKeysGlobally(existingPk, primaryKey) === 0
			);
			if (!pkExists) {
				entry.primaryKeys.push(primaryKey);
				this.data.insert(entry);
			}
		}
	}

	removeEntry(indexKey: BTreeKeyForIndex, primaryKeyToRemove: BTreeKeyForPrimary): boolean {
		const path = this.data.find(indexKey);
		if (path.on) {
			const entry = this.data.at(path);
			if (entry) {
				const initialLength = entry.primaryKeys.length;
				entry.primaryKeys = entry.primaryKeys.filter(pk =>
					this.comparePrimaryKeysGlobally(pk, primaryKeyToRemove) !== 0
				);

				if (entry.primaryKeys.length === 0) {
					this.data.deleteAt(path);
				} else if (entry.primaryKeys.length < initialLength) {
					this.data.insert(entry);
				}
				return entry.primaryKeys.length < initialLength;
			}
		}
		return false;
	}

	private comparePrimaryKeysGlobally(pkA: BTreeKeyForPrimary, pkB: BTreeKeyForPrimary): number {
		if (Array.isArray(pkA) && Array.isArray(pkB)) {
			if (pkA.length !== pkB.length) return pkA.length - pkB.length;
			for (let i = 0; i < pkA.length; i++) {
				const cmp = compareSqlValues(pkA[i], pkB[i]);
				if (cmp !== 0) return cmp;
			}
			return 0;
		} else if (!Array.isArray(pkA) && !Array.isArray(pkB)) {
			return compareSqlValues(pkA as SqlValue, pkB as SqlValue);
		}
		return Array.isArray(pkA) ? 1 : -1;
	}

	clear(): void {
		this.data = new BTree<BTreeKeyForIndex, MemoryIndexEntry>(
			(entry: MemoryIndexEntry) => entry.indexKey,
			this.compareKeys
		);
	}

	get size(): number {
		return this.data.getCount();
	}
}
