import type { VirtualTable } from './table.js';
import type { SqliteContext } from '../func/context.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import { SqliteError } from '../common/errors.js';
import type { IndexConstraint, IndexInfo } from './indexInfo.js';

/**
 * Base class for virtual table cursors.
 * Module implementations should subclass this to provide specific iteration behavior.
 *
 * @template TTable Type of the VirtualTable this cursor belongs to
 */
export abstract class VirtualTableCursor<
	TTable extends VirtualTable
> {
	public readonly table: TTable;
	protected _isEof: boolean = true;

	constructor(table: TTable) {
		this.table = table;
	}

	/** Checks if the cursor has reached the end of the result set */
	eof(): boolean {
		return this._isEof;
	}

	/**
	 * Starts or restarts a search/scan on the virtual table
	 *
	 * @param idxNum The index number chosen by xBestIndex
	 * @param idxStr The index string chosen by xBestIndex
	 * @param constraints The list of constraints relevant to this plan, linked to their arg index
	 * @param args Values corresponding to constraints marked in xBestIndex
	 * @throws SqliteError on failure
	 * @param indexInfo Full IndexInfo object from xBestIndex (contains aConstraintUsage, etc.)
	 */
	abstract filter(
		idxNum: number,
		idxStr: string | null,
		constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>,
		args: ReadonlyArray<SqlValue>,
		indexInfo: IndexInfo
	): Promise<void>;

	/**
	 * Advances the cursor to the next row in the result set
	 * Sets internal EOF state
	 *
	 * @throws SqliteError on failure
	 */
	abstract next(): Promise<void>;

	/**
	 * Returns the value for the specified column of the current row
	 * This method MUST be synchronous as it's called during result processing
	 *
	 * @param context Context for setting the result (use context.result*(...))
	 * @param i The column index (0-based)
	 * @returns StatusCode.OK on success, or an error code
	 */
	abstract column(context: SqliteContext, i: number): number;

	/**
	 * Returns the rowid for the current row
	 *
	 * @returns The rowid as bigint
	 * @throws SqliteError if cursor is not positioned on a valid row
	 */
	abstract rowid(): Promise<bigint>;

	/**
	 * Closes the cursor and releases any resources
	 *
	 * @throws SqliteError on failure
	 */
	abstract close(): Promise<void>;

	/**
	 * Seeks the cursor forward or backward by a relative offset from current position
	 * Used by window functions (ROWS frames, LAG/LEAD) and other operations
	 *
	 * @param offset The relative offset (positive for forward, negative for backward)
	 * @returns true if seek was successful, false if cursor moved out of bounds
	 * @throws SqliteError if seeking is not supported or other errors occur
	 */
	async seekRelative(offset: number): Promise<boolean> {
		throw new SqliteError(`seekRelative not implemented by this cursor type (${this.constructor.name})`, StatusCode.INTERNAL);
	}

	/**
	 * Seeks the cursor directly to the row matching the specified rowid
	 * Used for efficient cursor position restoration
	 *
	 * @param rowid The target rowid to seek to
	 * @returns true if seek was successful, false if rowid not found
	 * @throws SqliteError if seeking is not supported or other errors occur
	 */
	async seekToRowid(rowid: bigint): Promise<boolean> {
		throw new SqliteError(`seekToRowid not implemented by this cursor type (${this.constructor.name})`, StatusCode.INTERNAL);
	}
}
