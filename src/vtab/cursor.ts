import type { VirtualTable } from './table';
import type { SqliteContext } from '../func/context';
import { StatusCode, type SqlValue } from '../common/types';
import { SqliteError } from '../common/errors';
import type { IndexConstraint } from './indexInfo';

/**
 * Base class (or interface) for virtual table cursors.
 * Module implementations will typically subclass this.
 *
 * @template TTable Type of the VirtualTable this cursor belongs to.
 * @template TCursor Self-referential type for the cursor implementation.
 */
export abstract class VirtualTableCursor<
	TTable extends VirtualTable,
	TCursor extends VirtualTableCursor<TTable, TCursor> = any // Default to any for simpler cases
> {
	public readonly table: TTable; // Reference back to the table instance
	protected _isEof: boolean = true; // Protected state for EOF tracking

	constructor(table: TTable) {
		this.table = table;
	}

	/** Checks if the cursor has reached the end of the result set. */
	eof(): boolean {
		return this._isEof;
	}

	/**
	 * Start or restart a search/scan on the virtual table.
	 * @param idxNum The index number chosen by xBestIndex.
	 * @param idxStr The index string chosen by xBestIndex.
	 * @param constraints The list of constraints relevant to this plan, linked to their arg index.
	 * @param args Values corresponding to constraints marked in xBestIndex.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	abstract filter(
		idxNum: number,
		idxStr: string | null,
		constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>,
		args: ReadonlyArray<SqlValue>
	): Promise<void>;

	/**
	 * Advance the cursor to the next row in the result set.
	 * Sets internal EOF state.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	abstract next(): Promise<void>;

	/**
	 * Return the value for the i-th column of the current row.
	 * This method MUST be synchronous as it's called during result processing.
	 * @param context Context for setting the result (use context.result*(...)).
	 * @param i The column index (0-based).
	 * @returns StatusCode.OK on success, or an error code.
	 */
	abstract column(context: SqliteContext, i: number): number; // Sync

	/**
	 * Return the rowid for the current row.
	 * @returns A promise resolving to the rowid (as bigint) or throwing an error.
	 * @throws SqliteError on failure.
	 */
	abstract rowid(): Promise<bigint>;

	/**
	 * Close the virtual table cursor, releasing any resources.
	 * @returns A promise resolving on completion or throwing an error.
	 * @throws SqliteError on failure.
	 */
	abstract close(): Promise<void>;

	/**
	 * Optional: Seeks the cursor forward or backward by a relative offset from its current position.
	 * This operates on the result set established by the last filter call.
	 * Used by the VDBE for window functions (ROWS frames, LAG/LEAD) and potentially other operations.
	 * If not implemented, operations requiring relative seeking will fail for this module.
	 * Sets internal EOF state based on seek result.
	 * @param offset The relative offset (positive for forward, negative for backward).
	 * @returns A promise resolving to true if the seek was successful and the cursor points to a valid row,
	 *          false if the seek moved the cursor out of bounds (before the first or after the last row).
	 * @throws SqliteError on underlying errors during seeking.
	 */
	async seekRelative(offset: number): Promise<boolean> {
		// Default implementation: throw error if not overridden
		throw new SqliteError(`seekRelative not implemented by this cursor type (${this.constructor.name})`, StatusCode.INTERNAL);
	}

	/**
	 * Optional: Seeks the cursor directly to the row matching the specified rowid.
	 * This operates on the result set established by the last filter call.
	 * Used by the VDBE for efficient cursor position restoration.
	 * If not implemented, operations requiring direct rowid seeking might be slower or fail.
	 * Sets internal EOF state based on seek result.
	 * @param rowid The target rowid to seek to.
	 * @returns A promise resolving to true if the seek was successful and the cursor points to the target row,
	 *          false if the rowid was not found in the cursor's current result set.
	 * @throws SqliteError on underlying errors during seeking.
	 */
	async seekToRowid(rowid: bigint): Promise<boolean> {
		// Default implementation: throw error if not overridden
		throw new SqliteError(`seekToRowid not implemented by this cursor type (${this.constructor.name})`, StatusCode.INTERNAL);
	}
}
