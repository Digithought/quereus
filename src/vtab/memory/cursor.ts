import { VirtualTableCursor } from "../cursor";
import type { MemoryTable, MemoryTableRow, BTreeKey } from "./table";
import { StatusCode, type SqlValue } from "../../common/types";
import type { SqliteContext } from "../../func/context";
import { SqliteError } from "../../common/errors";
import type { Path } from 'digitree';

/**
 * Cursor for the MemoryTable using BTree paths and iterators.
 * Now needs to handle transaction buffers via a merged result set.
 */
export class MemoryTableCursor extends VirtualTableCursor<MemoryTable> {
	// State for iterating over merged results prepared by filter
	private mergedResults: MemoryTableRow[] = [];
	private currentIndex: number = -1;
	// Inherited: protected _isEof: boolean = true;

	constructor(table: MemoryTable) {
		super(table);
	}

	/** Resets the cursor state. */
	reset(): void {
		this.mergedResults = [];
		this.currentIndex = -1;
		this._isEof = true;
	}

	/** Gets the currently pointed-to row, or null if EOF or invalid. */
	getCurrentRow(): MemoryTableRow | null {
		if (this._isEof || this.currentIndex < 0 || this.currentIndex >= this.mergedResults.length) {
			return null;
		}
		return this.mergedResults[this.currentIndex];
	}

	/** Gets the rowid of the current row, or null. */
	getCurrentRowId(): bigint | null {
		const row = this.getCurrentRow();
		return row?._rowid_ ?? null;
	}

	/** Internal helper called by filter to set the results to iterate over */
	setResults(results: MemoryTableRow[]): void {
		this.mergedResults = results;
		this.currentIndex = -1;
		this._isEof = this.mergedResults.length === 0;
		if (!this._isEof) {
			// Start at the first element
			this.currentIndex = 0;
		}
	}

	// --- Implementation of Abstract Methods --- //

	async filter(idxNum: number, idxStr: string | null, args: ReadonlyArray<SqlValue>): Promise<void> {
		this.reset();
		const table = this.table; // Access table from base class
		const btree = table.data;
		const inTransaction = table.inTransaction;
		const pendingInserts = table.pendingInserts;
		const pendingUpdates = table.pendingUpdates;
		const pendingDeletes = table.pendingDeletes;

		if (!btree) throw new SqliteError("MemoryTable BTree not initialized in filter.", StatusCode.INTERNAL);

		let btreeIterator: IterableIterator<Path<BTreeKey, MemoryTableRow>> | null = null;
		let isDesc = false;

		const planParams = new Map<string, string>();
		idxStr?.split(',').forEach(part => {
			const eqIdx = part.indexOf('=');
			if (eqIdx > 0) {
				planParams.set(part.substring(0, eqIdx), part.substring(eqIdx + 1));
			}
		});
		isDesc = planParams.get('order') === 'DESC';

		// Determine BTree scan range/iterator based on plan
		try {
			// TODO: Refine range/key creation based on idxNum/args/planParams
			// For now, use simplified logic similar to MemoryTableModule.xFilter
			switch (idxNum) {
				case 1: // KEY_EQ
				case 2: // KEY_RANGE_ASC
				case 4: // KEY_RANGE_DESC
					// Placeholder: Assume full scan for merging simplicity for now
					btreeIterator = isDesc ? btree.descending(btree.last()) : btree.ascending(btree.first());
					break;
				case 3: // FULL_DESC
					btreeIterator = btree.descending(btree.last());
					break;
				case 0: // FULL_ASC
				default:
					btreeIterator = btree.ascending(btree.first());
					break;
			}
		} catch (e) {
			console.error(`Error preparing BTree iterator (idxNum=${idxNum}):`, e);
			this.reset(); // Ensure cursor is reset on error
			throw e instanceof SqliteError ? e : new SqliteError(`BTree iterator error: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
		}

		// Prepare Merged Results
		const finalResults: MemoryTableRow[] = [];
		if (!inTransaction) {
			// No transaction - just iterate BTree
			if (btreeIterator) {
				for (const path of btreeIterator) {
					const row = btree.at(path);
					if (row) {
						// TODO: Apply filter args if needed (skipped for now)
						finalResults.push(row);
					}
				}
			}
		} else {
			// Transaction active - merge BTree and buffers
			const btreeRows = new Map<BTreeKey, MemoryTableRow>();
			const compareKeys = table.compareKeys;
			const keyFromEntry = table.keyFromEntry;

			// 1. Gather relevant BTree rows (respecting range if implemented)
			if (btreeIterator) {
				for (const path of btreeIterator) {
					const row = btree.at(path);
					if (row && !pendingDeletes?.has(row._rowid_)) { // Skip deleted rows
						const key = keyFromEntry(row);
						btreeRows.set(key, row);
					}
				}
			}

			// 2. Apply pending updates to the gathered BTree rows
			if (pendingUpdates) {
				for (const updateInfo of pendingUpdates.values()) {
					// If the original key was in our BTree set, replace the row data
					if (btreeRows.has(updateInfo.oldKey)) {
						btreeRows.set(updateInfo.oldKey, updateInfo.newRow); // Update in place
						// If the key *also* changed, remove the old key entry and add the new one
						if (compareKeys(updateInfo.oldKey, updateInfo.newKey) !== 0) {
							btreeRows.delete(updateInfo.oldKey);
							btreeRows.set(updateInfo.newKey, updateInfo.newRow);
						}
					}
					// TODO: Handle case where updated row might now fall into range
				}
			}

			// 3. Add pending inserts (apply filter args if needed)
			const mergedRows = new Map(btreeRows);
			if (pendingInserts) {
				for (const [key, row] of pendingInserts.entries()) {
					// TODO: Check if inserted row matches filter args if provided
					mergedRows.set(key, row);
				}
			}

			// 4. Convert map values to array and sort
			finalResults.push(...mergedRows.values());
			finalResults.sort((a, b) => {
				const keyA = keyFromEntry(a);
				const keyB = keyFromEntry(b);
				const cmp = compareKeys(keyA, keyB);
				return isDesc ? -cmp : cmp;
			});
		}

		// Set results in cursor and update EOF state
		this.setResults(finalResults);
	}

	async next(): Promise<void> {
		if (this._isEof) return; // Already at end

		if (this.currentIndex >= this.mergedResults.length - 1) {
			this._isEof = true;
			this.currentIndex = this.mergedResults.length; // Position after the end
		} else {
			this.currentIndex++;
			this._isEof = false;
		}
	}

	column(context: SqliteContext, columnIndex: number): number {
		const row = this.getCurrentRow();
		if (!row) {
			// Should not happen if VDBE checks eof() before calling column(), but handle defensively
			context.resultNull();
			return StatusCode.OK;
		}

		if (columnIndex === -1) {
			context.resultInt64(row._rowid_);
			return StatusCode.OK;
		}

		if (columnIndex < 0 || columnIndex >= this.table.columns.length) {
			context.resultError(`Invalid column index ${columnIndex}`, StatusCode.RANGE);
			return StatusCode.RANGE;
		}
		const columnName = this.table.columns[columnIndex].name;

		// Access potentially non-existent columns safely (e.g., during ALTER ADD)
		const value = Object.prototype.hasOwnProperty.call(row, columnName) ? row[columnName] : null;
		context.resultValue(value ?? null);
		return StatusCode.OK;
	}

	async rowid(): Promise<bigint> {
		const rowid = this.getCurrentRowId();
		if (rowid === null) {
			throw new SqliteError("Cursor is not pointing to a valid row", StatusCode.MISUSE);
		}
		return rowid;
	}

	async close(): Promise<void> {
		this.reset(); // Clear internal state
		// No external resources to release for MemoryTableCursor
	}

	// --- Optional Seek Methods --- //

	/**
	 * Moves the cursor position by the given relative offset.
	 * Updates the internal EOF state.
	 */
	async seekRelative(offset: number): Promise<boolean> {
		if (offset === 0) {
			// Moving by 0 is always possible if the cursor is valid (not EOF)
			return !this._isEof;
		}

		if (this.mergedResults.length === 0) {
			// Cannot seek in empty results
			this.reset(); // Ensure state is EOF
			return false;
		}

		const targetIndex = this.currentIndex + offset;

		if (targetIndex < 0 || targetIndex >= this.mergedResults.length) {
			// Target is out of bounds
			if (targetIndex < 0) {
				this.currentIndex = -1; // Position before the start
			} else {
				this.currentIndex = this.mergedResults.length; // Position after the end
			}
			this._isEof = true;
			return false; // Seek failed (out of bounds)
		} else {
			// Target is within bounds
			this.currentIndex = targetIndex;
			this._isEof = false; // Cursor is now on a valid row
			return true; // Seek successful
		}
	}

	/**
	 * Seeks the cursor directly to the row matching the specified rowid.
	 * Updates the internal EOF state.
	 */
	async seekToRowid(rowid: bigint): Promise<boolean> {
		const results = this.mergedResults;
		const targetIndex = results.findIndex((row: MemoryTableRow) => row._rowid_ === rowid);

		if (targetIndex === -1) {
			// Rowid not found, set cursor to EOF
			this.currentIndex = results.length;
			this._isEof = true;
			return false;
		} else {
			// Rowid found, position cursor
			this.currentIndex = targetIndex;
			this._isEof = false;
			return true;
		}
	}

	// --- Helper Methods (if any, kept from original MemoryTableCursor) --- //

	/** Exposes merged results - used internally by seekToRowid for now */
	getMergedResults(): MemoryTableRow[] {
		return this.mergedResults;
	}
}

