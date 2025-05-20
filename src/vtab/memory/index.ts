import { BTree } from 'digitree';
import type { RowIdRow, SqlValue } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { BTreeKey } from './types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('vtab:memory:index');
const errorLog = log.extend('error');

/** Definition for creating a memory index */
export interface IndexSpec {
	name?: string;
	columns: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>;
	// unique?: boolean; // Future extension
}

/** Represents a secondary index within a MemoryTable */
export class MemoryIndex {
	public readonly name: string | undefined;
	public readonly specColumns: IndexSpec['columns']; // Store original spec columns
	public readonly keyFromRow: (rowTuple: RowIdRow) => BTreeKey;
	public readonly compareKeys: (a: BTreeKey, b: BTreeKey) => number;
	public data: BTree<[BTreeKey, bigint], [BTreeKey, bigint]>;

	constructor(spec: IndexSpec, allTableColumns: ReadonlyArray<{ name: string }>) {
		this.name = spec.name;
		this.specColumns = Object.freeze(spec.columns.map(c => ({ ...c }))); // Store a copy

		// Validate column indices based on allTableColumns.length (which represents the number of data columns)
		if (this.specColumns.some(sc => sc.index < 0 || sc.index >= allTableColumns.length)) {
			throw new Error(`Invalid column index specified in index definition '${this.name ?? '(unnamed)'}'. Index spec: ${JSON.stringify(this.specColumns)}, Table columns count: ${allTableColumns.length}`);
		}

		// --- Key Generation and Comparison Logic --- (Operates on RowIdRow = [rowid, data_array])
		if (this.specColumns.length === 1) {
			// Single column index
			const specCol = this.specColumns[0];
			const colSchemaIndex = specCol.index;
			const isDesc = specCol.desc;
			const collation = specCol.collation ?? 'BINARY';
			this.keyFromRow = (rowTuple) => rowTuple[1][colSchemaIndex] as BTreeKey;
			this.compareKeys = (a: BTreeKey, b: BTreeKey): number => {
				const cmp = compareSqlValues(a as SqlValue, b as SqlValue, collation);
				return isDesc ? -cmp : cmp;
			};
		} else {
			// Composite key index
			this.keyFromRow = (rowTuple) => this.specColumns.map(sc => rowTuple[1][sc.index]);
			this.compareKeys = (a: BTreeKey, b: BTreeKey): number => {
				const arrA = a as SqlValue[];
				const arrB = b as SqlValue[];
				const len = Math.min(arrA.length, arrB.length, this.specColumns.length);
				for (let i = 0; i < len; i++) {
					const specCol = this.specColumns[i];
					const dirMultiplier = specCol.desc ? -1 : 1;
					const collation = specCol.collation ?? 'BINARY';
					const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
					if (cmp !== 0) return cmp;
				}
				return arrA.length - arrB.length;
			};
		}

		const originalCompareKeys = this.compareKeys;
		this.data = new BTree<[BTreeKey, bigint], [BTreeKey, bigint]>(
			(value: [BTreeKey, bigint]) => value,
			(a: [BTreeKey, bigint], b: [BTreeKey, bigint]) => originalCompareKeys(a[0], b[0])
		);
	}

	addEntry(rowTuple: RowIdRow): void {
		const key = this.keyFromRow(rowTuple);
		const rowid = rowTuple[0]; // Get rowid from the tuple
		try {
			this.data.insert([key, rowid]);
		} catch (e) {
			errorLog(`Error adding entry to index '%s' for rowid %s: %O`, this.name ?? '(unnamed)', rowid, e);
			throw new Error(`Failed to add entry to index '${this.name ?? '(unnamed)'}'.`);
		}
	}

	removeEntry(rowTuple: RowIdRow): boolean {
		const key = this.keyFromRow(rowTuple);
		const rowid = rowTuple[0]; // Get rowid from the tuple

		const path = this.data.find([key, BigInt(0)]); // Find using a value with the target key
		if (!path.on) return false;

		const iter = this.data.ascending(path);
		for (const currentPath of iter) {
			const entry = this.data.at(currentPath);
			if (!entry) continue;

			if (this.compareKeys(entry[0], key) !== 0) {
				break;
			}

			if (entry[1] === rowid) {
				try {
					this.data.deleteAt(currentPath);
					return true;
				} catch (e) {
					errorLog(`Error removing entry from index '%s' for rowid %s: %O`, this.name ?? '(unnamed)', rowid, e);
					return false;
				}
			}
		}
		return false;
	}

	clear(): void {
		const originalCompareKeys = this.compareKeys;
		this.data = new BTree<[BTreeKey, bigint], [BTreeKey, bigint]>(
			(value: [BTreeKey, bigint]) => value,
			(a: [BTreeKey, bigint], b: [BTreeKey, bigint]) => originalCompareKeys(a[0], b[0])
		);
	}

	get size(): number {
		return this.data.getCount();
	}
}
