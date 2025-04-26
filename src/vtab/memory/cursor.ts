import { BTree, type Path } from 'digitree';
import { VirtualTableCursor } from "../cursor.js";
import type { MemoryTable, MemoryTableRow, BTreeKey } from "./table.js";
import { StatusCode, type SqlValue } from "../../common/types.js";
import type { SqliteContext } from "../../func/context.js";
import { SqliteError } from "../../common/errors.js";
import type { MemoryIndex } from './index.js';
import { compareSqlValues } from "../../util/comparison.js";
import { IndexConstraintOp } from '../../common/constants.js';
import type { IndexConstraint } from '../indexInfo.js';

type IndexBound = { value: SqlValue, op: IndexConstraintOp };

/**
 * Cursor for the MemoryTable using BTree paths and iterators.
 * Now needs to handle transaction buffers via a merged result set.
 */
export class MemoryTableCursor extends VirtualTableCursor<MemoryTable> {
	// State for iterating over merged results prepared by filter
	private mergedResults: MemoryTableRow[] = [];
	private currentIndex: number = -1;
	// Inherited: protected _isEof: boolean = true;

	// --- Add state for the chosen index --- //
	private chosenIndex: MemoryIndex | null = null; // Secondary index instance
	private iteratePrimary: boolean = true; // True if iterating primaryTree, false for secondary
	private scanIsDesc: boolean = false;
	private isUniqueScan: boolean = false; // Set if planType is EQ
	// --- Add state for ephemeral sorter --- //
	public ephemeralSortingIndex: MemoryIndex | null = null; // Set by Sort opcode handler
	// -------------------------------------- //

	constructor(table: MemoryTable) {
		super(table);
	}

	/** Resets the cursor state. */
	reset(): void {
		this.mergedResults = [];
		this.currentIndex = -1;
		this._isEof = true;
		this.chosenIndex = null;
		this.iteratePrimary = true;
		this.scanIsDesc = false;
		this.isUniqueScan = false;
		// Clear sorter if present (its BTree will be garbage collected)
		if (this.ephemeralSortingIndex) {
			// We don't need to call clear() on it as it's temporary
			this.ephemeralSortingIndex = null;
		}
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

	async filter(
		idxNum: number,
		idxStr: string | null,
		constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>,
		args: ReadonlyArray<SqlValue>
	): Promise<void> {
		this.reset();
		const table = this.table; // Access table from base class

		// --- Check for Ephemeral Sorter Index FIRST --- //
		if (this.ephemeralSortingIndex) {
			console.log(`MemoryTableCursor Filter: Using ephemeral sorting index.`);
			const sorterIndex = this.ephemeralSortingIndex;
			// The sorter index BTree actually stores <SortKey, RowObject> directly.
			const sorterTree = sorterIndex.data as unknown as BTree<BTreeKey, MemoryTableRow>; // Cast to actual type
			const finalResults: MemoryTableRow[] = [];
			try {
				// Use the sorter's comparator implicitly via the BTree iteration order
				for (const path of sorterTree.ascending(sorterTree.first())) {
					const row = sorterTree.at(path);
					if (row) {
						finalResults.push(row); // Already has row copies
					}
				}
			} catch (e) {
				console.error("Error iterating ephemeral sorter index:", e);
				throw e instanceof SqliteError ? e : new SqliteError(`Sorter iteration error: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
			}
			this.setResults(finalResults);
			// Note: No need to handle transactions here, sorter operates on a snapshot.
			return; // Skip normal index processing
		}
		// -------------------------------------------- //

		// --- Normal Index Processing --- //
		const primaryTree = table.primaryTree;
		const secondaryIndexes = table.secondary;
		const inTransaction = table.inTransaction;
		const pendingInserts = table.pendingInserts;
		const pendingUpdates = table.pendingUpdates;
		const pendingDeletes = table.pendingDeletes;

		if (!primaryTree) throw new SqliteError("MemoryTable BTree not initialized in filter.", StatusCode.INTERNAL);

		// --- Decode Plan --- //
		const indexId = idxNum >> 3;
		const planType = idxNum & 0b111; // Mask last 3 bits
		this.scanIsDesc = planType === 1 /*FULL_DESC*/ || planType === 4 /*RANGE_DESC*/;
		this.isUniqueScan = planType === 2 /*EQ*/;

		if (indexId === 0) {
			this.iteratePrimary = true;
			this.chosenIndex = null;
		} else {
			const indexList = table.getIndexList();
			if (indexId - 1 >= 0 && indexId - 1 < indexList.length) {
				this.iteratePrimary = false;
				this.chosenIndex = indexList[indexId - 1];
			} else {
				throw new SqliteError(`Invalid indexId ${indexId} derived from idxNum ${idxNum}`, StatusCode.INTERNAL);
			}
		}
		const currentKeyFromRow = this.iteratePrimary ? table.keyFromEntry : this.chosenIndex!.keyFromRow;
		const currentCompareKeys = this.iteratePrimary ? table.compareKeys : this.chosenIndex!.compareKeys;
		const indexColumns = this.iteratePrimary ? (table.primaryKeyColumnIndices.length > 0 ? table.primaryKeyColumnIndices.map(idx => ({ index: idx, desc: false })) : [{ index: -1, desc: false }]) : this.chosenIndex!.columns.map((idx, i) => ({ index: idx, desc: this.chosenIndex!.directions[i] }));
		const firstIndexColSchema = indexColumns[0];
		// --------------------- //

		// --- Declare variables outside try block --- //
		let eqKey: BTreeKey | undefined = undefined;
		let lowerBound: IndexBound | null = null;
		let upperBound: IndexBound | null = null;
		let baseIterator: IterableIterator<any> | null = null;
		// ----------------------------------------- //

		// --- Extract Bounds/Keys and Prepare Iterator --- //
		// Use a temporary variable for the iterator to avoid potential issues with try/catch scoping
		let preparedIterator: IterableIterator<any> | null = null;
		try {
			// Extract keys/bounds using the passed constraints array
			if (planType === 2 /*EQ*/) {
				const keyParts: SqlValue[] = [];
				let keyComplete = true;
				for (let i = 0; i < indexColumns.length; i++) {
					const idxCol = indexColumns[i].index;
					const constraintInfo = constraints.find(c => c.constraint.iColumn === idxCol && c.constraint.op === IndexConstraintOp.EQ);
					if (constraintInfo && constraintInfo.argvIndex > 0 && args.length >= constraintInfo.argvIndex) {
						keyParts.push(args[constraintInfo.argvIndex - 1]);
					} else {
						keyComplete = false;
						console.warn(`EQ plan used, but constraint for index column ${i} (schema idx ${idxCol}) not found or arg missing.`);
						break;
					}
				}
				if (keyComplete) {
					// Cast single value to BTreeKey, array is already compatible
					eqKey = keyParts.length === 1 ? keyParts[0] as BTreeKey : keyParts;
				}
			} else if (planType === 3 /*RANGE_ASC*/ || planType === 4 /*RANGE_DESC*/) {
				const firstColIdx = firstIndexColSchema?.index;
				if (firstColIdx !== undefined) {
					constraints.forEach(cinfo => {
						if (cinfo.constraint.iColumn === firstColIdx && cinfo.argvIndex > 0 && args.length >= cinfo.argvIndex) {
							const val = args[cinfo.argvIndex - 1];
							const op = cinfo.constraint.op;
							if (op === IndexConstraintOp.GT || op === IndexConstraintOp.GE) {
								if (!lowerBound || op > lowerBound.op) { lowerBound = { value: val, op: op }; }
							} else if (op === IndexConstraintOp.LT || op === IndexConstraintOp.LE) {
								if (!upperBound || op < upperBound.op) { upperBound = { value: val, op: op }; }
							}
						}
					});
				}
			}
			// Determine iterator based on extracted keys/bounds
			const targetTree = this.iteratePrimary ? primaryTree : this.chosenIndex!.data;
			let startPath: Path<any, any> | null = null;

			if (planType === 2 /*EQ*/ && eqKey !== undefined) {
				// Use find for EQ. Need to construct the value BTree expects.
				// For primary: key is the value. For secondary: [key, dummy_rowid] is value.
				const findValue = this.iteratePrimary ? eqKey : [eqKey, BigInt(0)];
				startPath = (targetTree as BTree<any, any>).find(findValue);
				if (startPath?.on) {
					// Start iteration from the found path (always ascending for EQ check)
					baseIterator = (targetTree as BTree<any, any>).ascending(startPath);
				} else {
					baseIterator = [][Symbol.iterator](); // Empty iterator
				}
			} else {
				// For Range or Full scans, start at beginning or end
				startPath = this.scanIsDesc ? (targetTree as BTree<any, any>).last() : (targetTree as BTree<any, any>).first();
				if (this.scanIsDesc) {
					baseIterator = (targetTree as BTree<any, any>).descending(startPath);
				} else {
					baseIterator = (targetTree as BTree<any, any>).ascending(startPath);
				}
			}
			preparedIterator = baseIterator; // Assign to temporary variable after successful preparation
		} catch (e) {
			console.error(`Error preparing BTree iterator (idxNum=${idxNum}, planType=${planType}, indexId=${indexId}):`, e);
			this.reset();
			throw e instanceof SqliteError ? e : new SqliteError(`BTree iterator error: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
		}
		// Assign the prepared iterator back to the main variable outside the try-catch
		baseIterator = preparedIterator;
		// ---------------------------------------------- //

		// Prepare Merged Results
		const finalResults: MemoryTableRow[] = [];

		// Helper to fetch full row (needed for secondary index iteration)
		const fetchRow = (rowid: bigint): MemoryTableRow | null => {
			// 1. Check pending updates/inserts first
			if (inTransaction) {
				// Check pending updates
				const pendingUpdate = pendingUpdates?.get(rowid);
				if (pendingUpdate) {
					return pendingUpdate.newRow; // Return the updated row data
				}
				// Check pending inserts (less likely for existing rowid, but possible)
				for (const insertedRow of pendingInserts?.values() ?? []) {
					if (insertedRow._rowid_ === rowid) {
						return insertedRow;
					}
				}
				// Check if row was deleted in this transaction
				if (pendingDeletes?.has(rowid)) {
					return null; // Row doesn't exist from perspective of this transaction
				}
			}
			// 2. Fetch from primary tree
			const primaryPath = table.findPathByRowid(rowid);
			if (primaryPath) {
				return primaryTree.at(primaryPath) ?? null;
			}
			return null;
		};

		if (!inTransaction) {
			// No transaction - iterate chosen index and apply filters
			if (baseIterator) {
				for (const item of baseIterator) {
					let row: MemoryTableRow | null = null;
					let currentKey: BTreeKey | undefined = undefined;
					let rowid: bigint | undefined = undefined;

					// Get row, key, and rowid based on iteration type
					if (this.iteratePrimary) {
						row = primaryTree.at(item as Path<BTreeKey, MemoryTableRow>) ?? null;
						if (row) { currentKey = currentKeyFromRow(row); rowid = row._rowid_; }
					} else {
						const entry = this.chosenIndex!.data.at(item as Path<[BTreeKey, bigint], [BTreeKey, bigint]>);
						if (entry) { currentKey = entry[0]; rowid = entry[1]; row = fetchRow(rowid); }
					}

					if (row && currentKey !== undefined) {
						// Apply plan-specific filtering
						let passesFilter = true;
						if (planType === 2 /*EQ*/) {
							if (eqKey === undefined || currentCompareKeys(currentKey, eqKey) !== 0) {
								passesFilter = false;
								break; // EQ scan can stop immediately if key mismatch
							}
						} else {
							// Apply range bounds for RANGE or FULL scans
							const firstColKey = Array.isArray(currentKey) ? currentKey[0] : currentKey;
							if (lowerBound) { // Check the bound variable directly now
								const lb = lowerBound as IndexBound;	// HACK: Typescript doesn't seem to be inferring this correctly
								const cmp = compareSqlValues(firstColKey, lb.value);
								if (cmp < 0 || (cmp === 0 && lb.op === IndexConstraintOp.GT)) {
									passesFilter = false;
									// If descending, hitting lower bound means we can stop
									if (this.scanIsDesc) break;
								}
							}
							if (passesFilter && upperBound) { // Check the bound variable directly
								const ub = upperBound as IndexBound;	// HACK: Typescript doesn't seem to be inferring this correctly
								const cmp = compareSqlValues(firstColKey, ub.value);
								if (cmp > 0 || (cmp === 0 && ub.op === IndexConstraintOp.LT)) {
									passesFilter = false;
									// If ascending, hitting upper bound means we can stop
									if (!this.scanIsDesc) break;
								}
							}
						}

						if (passesFilter) {
							// Apply remaining filter constraints not handled by the index scan
							for (const cInfo of constraints) {
								const c = cInfo.constraint;
								// Skip EQ constraints if EQ plan was used (already checked)
								if (planType === 2 /*EQ*/ && c.op === IndexConstraintOp.EQ) continue;
								// Skip range constraints if RANGE plan was used (already checked)
								if ((planType === 3 || planType === 4) &&
									(c.iColumn === firstIndexColSchema?.index) &&
									(c.op >= IndexConstraintOp.GT && c.op <= IndexConstraintOp.LE)) {
									continue;
								}

								const colIdx = c.iColumn;
								let colValue: SqlValue;
								if (colIdx === -1) {
									colValue = row._rowid_;
								} else if (colIdx >= 0 && colIdx < table.columns.length) {
									const colName = table.columns[colIdx].name;
									colValue = Object.prototype.hasOwnProperty.call(row, colName) ? row[colName] : null;
								} else {
									console.warn(`Invalid column index ${colIdx} in constraint during filter.`);
									passesFilter = false; // Treat invalid index as filter failure
									break;
								}

								const argValue = args[cInfo.argvIndex - 1]; // argvIndex is 1-based
								const comparisonResult = compareSqlValues(colValue, argValue);

								let constraintSatisfied = false;
								switch (c.op) {
									case IndexConstraintOp.EQ: constraintSatisfied = comparisonResult === 0; break;
									case IndexConstraintOp.GT: constraintSatisfied = comparisonResult > 0; break;
									case IndexConstraintOp.LE: constraintSatisfied = comparisonResult <= 0; break;
									case IndexConstraintOp.LT: constraintSatisfied = comparisonResult < 0; break;
									case IndexConstraintOp.GE: constraintSatisfied = comparisonResult >= 0; break;
									// TODO: Implement other operators like LIKE, GLOB, NE, IS, IS NOT, ISNULL, NOTNULL if needed
									default:
										console.warn(`Unsupported constraint operator ${c.op} during filter.`);
										constraintSatisfied = true; // Be permissive for unsupported ops? Or fail?
								}

								if (!constraintSatisfied) {
									passesFilter = false;
									break; // Stop checking constraints for this row
								}
							}

							if (passesFilter) {
								finalResults.push(row);
								if (this.isUniqueScan) {
									// Added break for unique EQ scan optimization
									break; // Found the unique match
								}
							}
						}
					}
				}
			}
		} else {
			// Transaction active - merge BTree and buffers
			// TODO: Adapt merge logic
			// For now, reuse the simplified full-scan merge logic
			// This is INEFFICIENT for EQ/Range scans but correct.
			if (this.iteratePrimary) {
				// Original logic: Iterate primary, merge with buffers
				const btreeRows = new Map<BTreeKey, MemoryTableRow>();
				const compareKeys = table.compareKeys; // Primary key comparison
				const keyFromEntry = table.keyFromEntry; // Primary key extraction

				// 1. Gather relevant BTree rows
				if (baseIterator) {
					for (const path of baseIterator as IterableIterator<Path<BTreeKey, MemoryTableRow>>) {
						const row = primaryTree.at(path);
						if (row && !pendingDeletes?.has(row._rowid_)) { // Skip deleted rows
							const key = keyFromEntry(row); // Primary key
							btreeRows.set(key, row);
							if (this.isUniqueScan) break;
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

				// 4. Convert map values to array and sort (using primary key comparator)
				finalResults.push(...mergedRows.values());
				finalResults.sort((a, b) => {
					const keyA = keyFromEntry(a);
					const keyB = keyFromEntry(b);
					const cmp = compareKeys(keyA, keyB);
					return this.scanIsDesc ? -cmp : cmp;
				});
			} else {
				// Iterating secondary index - harder merge
				// Gather rowids from index, fetch rows (checking buffers), then merge inserts.
				const finalRowids = new Set<bigint>();
				const secondaryTree = this.chosenIndex!.data;
				const indexCompareKeys = this.chosenIndex!.compareKeys;
				const indexKeyFromRow = this.chosenIndex!.keyFromRow;

				// 1. Gather rowids from secondary index scan
				if (baseIterator) {
					for (const path of baseIterator as IterableIterator<Path<[BTreeKey, bigint], [BTreeKey, bigint]>>) {
						const entry = secondaryTree.at(path);
						if (entry) {
							const rowid = entry[1];
							// Check if deleted in this transaction BEFORE adding
							if (!pendingDeletes?.has(rowid)) {
								finalRowids.add(rowid);
							}
							if (this.isUniqueScan) break;
						}
					}
				}

				// 2. Incorporate rowids from relevant pending updates
				// An updated row might now match the index criteria, or might no longer match.
				if (pendingUpdates) {
					for (const [rowid, updateInfo] of pendingUpdates.entries()) {
						const oldSecKey = indexKeyFromRow(updateInfo.oldRow);
						const newSecKey = indexKeyFromRow(updateInfo.newRow);
						// TODO: Check if oldSecKey/newSecKey match the index filter range/EQ value
						// This is complex without the filter args.
						// Simplified: If the secondary key changed, remove the rowid if it was present
						// from the BTree scan, and add it if the new key potentially matches.
						if (indexCompareKeys(oldSecKey, newSecKey) !== 0) {
							// If the old key might have been included by the scan, remove rowid
							finalRowids.delete(rowid); // Might not be present, safe to call
							// Add rowid if new key might match (assume it might for now)
							// But only if not deleted
							if (!pendingDeletes?.has(rowid)) {
								finalRowids.add(rowid);
							}
						}
					}
				}

				// 3. Incorporate rowids from relevant pending inserts
				if (pendingInserts) {
					for (const row of pendingInserts.values()) {
						// TODO: Check if inserted row's secondary key matches filter
						// Assume it might match for now.
						finalRowids.add(row._rowid_);
					}
				}

				// 4. Fetch actual row data for the final set of rowids
				const potentialRows: MemoryTableRow[] = [];
				for (const rowid of finalRowids) {
					const row = fetchRow(rowid);
					if (row) {
						potentialRows.push(row);
					}
				}

				// 5. Sort the resulting rows based on the chosen index's key
				potentialRows.sort((a, b) => {
					const keyA = indexKeyFromRow(a);
					const keyB = indexKeyFromRow(b);
					const cmp = indexCompareKeys(keyA, keyB);
					// Add rowid tie-breaker if keys are equal
					if (cmp === 0) {
						return compareSqlValues(a._rowid_, b._rowid_);
					}
					return this.scanIsDesc ? -cmp : cmp;
				});
				finalResults.push(...potentialRows);
			}
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

