import { type SqlValue, StatusCode } from '../common/types.js';
import { MisuseError, SqliteError } from '../common/errors.js';
import type { Database } from './database.js';
import { SqlDataType } from '../common/constants.js';
import { Parser, ParseError } from '../parser/parser.js';
import { Compiler } from '../compiler/compiler.js';
import { type VdbeProgram } from '../vdbe/program.js';
import { VdbeRuntime } from '../vdbe/runtime.js';
import type { MemoryCell } from '../vdbe/handler-types.js';

/**
 * Represents a prepared SQL statement.
 */
export class Statement {
	public readonly db: Database;
	public readonly sql: string;
	private finalized = false;
	private busy = false; // True if step has been called but not reset/finalized/done
	private boundParameters: Map<number | string, SqlValue> = new Map();
	private columnNames: string[] = []; // Populated after first successful step
	private currentRowInternal: MemoryCell[] | null = null; // Store raw MemoryCells from VDBE
	private vdbeProgram: VdbeProgram | null = null;
	private vdbe: VdbeRuntime | null = null;
	private needsCompile = true;

	/**
	 * @internal - Use db.prepare()
	 * Pass program directly only when creating transient statements inside db.exec()
	 */
	constructor(db: Database, sql: string, program?: VdbeProgram) {
		this.db = db;
		this.sql = sql;
		if (program) {
			this.vdbeProgram = program;
			this.needsCompile = false;
		}
	}

	/** @internal */
	public async compile(): Promise<VdbeProgram> {
		if (this.vdbeProgram && !this.needsCompile) { return this.vdbeProgram; }
		if (this.finalized) { throw new MisuseError("Statement finalized"); }
		console.log("Compiling statement...");
		this.vdbeProgram = null;

		try {
			const parser = new Parser();
			const ast = parser.parse(this.sql);

			const compiler = new Compiler(this.db);
			this.vdbeProgram = compiler.compile(ast, this.sql);

			this.needsCompile = false;
			console.log("Compilation complete.");
		} catch (e) {
			console.error("Compilation failed:", e);
			// Convert errors to SqliteError if they aren't already
			if (e instanceof SqliteError) {
				throw e;
			} else if (e instanceof ParseError) {
				throw new SqliteError(`Parse error: ${e.message}`, StatusCode.ERROR);
			} else if (e instanceof Error) {
				throw new SqliteError(`Compilation error: ${e.message}`, StatusCode.INTERNAL);
			} else {
				throw new SqliteError("Unknown compilation error", StatusCode.INTERNAL);
			}
		}

		if (!this.vdbeProgram) {
			throw new SqliteError("Compilation resulted in no program", StatusCode.INTERNAL);
		}

		return this.vdbeProgram;
	}

	/**
	 * Binds a value to a parameter index (1-based) or name.
	 * Implementation for both overloads.
	 */
	bind(key: number | string, value: SqlValue): this {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.busy) throw new MisuseError("Statement busy");
		if (typeof key === 'number') {
			if (key < 1) throw new RangeError(`Parameter index ${key} out of range (must be >= 1)`);
			this.boundParameters.set(key, value);
		} else if (typeof key === 'string') {
			this.boundParameters.set(key, value);
		} else {
			throw new MisuseError("Invalid parameter key type");
		}
		// If VDBE exists, potentially apply binding immediately
		if (this.vdbe) {
			this.vdbe.clearAppliedBindings(); // Mark bindings as needing re-application
			this.vdbe.applyBindings(this.boundParameters);
		}
		return this;
	}

	/**
	 * Binds multiple parameters from an array or object.
	 * @param params An array of values (for positional ?) or an object (for named :name, $name).
	 * @returns This statement instance for chaining.
	 */
	bindAll(params: SqlValue[] | Record<string, SqlValue>): this {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.busy) throw new MisuseError("Statement busy");

		if (Array.isArray(params)) {
			// Bind by position (1-based index)
			for (let i = 0; i < params.length; i++) {
				this.bind(i + 1, params[i]);
			}
		} else if (typeof params === 'object' && params !== null) {
			// Bind by name
			for (const key in params) {
				if (Object.prototype.hasOwnProperty.call(params, key)) {
					this.bind(key, params[key]);
				}
			}
		} else {
			throw new MisuseError("Invalid parameters type for bindAll. Use array or object.");
		}

		return this;
	}

	/**
	 * Returns the status code from the VDBE execution (ROW, DONE, or error code).
	 * @throws MisuseError if the statement is finalized.
	 */
	async step(): Promise<StatusCode> {
		if (this.finalized) throw new MisuseError("Statement finalized");
		await this.compile(); // Ensures vdbeProgram is available

		// Initialize VDBE if this is the first step
		if (!this.vdbe && this.vdbeProgram) {
			this.vdbe = new VdbeRuntime(this, this.vdbeProgram);
			// Apply any bindings set *before* the first step
			this.vdbe.applyBindings(this.boundParameters);
		}

		if (!this.vdbe) {
			// Should not happen if compile succeeded
			throw new SqliteError("VDBE not initialized after compile", StatusCode.INTERNAL);
		}

		// Reset internal statement state for step
		this.busy = true;
		this.currentRowInternal = null; // Clear previous row before stepping

		// Execute the VDBE until it yields a row, completes, or errors
		const status = await this.vdbe.run();

		// After VDBE returns a status:
		if (status === StatusCode.ROW) {
			// Row is ready
			if (!this.currentRowInternal) {
				this.busy = false;
				throw new SqliteError("VDBE returned ROW but setCurrentRow failed to store data", StatusCode.INTERNAL);
			}
			console.log(`Step result: ${StatusCode[status]}`);
			return StatusCode.ROW;
		} else if (status === StatusCode.DONE || status === StatusCode.OK) {
			// Execution finished successfully (DONE for SELECT/yielding, OK for non-yielding like INSERT/PRAGMA)
			this.busy = false;
			this.currentRowInternal = null;
			console.log(`Step result: ${StatusCode[status]}`);
			return status;
		} else {
			// Any other status indicates an error reported by vdbe.run()
			this.busy = false;
			this.currentRowInternal = null;
			const errorDetail = this.vdbe?.error?.message || `Status code ${status}`;
			console.error(`VDBE execution failed: ${errorDetail}`);
			// Re-throw the error, preserving the original code if available
			throw this.vdbe?.error || new SqliteError(`VDBE execution failed with status: ${StatusCode[status] || status}`, status);
		}
	}

	/** @internal Called by VDBE ResultRow opcode */
	setCurrentRow(memCells: MemoryCell[]): void {
		// Store the raw memory cells for potential later type/subtype access
		this.currentRowInternal = memCells;
	}

	/**
	 * Retrieves all column values for the current row as an array.
	 * Should only be called after step() returns ROW. Consider using the
	 * higher-level get() or all() methods for simpler fetch patterns.
	 * @returns An array of SqlValue.
	 * @throws MisuseError if step() did not return ROW.
	 */
	getArray(): SqlValue[] {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (!this.currentRowInternal) throw new MisuseError("No row available");
		return this.currentRowInternal.map(cell => cell.value);
	}

	/**
	 * Retrieves all column values for the current row as an object
	 * with column names as keys.
	 * Should only be called after step() returns ROW. Consider using the
	 * higher-level get() or all() methods for simpler fetch patterns.
	 * @returns An object mapping column names to values.
	 * @throws MisuseError if step() did not return ROW or if column names are not available.
	 */
	getAsObject(): Record<string, SqlValue> {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (!this.currentRowInternal) throw new MisuseError("No row available");
		const names = this.vdbeProgram?.columnNames || []; // Get names from program
		if (names.length === 0 && this.currentRowInternal.length > 0) {
			// Fallback if compiler didn't set names (should not happen ideally)
			return this.currentRowInternal.reduce((acc, cell, i) => {
				acc[`col_${i}`] = cell.value;
				return acc;
			}, {} as Record<string, SqlValue>);
		}
		if (names.length !== this.currentRowInternal.length) {
			throw new SqliteError(`Column name/value count mismatch (${names.length} vs ${this.currentRowInternal.length})`, StatusCode.INTERNAL);
		}
		const obj: Record<string, SqlValue> = {};
		for (let i = 0; i < names.length; i++) {
			const name = names[i];
			const value = this.currentRowInternal[i].value;
			if (!(name in obj)) { obj[name] = value; }
		}
		return obj;
	}

	/**
	 * Gets the names of the columns in the result set.
	 * Available after the first successful step() call that returns ROW or after compilation.
	 * @returns An array of column names.
	 */
	getColumnNames(): string[] {
		if (this.finalized) throw new MisuseError("Statement finalized");
		return [...(this.vdbeProgram?.columnNames || [])];
	}

	/**
	 * Resets the prepared statement to its initial state, ready to be re-executed.
	 * Retains bound parameter values.
	 * @returns A Promise resolving on completion.
	 * @throws MisuseError if the statement is finalized.
	 */
	async reset(): Promise<void> {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.vdbe) { await this.vdbe.reset(); } // Wait for cursor closing
		this.currentRowInternal = null;
		this.busy = false;
		this.needsCompile = false; // Program is still valid
	}

	/**
	 * Clears all bound parameter values, setting them to NULL.
	 * @returns This statement instance for chaining.
	 * @throws MisuseError if the statement is finalized or busy.
	 */
	clearBindings(): this {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.busy) throw new MisuseError("Statement busy - reset first");
		this.boundParameters.clear();
		if (this.vdbe) { this.vdbe.clearAppliedBindings(); }
		return this;
	}

	/**
	 * Finalizes the statement, releasing associated resources.
	 * This statement instance should not be used after calling finalize.
	 * @returns A promise resolving on completion.
	 */
	async finalize(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		this.busy = false;
		if (this.vdbe) { await this.vdbe.reset(); } // Ensure cursors are closed
		this.boundParameters.clear();
		this.currentRowInternal = null;
		this.vdbeProgram = null;
		this.vdbe = null;
		this.db._statementFinalized(this);
	}

	/**
	 * Executes the prepared statement with the given parameters until completion.
	 * This is a convenience method that binds parameters, steps through all rows,
	 * and resets the statement. It does not return rows. Ideal for INSERT, UPDATE, DELETE.
	 *
	 * @param params Optional parameters (array for positional, object for named).
	 * @returns A Promise resolving when execution is complete.
	 * @throws MisuseError if statement is finalized or busy.
	 * @throws SqliteError if execution fails.
	 */
	async run(params?: SqlValue[] | Record<string, SqlValue>): Promise<void> {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.busy) throw new MisuseError("Statement busy - already running?");

		if (params) {
			this.bindAll(params); // Use existing bindAll
		}

		try {
			let status: StatusCode;
			do {
				status = await this.step(); // Use existing step
				if (status === StatusCode.ROW) {
					// Row produced, clear it and continue stepping
					this.currentRowInternal = null;
				} else if (status !== StatusCode.DONE && status !== StatusCode.OK) {
					// Error occurred during step
					throw new SqliteError("Execution failed during run()", status);
				}
			} while (status === StatusCode.ROW);
			// Status is DONE or OK here
		} finally {
			// Always reset the statement after run, even if it failed,
			// making it ready for another run with potentially different params.
			await this.reset();
		}
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves the first result row.
	 * Useful for queries expected to return at most one row (e.g., SELECT...LIMIT 1).
	 * The statement is automatically reset after execution.
	 *
	 * @param params Optional parameters (array for positional, object for named).
	 * @returns A Promise resolving to the first result row (as an object), or undefined if no rows are returned.
	 * @throws MisuseError if statement is finalized or busy.
	 * @throws SqliteError if execution fails.
	 */
	async get(params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue> | undefined> {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.busy) throw new MisuseError("Statement busy - already running?");

		if (params) {
			this.bindAll(params);
		}

		let result: Record<string, SqlValue> | undefined = undefined;
		try {
			const status = await this.step();
			if (status === StatusCode.ROW) {
				result = this.getAsObject(); // Use existing getAsObject
			} else if (status !== StatusCode.DONE && status !== StatusCode.OK) {
				throw new SqliteError("Execution failed during get()", status);
			}
			// Consume any potential subsequent rows if the user didn't LIMIT 1
			let remainingStatus: StatusCode = status;
			while (remainingStatus === StatusCode.ROW) {
				remainingStatus = await this.step();
				// Check for expected status codes
				if (remainingStatus !== StatusCode.ROW &&
					remainingStatus !== StatusCode.DONE &&
					remainingStatus !== StatusCode.OK) {
					// Error consuming remaining rows
					console.warn(`Error consuming remaining rows after get(): ${StatusCode[remainingStatus]}`);
					// Throw or just proceed to reset? Let's proceed for now.
					break;
				}
			}
		} finally {
			await this.reset();
		}
		return result;
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves all result rows.
	 * This is a convenience method that simplifies fetching all results into an array.
	 * The statement is automatically reset after execution.
	 *
	 * @param params Optional parameters (array for positional, object for named).
	 * @returns A Promise resolving to an array of result rows (as objects).
	 * @throws MisuseError if statement is finalized or busy.
	 * @throws SqliteError if execution fails.
	 */
	async all(params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue>[]> {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.busy) throw new MisuseError("Statement busy - already running?");

		if (params) {
			this.bindAll(params);
		}

		const results: Record<string, SqlValue>[] = [];
		try {
			let status: StatusCode;
			do {
				status = await this.step();
				if (status === StatusCode.ROW) {
					results.push(this.getAsObject()); // Use existing getAsObject
				} else if (status !== StatusCode.DONE && status !== StatusCode.OK) {
					throw new SqliteError("Execution failed during all()", status);
				}
			} while (status === StatusCode.ROW);
		} finally {
			await this.reset();
		}
		return results;
	}

	/**
	 * Returns the number of parameters in the prepared statement.
	 * @returns Number of parameters or 0 if none.
	 */
	getParameterCount(): number {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.needsCompile && !this.vdbeProgram) {
			// If not compiled yet, we don't know parameter count
			return 0;
		}
		return this.vdbeProgram?.parameters.size || 0;
	}

	/**
	 * Gets the name of a parameter by its index.
	 * @param index The 1-based index of the parameter.
	 * @returns The parameter name, or null if the parameter is positional or not found.
	 */
	getParameterName(index: number): string | null {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (index < 1) throw new RangeError("Parameter index must be >= 1");
		if (this.needsCompile && !this.vdbeProgram) return null;

		// Look through parameters for a string key mapping to this index
		for (const [key, value] of this.vdbeProgram?.parameters || []) {
			if (typeof key === 'string' && value.memIdx === index) {
				return key;
			}
		}
		return null;
	}

	/**
	 * Gets the index of a named parameter.
	 * @param name The parameter name (with or without : or $ prefix).
	 * @returns The 1-based index of the parameter, or null if not found.
	 */
	getParameterIndex(name: string): number | null {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (!name) throw new MisuseError("Parameter name cannot be empty");
		if (this.needsCompile && !this.vdbeProgram) return null;

		const info = this.vdbeProgram?.parameters.get(name);
		return info ? info.memIdx : null;
	}

	/**
	 * Gets the data type of a column in the current row.
	 * @param index The 0-based index of the column.
	 * @returns The SQL data type.
	 * @throws MisuseError if no row is available or index is out of range.
	 */
	getColumnType(index: number): SqlDataType {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (!this.currentRowInternal) throw new MisuseError("No row available");
		if (index < 0 || index >= this.currentRowInternal.length) {
			throw new RangeError(`Column index ${index} out of range (0-${this.currentRowInternal.length - 1})`);
		}
		// Return the data type of the cell at the given index
		const value = this.currentRowInternal[index].value;

		if (value === null) return SqlDataType.NULL;
		if (typeof value === 'number') return SqlDataType.REAL;
		if (typeof value === 'bigint') return SqlDataType.INTEGER;
		if (typeof value === 'string') return SqlDataType.TEXT;
		if (value instanceof Uint8Array) return SqlDataType.BLOB;
		if (typeof value === 'boolean') return SqlDataType.INTEGER; // Booleans are stored as integers

		// Fallback for any unexpected type
		return SqlDataType.TEXT;
	}

	/**
	 * Gets the name of a column by its index.
	 * @param index The 0-based index of the column.
	 * @returns The column name, or a generated name if not available.
	 * @throws RangeError if index is out of range.
	 */
	getColumnName(index: number): string {
		if (this.finalized) throw new MisuseError("Statement finalized");
		const names = this.vdbeProgram?.columnNames || [];
		if (index < 0 || (names.length > 0 && index >= names.length)) {
			throw new RangeError(`Column index ${index} out of range (0-${names.length - 1})`);
		}
		return names[index] || `col_${index}`;
	}

	/**
	 * Gets the byte length of a BLOB or TEXT column value.
	 * @param index The 0-based index of the column.
	 * @returns The byte length, or 0 for NULL values.
	 * @throws MisuseError if no row is available.
	 * @throws RangeError if index is out of range.
	 */
	getColumnBytes(index: number): number {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (!this.currentRowInternal) throw new MisuseError("No row available");
		if (index < 0 || index >= this.currentRowInternal.length) {
			throw new RangeError(`Column index ${index} out of range (0-${this.currentRowInternal.length - 1})`);
		}

		const value = this.currentRowInternal[index].value;
		if (value === null) return 0;
		if (value instanceof Uint8Array) return value.byteLength;
		if (typeof value === 'string') return new TextEncoder().encode(value).length;

		// For other types, convert to string first
		return new TextEncoder().encode(String(value)).length;
	}
}
