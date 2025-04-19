import { type SqlValue, StatusCode } from '../common/types';
import { SqliteError } from '../common/errors';
import type { Database } from '../core/database';

/**
 * Represents the execution context passed to user-defined SQL functions
 * (scalar, aggregate, window) and to the xColumn method of virtual tables.
 * Provides methods for setting results and accessing auxiliary data.
 *
 * Methods that set a result should typically be the last action taken by
 * a function implementation before returning. Setting multiple results or
 * setting a result then throwing an error leads to undefined behavior.
 */
export interface SqliteContext {
    /**
     * Sets the result of the function to a BLOB value.
     * @param value The BLOB data.
     * @param destructor Optional hint (e.g., SQLITE_STATIC, SQLITE_TRANSIENT).
     *                   In TS, this might influence whether the engine copies the buffer.
     *                   Default behavior should probably be to copy (TRANSIENT).
     */
    resultBlob(value: Uint8Array, destructor?: unknown): void;

    /**
     * Sets the result of the function to a floating-point value (JavaScript number).
     * @param value The double value.
     */
    resultDouble(value: number): void;

    /**
     * Causes the function to return an error state. The engine will typically
     * catch this and stop execution, propagating the error.
     * @param message The error message string.
     * @param code Optional specific error code (defaults to ERROR).
     */
    resultError(message: string, code?: StatusCode): void;

    /**
     * Sets the result of the function to a 32-bit integer value.
     * Note: JavaScript numbers are doubles; the engine might need to perform
     * truncation or range checks based on how strictly it adheres to C API behavior.
     * For larger integers, use resultInt64.
     * @param value The integer value.
     */
    resultInt(value: number): void;

    /**
     * Sets the result of the function to a 64-bit integer value (JavaScript bigint).
     * @param value The bigint value.
     */
    resultInt64(value: bigint): void;

    /**
     * Sets the result of the function to SQL NULL.
     */
    resultNull(): void;

    /**
     * Sets the result of the function to a TEXT value (JavaScript string).
     * @param value The string value.
     * @param destructor Optional hint (e.g., SQLITE_STATIC, SQLITE_TRANSIENT).
     *                   Influences whether the engine copies the string. Default: copy.
     */
    resultText(value: string, destructor?: unknown): void;

    /**
     * Sets the result of the function to be a copy of the provided SqlValue.
     * This is a convenient way to return values without specific type coercion.
     * @param value The SqlValue to set as the result.
     */
    resultValue(value: SqlValue): void;

    /**
     * Sets the result to a zero-filled BLOB of a specified size.
     * Primarily for incremental BLOB I/O placeholders (likely out of scope).
     * @param n The desired size of the zeroblob in bytes.
     */
    resultZeroblob(n: number): void; // Consider bigint for n? C API uses int.

    /**
     * Sets the application-defined subtype for the result value.
     * Subtypes can be used to convey extra application-specific type information.
     * @param subtype An unsigned integer representing the subtype. Only lower bits might be preserved.
     */
    resultSubtype(subtype: number): void;

    /**
     * Returns the user data pointer associated with the function registration.
     * This was the `pApp` argument provided when registering the function.
     * @returns The user data specified during registration.
     */
    getUserData(): unknown;

    /**
     * Returns the Database connection handle associated with this context.
     * Provides access to the main DB API if needed (use with caution).
     */
    getDbConnection(): Database;

    /**
     * Gets auxiliary data previously associated with a function argument by `setAuxData`.
     * Used for caching computations across multiple calls to the same function
     * with the same argument value within a single query execution.
     * @param N The argument index (0-based).
     * @returns The stored auxiliary data, or undefined if none exists or it was cleared.
     */
    getAuxData(N: number): unknown;

    /**
     * Sets auxiliary data associated with a specific function argument.
     * The data is typically cleared when the argument value changes or the statement is reset/finalized.
     * @param N The argument index (0-based).
     * @param data The arbitrary data to store.
     * @param destructor Optional cleanup function called when the data is discarded by the engine.
     */
    setAuxData(N: number, data: unknown, destructor?: (data: unknown) => void): void;

    // --- Potentially add aggregate context methods if aggregates are implemented ---
    // getAggregateContext(nBytes: number): ArrayBuffer | undefined;
}

/**
 * Concrete implementation used by the engine. Not directly exposed to UDF authors,
 * they interact via the SqliteContext interface.
 * @internal
 */
export class FunctionContext implements SqliteContext {
    private _result: SqlValue | undefined = undefined;
    private _result_set = false;
    private _error: SqliteError | null = null;
    private _subtype: number = 0;
    private userData: unknown;
    private db: Database;
    // Simple map for aux data; a real implementation might need WeakMap or different scoping
    private auxData: Map<number, { data: unknown, destructor?: (data: unknown) => void }> = new Map();

    constructor(db: Database, userData?: unknown) {
        this.db = db;
        this.userData = userData;
    }

    // --- Result Accessors (Internal use by engine) ---
    _getResult(): SqlValue | null {
        if (this._error) throw this._error;
        return this._result_set ? this._result! : null; // Return null if nothing was explicitly set
    }
    _getError(): SqliteError | null { return this._error; }
    _getSubtype(): number { return this._subtype; }

    _clear(): void {
        // Does NOT clear auxData - that persists across calls within a query
        this._result = undefined;
        this._result_set = false;
        this._error = null;
        this._subtype = 0;
    }

    // --- Public API Implementation ---

    private setResult(value: SqlValue) {
        if (this._result_set || this._error) return; // Prevent overwriting result/error
        this._result = value;
        this._result_set = true;
    }

    resultBlob(value: Uint8Array): void { this.setResult(value); }
    resultDouble(value: number): void { this.setResult(value); }
    resultError(message: string, code: StatusCode = StatusCode.ERROR): void {
        if (this._result_set || this._error) return;
        this._error = new SqliteError(message, code);
    }
    resultInt(value: number): void { this.setResult(Math.trunc(value)); }
    resultInt64(value: bigint): void { this.setResult(value); }
    resultNull(): void { this.setResult(null); }
    resultText(value: string): void { this.setResult(value); }
    resultValue(value: SqlValue): void { this.setResult(value); }
    resultZeroblob(n: number): void { this.setResult(new Uint8Array(n)); }
    resultSubtype(subtype: number): void { this._subtype = subtype >>> 0; } // Ensure unsigned integer

    getUserData(): unknown { return this.userData; }
    getDbConnection(): Database { return this.db; }


    getAuxData(N: number): unknown {
        return this.auxData.get(N)?.data;
    }

    setAuxData(N: number, data: unknown, destructor?: (data: unknown) => void): void {
        if (this._error) return; // Don't modify if already in error state? C API allows? Check.
        const existing = this.auxData.get(N);
        if (existing?.destructor && existing.data !== data) { // Only call destructor if data changes
            try { existing.destructor(existing.data); } catch (e) { console.error("Internal: AuxData destructor failed", e); }
        }
        if (data === undefined && destructor === undefined) {
             this.auxData.delete(N);
        } else {
             // Potential OOM simulation point if needed later
            this.auxData.set(N, { data, destructor });
        }
    }

    /** @internal Cleans up auxiliary data - called by engine when appropriate (e.g., statement reset/finalize) */
    _cleanupAuxData(): void {
         this.auxData.forEach(entry => {
            if (entry.destructor) {
                try { entry.destructor(entry.data); } catch (e) { console.error("Internal: AuxData destructor failed", e); }
            }
         });
         this.auxData.clear();
    }
}
