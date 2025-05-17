import type { VirtualTable } from './table.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { SqliterError } from '../common/errors.js';
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
	 * Returns an async iterable that yields each row for the current filter settings.
	 * filter() must be called before iterating.
	 * @returns An AsyncIterable yielding Row objects.
	 */
	abstract rows(): AsyncIterable<Row>;

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
	async seekRelative(_offset: number): Promise<boolean> {
		throw new SqliterError(`seekRelative not implemented by this cursor type (${this.constructor.name})`, StatusCode.INTERNAL);
	}

	/**
	 * Seeks the cursor directly to the row matching the specified rowid
	 * Used for efficient cursor position restoration
	 *
	 * @param rowid The target rowid to seek to
	 * @returns true if seek was successful, false if rowid not found
	 * @throws SqliteError if seeking is not supported or other errors occur
	 */
	async seekToRowid(_rowid: bigint): Promise<boolean> {
		throw new SqliterError(`seekToRowid not implemented by this cursor type (${this.constructor.name})`, StatusCode.INTERNAL);
	}
}
