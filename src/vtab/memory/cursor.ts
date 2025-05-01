import { VirtualTableCursor } from "../cursor.js";
import type { MemoryTable } from "./table.js";
import type { MemoryTableRow, BTreeKey } from "./types.js";
import { StatusCode, type SqlValue } from "../../common/types.js";
import type { SqliteContext } from "../../func/context.js";
import { SqliteError } from "../../common/errors.js";
import { MemoryIndex, type IndexSpec } from './index.js'; // Change to regular import for MemoryIndex
import { IndexConstraintOp } from '../../common/constants.js';
import type { IndexConstraint, IndexInfo } from '../indexInfo.js'; // Keep for filter signature
import type { MemoryTableConnection } from './layer/connection.js';
import type { LayerCursorInternal } from './layer/cursor.js';
import type { ScanPlan, ScanPlanEqConstraint, ScanPlanRangeBound } from './layer/scan-plan.js'; // Import ScanPlan
import { BTree } from 'digitree'; // Needed for sorter logic
import type { P4SortKey } from '../../vdbe/instruction.js'; // Import SortKey info
import { createLogger } from '../../common/logger.js'; // Import logger

const log = createLogger('vtab:memory:cursor'); // Create logger
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log; // Use base log for debug level

/**
 * Public-facing cursor for the MemoryTable using the layer-based MVCC model.
 * Delegates operations to an internal cursor chain created based on connection state.
 */
export class MemoryTableCursor extends VirtualTableCursor<MemoryTable> {
	private readonly connection: MemoryTableConnection;
	private internalCursor: LayerCursorInternal | null = null;

	// --- Add state for ephemeral sorter --- //
	// TODO: How does ephemeral sorting fit with layers?
	// Option 1: Sorter operates on a snapshot from the connection's readLayer.
	// Option 2: Sorter tries to incorporate pending layer changes (more complex).
	// Let's assume Option 1 for now. Sorter index is created based on connection's readLayer.
	public ephemeralSortingIndex: MemoryIndex | null = null; // Set by Sort opcode handler
	private sorterResults: MemoryTableRow[] = [];
	private sorterIndex: number = -1;
	private isUsingSorter: boolean = false;
	// -------------------------------------- //

	constructor(table: MemoryTable, connection: MemoryTableConnection) {
		super(table);
		this.connection = connection;
		this._isEof = true; // Start as EOF until filter is called
	}

	/** Resets the cursor state, closing any internal cursor. */
	private reset(): void {
		if (this.internalCursor) {
			try {
				this.internalCursor.close();
			} catch (e) {
				// Use namespaced error logger
				errorLog("Error closing internal cursor during reset: %O", e);
			}
			this.internalCursor = null;
		}
		this._isEof = true;
		this.isUsingSorter = false;
		this.sorterResults = [];
		this.sorterIndex = -1;

		// Clear sorter index if present (assuming Option 1: sorter is temporary for the query)
		if (this.ephemeralSortingIndex) {
			// No need to clear its BTree data, it will be GC'd.
			this.ephemeralSortingIndex = null;
		}
	}

	/**
	 * Creates the ScanPlan object based on filter arguments.
	 * This logic was previously part of the old filter method.
	 */
	private buildScanPlan(
		idxNum: number,
		idxStr: string | null,
		constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>,
		args: ReadonlyArray<SqlValue>,
		indexInfo: IndexInfo // Pass the full IndexInfo from xBestIndex
	): ScanPlan {
		// --- Decode Index and Plan Type from idxNum ---
		// This assumes the encoding used in MemoryTableModule.xBestIndex
		// indexId = 0 for primary, > 0 for secondary index list + 1
		// planType = 0: FULL_ASC, 1: FULL_DESC, 2: EQ, 3: RANGE_ASC, 4: RANGE_DESC
		// const indexId = idxNum >> 3;
		// const planType = idxNum & 0b111; // Mask last 3 bits

		// --- Instead of decoding idxNum, let's parse idxStr which should contain necessary info ---
		// Example idxStr: "idx=my_index(2);plan=3;ordCons=ASC;argvMap=[[1,0],[2,2]]"
		let indexName: string | 'primary' = 'primary';
		let descending = false;
		let equalityKey: BTreeKey | undefined = undefined;
		let lowerBound: ScanPlanRangeBound | undefined = undefined;
		let upperBound: ScanPlanRangeBound | undefined = undefined;

		// Parse idxStr (more robust than relying solely on idxNum encoding)
		const params = new Map<string, string>();
		idxStr?.split(';').forEach(part => {
			const [key, value] = part.split('=', 2);
			if (key && value !== undefined) {
				params.set(key, value);
			}
		});

		const idxNameMatch = params.get('idx')?.match(/^(.*?)\((\d+)\)$/);
		if (idxNameMatch) {
			indexName = idxNameMatch[1] === '_rowid_' || idxNameMatch[1] === '_primary_' ? 'primary' : idxNameMatch[1];
			// const indexId = parseInt(idxNameMatch[2], 10); // We have the name now
		} else {
			// Default to primary if idxStr doesn't specify or is malformed
			indexName = 'primary';
			// Use namespaced warn logger
			warnLog(`Could not parse index name from idxStr: "%s". Defaulting to primary.`, idxStr);
		}

		const planTypeStr = params.get('plan');
		const planType = planTypeStr ? parseInt(planTypeStr, 10) : 0; // Default to FULL_ASC

		// Determine direction based on plan type or ordCons
		const ordCons = params.get('ordCons');
		if (ordCons) {
			descending = ordCons === 'DESC';
		} else {
			descending = planType === 1 /* FULL_DESC */ || planType === 4 /* RANGE_DESC */;
		}

		// Extract EQ key or Range bounds based on plan type and argvMap
		const argvMap = new Map<number, number>(); // Map argvIndex -> constraintIndex
		params.get('argvMap')?.match(/\[(\d+),(\d+)\]/g)?.forEach(match => {
			const parts = match.match(/\[(\d+),(\d+)\]/);
			if (parts) {
				argvMap.set(parseInt(parts[1], 10), parseInt(parts[2], 10));
			}
		});

		if (planType === 2 /* EQ */) {
			// Find the schema definition for the chosen index
			const schema = this.table.getSchema();
			if (!schema) {
				throw new SqliteError("Internal Error: Table schema not available in cursor during plan building.", StatusCode.INTERNAL);
			}

			// Get index schema, handling both primary and secondary
			const indexSchema = indexName === 'primary'
				? { name: '_primary_', columns: schema.primaryKeyDefinition ?? [{ index: -1, desc: false }] }
				: schema.indexes?.find(idx => idx.name === indexName);

			// Special case for simple Primary Key EQ lookup (like WHERE a = 2)
			// If plan is EQ, index is primary, and there's exactly one arg mapped
			if (indexName === 'primary' && args.length === 1 && argvMap.size === 1) {
				// Assume the single arg is the primary key value
				equalityKey = args[0];
				debugLog(`Using direct Primary Key EQ lookup value: %O`, equalityKey);
			} else if (indexSchema) {
				// General case for EQ plans (composite keys or secondary indexes)
				if (!indexSchema || !indexSchema.columns) {
					throw new SqliteError(`Internal error: Index schema or columns not found for index '${indexName}'`, StatusCode.INTERNAL);
				}

				const keyParts: SqlValue[] = [];
				let keyComplete = true;
				for (let k = 0; k < indexSchema.columns.length; k++) {
					const idxCol = indexSchema.columns[k].index;
					let foundArg = false;

					// Use argvMap first if available
					if (argvMap.size > 0) {
						for (let argIdx = 1; argIdx <= args.length; argIdx++) { // Iterate 1-based argvIndex
							const constraintIdx = argvMap.get(argIdx);
							if (constraintIdx !== undefined && constraintIdx < indexInfo.aConstraint.length) {
								const constraint = indexInfo.aConstraint[constraintIdx];
								if (constraint && constraint.iColumn === idxCol && constraint.op === IndexConstraintOp.EQ) {
									keyParts.push(args[argIdx - 1]); // Use 0-based index for args array
									foundArg = true;
									break;
								}
							}
						}
					}

					// Fallback: check constraints passed directly (might be redundant if argvMap is correct)
					if (!foundArg) {
						for (const cInfo of constraints) {
							const c = cInfo.constraint;
							if (c.iColumn === idxCol && c.op === IndexConstraintOp.EQ &&
								cInfo.argvIndex > 0 && args.length >= cInfo.argvIndex) {
								keyParts.push(args[cInfo.argvIndex - 1]);
								foundArg = true;
								break;
							}
						}
					}

					// If still not found after checking both, key is incomplete
					if (!foundArg) {
						keyComplete = false;
						warnLog(`EQ plan for index '%s', but constraint/arg for column %d (schema idx %d) not found.`, indexName, k, idxCol);
						break;
					}
				} // end for each column in index

				if (keyComplete) {
					equalityKey = keyParts.length === 1 && indexSchema.columns.length === 1 ? keyParts[0] : keyParts;
					debugLog(`EQ plan for index '%s', derived key: %O`, indexName, equalityKey);
				} else {
					warnLog(`EQ plan for index '%s' could not derive complete key.`, indexName);
					// No equalityKey set, will likely result in full scan if filter doesn't catch it
				}
			} else {
				// Use namespaced error logger
				errorLog(`Could not find schema for index '%s' to build EQ key.`, indexName);
			}

		} else if (planType === 3 /* RANGE_ASC */ || planType === 4 /* RANGE_DESC */) {
			// Find the first column of the index
			const schema = this.table.getSchema();
			if (!schema) {
				throw new SqliteError("Internal Error: Table schema not available in cursor during plan building.", StatusCode.INTERNAL);
			}
			const indexSchema = indexName === 'primary'
				? { name: '_primary_', columns: schema.primaryKeyDefinition ?? [{ index: -1, desc: false }] }
				: schema.indexes?.find(idx => idx.name === indexName);
			const firstColIdx = indexSchema?.columns?.[0]?.index;

			if (firstColIdx !== undefined) {
				// Find bounds from used constraints (via argvMap)
				for (const [argIdx, constraintIdx] of argvMap.entries()) {
					if (constraintIdx < indexInfo.aConstraint.length) {
						const constraint = indexInfo.aConstraint[constraintIdx];
						if (constraint.iColumn === firstColIdx) {
							const val = args[argIdx - 1]; // 0-based index for args array
							const op = constraint.op;
							if (op === IndexConstraintOp.GT || op === IndexConstraintOp.GE) {
								if (!lowerBound || op > lowerBound.op) { // Prefer stricter bound (GT over GE)
									lowerBound = { value: val, op: op };
								}
							} else if (op === IndexConstraintOp.LT || op === IndexConstraintOp.LE) {
								if (!upperBound || op < upperBound.op) { // Prefer stricter bound (LT over LE)
									upperBound = { value: val, op: op };
								}
							}
						}
					}
				}
				// Also check constraints directly (in case planner didn't map them)
				constraints.forEach(cInfo => {
					const c = cInfo.constraint;
					if (c.iColumn === firstColIdx && cInfo.argvIndex > 0 && args.length >= cInfo.argvIndex) {
						const val = args[cInfo.argvIndex - 1];
						const op = c.op;
						if (op === IndexConstraintOp.GT || op === IndexConstraintOp.GE) {
							if (!lowerBound || op > lowerBound.op) { lowerBound = { value: val, op: op }; }
						} else if (op === IndexConstraintOp.LT || op === IndexConstraintOp.LE) {
							if (!upperBound || op < upperBound.op) { upperBound = { value: val, op: op }; }
						}
					}
				});
			}
		}

		return {
			indexName,
			descending,
			equalityKey,
			lowerBound,
			upperBound,
			idxNum: idxNum, // Keep original values for reference/debugging
			idxStr: idxStr
		};
	}

	// --- Method to handle Sort opcode --- //
	async createAndPopulateSorterIndex(sortInfo: P4SortKey): Promise<MemoryIndex> {
		// Use namespaced debug logger
		debugLog("Creating and populating ephemeral sorter index...");
		// 1. Define IndexSpec based on sortInfo
		const schema = this.table.getSchema();
		if (!schema) {
			throw new SqliteError("Cannot create sorter index: Table schema not found.", StatusCode.INTERNAL);
		}
		const sortIndexSpec: IndexSpec = {
			name: `_sorter_${Date.now()}`,
			// Use sortInfo.keyIndices and provide type for keyInfo
			columns: sortInfo.keyIndices.map((colIndex, i) => ({
				index: colIndex, // Column index from schema
				desc: sortInfo.directions[i] ?? false, // Get direction
				collation: sortInfo.collations?.[i] ?? 'BINARY' // Get collation or default
			})),
		};

		// 2. Create a new MemoryIndex instance (using value import)
		const sorterIndex = new MemoryIndex(sortIndexSpec, schema.columns.map(c => ({ name: c.name })));

		// 3. Create a simple scan plan to iterate all visible rows
		// TODO: Should this respect any existing *filtering* constraints from the query?
		// For now, assume Sort happens before complex filtering or VDBE handles post-sort filtering.
		const fullScanPlan: ScanPlan = {
			indexName: 'primary', // Iterate using primary key order initially
			descending: false,
		};

		// 4. Create an internal cursor to read rows
		let readerCursor: LayerCursorInternal | null = null;
		try {
			readerCursor = this.connection.createLayerCursor(fullScanPlan);

			// 5. Iterate and populate the sorter index
			while (!readerCursor.isEof()) {
				const row = readerCursor.getCurrentRow();
				if (row) {
					sorterIndex.addEntry(row);
				}
				await readerCursor.next();
			}
		} catch(e) {
			// Use namespaced error logger
			errorLog("Error populating sorter index: %O", e);
			throw e instanceof SqliteError ? e : new SqliteError(`Sorter population failed: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
		} finally {
			// Close the temporary reader cursor
			readerCursor?.close();
		}

		// Use namespaced debug logger
		debugLog(`Sorter index %s created.`, sorterIndex.name);
		return sorterIndex;
	}
	// ---------------------------------- //

	async filter(
		idxNum: number,
		idxStr: string | null,
		constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>,
		args: ReadonlyArray<SqlValue>,
		indexInfo: IndexInfo // Pass the full IndexInfo from xBestIndex
	): Promise<void> {
		this.reset(); // Close existing internal cursor, clear state

		// Add detailed logging to understand the filter operation
		debugLog(`MemoryTableCursor.filter: idxNum=${idxNum}, idxStr=${idxStr || "null"}, args=${JSON.stringify(args)}, constraints=${JSON.stringify(constraints)}, indexInfo=${JSON.stringify(indexInfo)}`);

		// Check for sorter FIRST (set by Sort opcode calling createAndPopulateSorterIndex)
		if (this.ephemeralSortingIndex) {
			// Use namespaced debug logger
			debugLog(`MemoryTableCursor Filter: Using ephemeral sorting index.`);
			this.isUsingSorter = true;
			const sorterIndex = this.ephemeralSortingIndex;
			// Iterate the sorter BTree
			const sorterTree = sorterIndex.data as unknown as BTree<BTreeKey, MemoryTableRow>; // Get BTree from MemoryIndex
			this.sorterResults = []; // Clear previous sorter results
			this.sorterIndex = -1;
			try {
				// Iterate the sorter BTree (which is implicitly sorted)
				// TODO: Respect ORDER BY direction if needed (sorter currently assumes ASC)
				const iterator = sorterTree.ascending(sorterTree.first());
				for (const path of iterator) {
					const row = sorterTree.at(path);
					if (row) {
						// Apply remaining constraints NOT handled by the sort key itself
						// This part is tricky - how do we know which constraints apply?
						// Assume for now that sorter is only used when WHERE clause is simple or absent.
						// If complex filters needed post-sort, VDBE might handle it.
						// Let's assume constraints *are* handled by VDBE after sort for now.
						this.sorterResults.push(row); // Store row copy
					}
				}
			} catch (e) {
				// Use namespaced error logger
				errorLog("Error iterating ephemeral sorter index: %O", e);
				this.reset(); // Clear state on error
				throw e instanceof SqliteError ? e : new SqliteError(`Sorter iteration error: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
			}

			// Set initial sorter position
			if (this.sorterResults.length > 0) {
				this.sorterIndex = 0;
				this._isEof = false;
			} else {
				this._isEof = true;
			}
			return; // Skip normal layer cursor creation
		}
		// -------------------------------------------- //

		// --- Normal Layer-Based Scan --- //
		this.isUsingSorter = false;
		try {
			// 1. Build the ScanPlan (now uses simplified EQ logic)
			const plan = this.buildScanPlan(idxNum, idxStr, constraints, args, indexInfo);

			// 2. Create the internal layer cursor chain using the connection
			this.internalCursor = this.connection.createLayerCursor(plan);

			// 3. Set initial EOF state from the internal cursor
			this._isEof = this.internalCursor.isEof();

		} catch (e) {
			// Use namespaced error logger
			errorLog(`Error during MemoryTableCursor filter (idxNum=%d, idxStr=%s): %O`, idxNum, idxStr, e);
			this.reset(); // Ensure cursor is reset on error
			throw e instanceof SqliteError ? e : new SqliteError(`Filter error: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
		}
	}

	async next(): Promise<void> {
		if (this._isEof) return;

		if (this.isUsingSorter) {
			// Advance sorter cursor
			if (this.sorterIndex >= this.sorterResults.length - 1) {
				this._isEof = true;
				this.sorterIndex = this.sorterResults.length; // Position after end
			} else {
				this.sorterIndex++;
				this._isEof = false;
			}
		} else {
			// Advance internal layer cursor
			if (!this.internalCursor) {
				this._isEof = true; // Should not happen if filter succeeded
				return;
			}
			try {
				await this.internalCursor.next();
				this._isEof = this.internalCursor.isEof();
			} catch (e) {
				// Use namespaced error logger
				errorLog("Error during internal cursor next(): %O", e);
				this.reset(); // Reset cursor state on error
				throw e instanceof SqliteError ? e : new SqliteError(`Cursor next error: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
			}
		}
	}

	/** Gets the currently pointed-to row */
	private getCurrentRow(): MemoryTableRow | null {
		if (this._isEof) return null;

		if (this.isUsingSorter) {
			if (this.sorterIndex < 0 || this.sorterIndex >= this.sorterResults.length) {
				return null;
			}
			return this.sorterResults[this.sorterIndex];
		} else {
			return this.internalCursor?.getCurrentRow() ?? null;
		}
	}

	column(context: SqliteContext, columnIndex: number): number {
		const row = this.getCurrentRow();
		if (!row) {
			// Per SQLite docs, behavior is undefined if called when EOF.
			// Returning NULL seems safest.
			// warnLog("MemoryTableCursor.column() called while EOF.");
			context.resultNull();
			return StatusCode.OK; // Or MISUSE? OK seems standard.
		}

		const schema = this.table.getSchema();
		if (!schema) {
			context.resultError("Internal error: Table schema not available in cursor", StatusCode.INTERNAL);
			return StatusCode.INTERNAL;
		}

		if (columnIndex === -1) {
			// Requesting rowid
			context.resultInt64(row._rowid_);
			return StatusCode.OK;
		}

		if (columnIndex < 0 || columnIndex >= schema.columns.length) {
			context.resultError(`Invalid column index ${columnIndex}`, StatusCode.RANGE);
			return StatusCode.RANGE;
		}
		const columnName = schema.columns[columnIndex].name;

		// Access row property. Handle potential missing columns gracefully (e.g., after ALTER ADD).
		const value = Object.prototype.hasOwnProperty.call(row, columnName) ? row[columnName] : null;
		context.resultValue(value ?? null); // Ensure null is passed if property is undefined
		return StatusCode.OK;
	}

	async rowid(): Promise<bigint> {
		const row = this.getCurrentRow();
		if (row === null) {
			// Match SQLite C API behavior - accessing rowid when EOF is an error
			throw new SqliteError("Cursor is not pointing to a valid row", StatusCode.MISUSE);
		}
		return row._rowid_;
	}

	async close(): Promise<void> {
		// Ensure sorter index is cleared if it was temporary
		if (this.ephemeralSortingIndex) {
			// No need to explicitly drop from manager as it wasn't added there.
			// GC should handle the MemoryIndex instance.
			this.ephemeralSortingIndex = null;
		}
		this.reset(); // Reset handles internal cursor close
	}

	// --- Optional Seek Methods --- //
	// Seek operations are complex with the layer model and internal cursors.
	// Implementing them efficiently would likely require modifications to the
	// LayerCursorInternal interface and implementations.
	// For now, leave them as not implemented.

	async seekRelative(offset: number): Promise<boolean> {
		// Use namespaced warn logger
		warnLog("seekRelative() not implemented for layered model.");
		throw new SqliteError(`seekRelative not implemented by MemoryTableCursor (layered)`, StatusCode.INTERNAL);
	}

	async seekToRowid(rowid: bigint): Promise<boolean> {
		// Use namespaced warn logger
		warnLog("seekToRowid() not implemented for layered model.");
		throw new SqliteError(`seekToRowid not implemented by MemoryTableCursor (layered)`, StatusCode.INTERNAL);
	}
}

