import { BTree } from 'digitree';
import type { SqlValue } from '../../common/types.js';
import { compareSqlValues } from '../../util/comparison.js';
import type { MemoryTableRow, BTreeKey } from './types.js';

/** Definition for creating a memory index */
export interface IndexSpec {
	name?: string;
	columns: ReadonlyArray<{ index: number; desc: boolean; collation?: string }>;
	// unique?: boolean; // Future extension
}

/** Represents a secondary index within a MemoryTable */
export class MemoryIndex {
	public readonly name: string | undefined;
	public readonly columns: ReadonlyArray<number>;
	public readonly directions: ReadonlyArray<boolean>;
	public readonly collations: ReadonlyArray<string>;
	public readonly keyFromRow: (row: MemoryTableRow) => BTreeKey;
	public readonly compareKeys: (a: BTreeKey, b: BTreeKey) => number;
	// The BTree stores [key, rowid] pairs as its value type.
	// The BTree's key is extracted from this pair (the first element).
	public data: BTree<[BTreeKey, bigint], [BTreeKey, bigint]>;

	constructor(spec: IndexSpec, allTableColumns: ReadonlyArray<{ name: string }>) {
		this.name = spec.name;
		this.columns = Object.freeze(spec.columns.map(c => c.index));
		this.directions = Object.freeze(spec.columns.map(c => c.desc));
		this.collations = Object.freeze(spec.columns.map(c => c.collation ?? 'BINARY'));

		// Validate column indices
		if (this.columns.some(idx => idx < 0 || idx >= allTableColumns.length)) {
			throw new Error(`Invalid column index specified in index definition '${this.name ?? '(unnamed)'}'`);
		}

		const indexColumnNames = this.columns.map(idx => allTableColumns[idx].name);

		// --- Key Generation and Comparison Logic ---
		if (this.columns.length === 1) {
			// Single column index
			const colName = indexColumnNames[0];
			const isDesc = this.directions[0];
			const collation = this.collations[0];
			this.keyFromRow = (row) => row[colName] as BTreeKey;
			this.compareKeys = (a: BTreeKey, b: BTreeKey): number => {
				const cmp = compareSqlValues(a as SqlValue, b as SqlValue, collation);
				return isDesc ? -cmp : cmp;
			};
		} else {
			// Composite key index
			this.keyFromRow = (row) => indexColumnNames.map(name => row[name]);
			this.compareKeys = (a: BTreeKey, b: BTreeKey): number => {
				const arrA = a as SqlValue[];
				const arrB = b as SqlValue[];
				const len = Math.min(arrA.length, arrB.length);
				for (let i = 0; i < len; i++) {
					const dirMultiplier = this.directions[i] ? -1 : 1;
					const collation = this.collations[i];
					const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
					if (cmp !== 0) return cmp;
				}
				// If keys are identical up to shared length, consider shorter key less
				return arrA.length - arrB.length;
			};
		}

		// Initialize the BTree for the index.
		// It stores [key, rowid] pairs. The BTree's internal key is the first element (the actual index key).
		const originalCompareKeys = this.compareKeys;
		this.data = new BTree<[BTreeKey, bigint], [BTreeKey, bigint]>(
			// The key extractor MUST return the value type ([BTreeKey, bigint])
			(value: [BTreeKey, bigint]) => value, // Return the whole pair
			// The comparator receives the full value pair, but compares based on the key part (a[0], b[0])
			(a: [BTreeKey, bigint], b: [BTreeKey, bigint]) => originalCompareKeys(a[0], b[0])
		);
	}

	/**
	 * Helper to insert a row's index entry.
	 * Assumes the row itself is stored elsewhere (primary tree).
	 */
	addEntry(row: MemoryTableRow): void {
		const key = this.keyFromRow(row);
		const rowid = row._rowid_;
		// TODO: Add UNIQUE constraint check here if spec.unique is true (future)
		try {
			// Store [key, rowid] pair; BTree uses key extractor/comparator defined in constructor
			this.data.insert([key, rowid]);
		} catch (e) {
			// BTree might throw if key comparison function is inconsistent, etc.
			console.error(`Error adding entry to index '${this.name ?? '(unnamed)'}' for rowid ${rowid}:`, e);
			throw new Error(`Failed to add entry to index '${this.name ?? '(unnamed)'}'.`);
		}
	}

	/** Helper to remove a row's index entry */
	removeEntry(row: MemoryTableRow): boolean {
		const key = this.keyFromRow(row);
		const rowid = row._rowid_;
		// We need to find the BTree entry where entry[0] matches key and entry[1] matches rowid.
		// BTree.find uses the key extractor and comparator.
		// The comparator works on the key part (value[0]), so find needs a value whose key part matches.
		// We can pass a partial value [key, arbitrary_rowid] for the find operation.
		const path = this.data.find([key, BigInt(0)]); // Find using a value with the target key
		if (!path.on) return false; // Key not found

		// Iterate starting from the found path to handle potential duplicate keys.
		const iter = this.data.ascending(path);
		for (const currentPath of iter) {
			const entry = this.data.at(currentPath);
			if (!entry) continue; // Should not happen

			// Compare keys first - stop if we move past the target key
			// The BTree's comparator (originalCompareKeys) works on the extracted key (entry[0])
			if (this.compareKeys(entry[0], key) !== 0) {
				break; // Moved past our key, target not found
			}

			// Check if the rowid matches
			if (entry[1] === rowid) {
				try {
					this.data.deleteAt(currentPath);
					return true; // Successfully deleted
				} catch (e) {
					console.error(`Error removing entry from index '${this.name ?? '(unnamed)'}' for rowid ${rowid}:`, e);
					return false; // Deletion failed
				}
			}
		}
		return false; // Key found, but specific rowid pair was not
	}

	/** Clears all entries from the index BTree */
	clear(): void {
		// Re-create the BTree to clear it
		const originalCompareKeys = this.compareKeys;
		// Make sure the type matches the property definition
		this.data = new BTree<[BTreeKey, bigint], [BTreeKey, bigint]>(
			(value: [BTreeKey, bigint]) => value, // Return the whole pair
			// Comparator receives full value, compares key part
			(a: [BTreeKey, bigint], b: [BTreeKey, bigint]) => originalCompareKeys(a[0], b[0])
		);
	}

	/** Get current size */
	get size(): number {
		return this.data.getCount();
	}
}
