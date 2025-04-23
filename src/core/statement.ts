import { type SqlValue, StatusCode } from '../common/types';
import { MisuseError, SqliteError, SyntaxError } from '../common/errors';
import type { Database } from './database';
// Placeholder for VDBE execution result
// import { VdbeResult } from '../vdbe/engine';

// --- Add VDBE imports ---
import { type VdbeProgram, VdbeProgramBuilder } from '../vdbe/program';
import { Vdbe, type MemoryCell } from '../vdbe/engine';
import { createInstruction, type P4Vtab } from '../vdbe/instruction'; // For placeholder compile
import { Opcode, IndexConstraintOp } from '../common/constants'; // For placeholder compile
// ------------------------

import type { SelectStmt, ResultColumn, Expression, BinaryExpr, ColumnExpr } from '../parser/ast'; // Corrected imports
import type { TableSchema } from '../schema/table';
import type { IndexInfo, IndexConstraint, IndexConstraintUsage } from '../vtab/indexInfo';
import { Parser } from '../parser/parser';
import { Compiler } from '../compiler/compiler';
import type { AstNode } from '../parser/ast'; // Type-only import

// Helper type guard for parameters in AST
function isParameter(value: SqlValue | { type: 'parameter', key: number | string }): value is { type: 'parameter', key: number | string } {
	return typeof value === 'object' && value !== null && value.hasOwnProperty('type') && (value as any).type === 'parameter';
}

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

	// --- Add VDBE program and engine references ---
	private vdbeProgram: VdbeProgram | null = null;
	private vdbe: Vdbe | null = null;
	private needsCompile = true;
	// -----------------------------------------------

	/** @internal */
	constructor(db: Database, sql: string) {
		this.db = db;
		this.sql = sql;
		// Defer compilation until first step or explicit compile call
	}

	/** @internal */
	private async compile(): Promise<VdbeProgram> {
		if (this.vdbeProgram && !this.needsCompile) { return this.vdbeProgram; }
		if (this.finalized) { throw new MisuseError("Statement finalized"); }
		console.log("Compiling statement...");
		this.vdbeProgram = null;

		try {
			// --- Use Real Parser & Compiler ---
			const parser = new Parser();
			const ast = parser.parse(this.sql);

			// TODO: Check if the AST is supported before compiling
			// e.g., if (!(ast.type === 'select' || ast.type === 'insert')) { ... }

			const compiler = new Compiler(this.db);
			this.vdbeProgram = compiler.compile(ast, this.sql);
			// ----------------------------------

			this.needsCompile = false;
			console.log("Compilation complete.");
			// Optional: Log generated program for debugging
			// console.log("Generated Program:", this.vdbeProgram.instructions.map(i => `${Opcode[i.opcode]} ${i.p1} ${i.p2} ${i.p3} ${i.p4 !== null ? ` P4:${JSON.stringify(i.p4)}` : ''}`).join('\n'));
		} catch (e) {
			console.error("Compilation failed:", e);
			// Convert errors to SqliteError if they aren't already
			if (e instanceof SqliteError) {
				throw e;
			} else if (e instanceof Error) {
				// Distinguish between ParseError and other errors
				const errorCode = (e.name === 'ParseError') ? StatusCode.ERROR : StatusCode.INTERNAL;
				throw new SqliteError(`Compilation error: ${e.message}`, errorCode);
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
		// Binding might require re-compilation in complex cases, but not for this simple compiler
		// this.needsCompile = true;
		if (typeof key === 'number') {
			if (key < 1) throw new RangeError(`Parameter index ${key} out of range (must be >= 1)`);
			this.boundParameters.set(key, value);
		} else if (typeof key === 'string') {
			this.boundParameters.set(key, value);
		} else {
			throw new MisuseError("Invalid parameter key type");
		}
		// If VDBE exists, potentially apply binding immediately? Or let step handle it.
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
					// Ensure key starts with : or $ if it's a named param identifier
					// (Though our simple parser/compiler might not enforce this)
					this.bind(key, params[key]);
				}
			}
		} else {
			throw new MisuseError("Invalid parameters type for bindAll. Use array or object.");
		}

		return this;
	}

	/**
	 * Executes the next step of the prepared statement.
	 * @returns A Promise resolving to a StatusCode (ROW, DONE, or an error code).
	 * @throws MisuseError if the statement is finalized.
	 */
	async step(): Promise<StatusCode> {
		if (this.finalized) throw new MisuseError("Statement finalized");
		await this.compile();
		if (!this.vdbeProgram) throw new SqliteError("Compilation failed", StatusCode.INTERNAL);
		if (!this.vdbe) {
			this.vdbe = new Vdbe(this, this.vdbeProgram);
			this.vdbe.applyBindings(this.boundParameters); // Apply initial bindings
		}
		this.busy = true;
		this.currentRowInternal = null;
		const status = await this.vdbe.run();
		if (status !== StatusCode.ROW) { this.busy = false; }
		console.log(`Step result: ${StatusCode[status]}`);
		return status;
	}

	/** @internal Called by VDBE ResultRow opcode */
	_setCurrentRow(memCells: MemoryCell[]): void {
		// Store the raw memory cells for potential later type/subtype access
		this.currentRowInternal = memCells;
		// Could also extract simple values here if preferred
	}


	/**
	 * Retrieves all column values for the current row as an array.
	 * Should only be called after step() returns ROW.
	 * @returns An array of SqlValue.
	 * @throws MisuseError if step() did not return ROW.
	 */
	get(): SqlValue[] {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (!this.currentRowInternal) throw new MisuseError("No row available");
		return this.currentRowInternal.map(cell => cell.value);
	}

	/**
	 * Retrieves all column values for the current row as an object
	 * with column names as keys.
	 * Should only be called after step() returns ROW.
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
			if (!(name in obj)) { obj[name] = this.currentRowInternal[i].value; }
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
		// Compile if needed to get column names
		if (this.needsCompile && !this.vdbeProgram) {
			// This path is tricky - compile is async, but this method is sync.
			// Require step() to be called first, or make this async?
			// Let's assume compile was called or names are available from program.
			console.warn("Fetching column names might require prior step() or compilation");
		}
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

	// TODO: Add methods like getParameterCount(), getParameterName(), getParameterIndex() if needed
	// TODO: Add sqlite3_column_* equivalent methods if direct column access is desired beyond get()/getAsObject()

}
