import type { VdbeInstruction } from './instruction.js';
import type { SqlValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('vdbe:program');
const warnLog = log.extend('warn');

/**
 * Represents a compiled VDBE program.
 * Contains the instructions and associated metadata needed for execution.
 */
export interface VdbeProgram {
	/** The sequence of instructions */
	readonly instructions: ReadonlyArray<VdbeInstruction>;

	/** Number of memory cells (registers) required */
	readonly numMemCells: number;

	/** Number of cursors required */
	readonly numCursors: number;

	/** Constants used by the program (strings, numbers, etc.) */
	readonly constants: ReadonlyArray<SqlValue>;

	/** Information about bound parameters (name/index -> target memory cell) */
	readonly parameters: ReadonlyMap<string | number, { memIdx: number }>;

	/** The original SQL source */
	readonly sql: string;

	/** Names of the result columns */
	readonly columnNames: ReadonlyArray<string>;

	// TODO: Add other necessary metadata:
	// - Sub-programs (for triggers, etc.)
	// - Stack depth requirements?
	// - Information about result columns (names, types?)
}

/**
 * Builder for VDBE programs during compilation.
 * @internal
 */
export class VdbeProgramBuilder {
	private _instructions: VdbeInstruction[] = [];
	private _numMemCells: number = 0;
	private _numCursors: number = 0;
	private _constants: SqlValue[] = [];
	private _parameters: Map<string | number, { memIdx: number }> = new Map();
	private _columnNames: string[] = [];
	private _sql: string;

	/**
	 * Creates a new program builder.
	 * @param sql The SQL statement being compiled
	 */
	constructor(sql: string) {
		this._sql = sql;
	}

	/**
	 * Adds an instruction to the program.
	 * @param instruction The instruction to add
	 * @returns The address (index) of the added instruction
	 */
	addInstruction(instruction: VdbeInstruction): number {
		this._instructions.push(instruction);
		return this._instructions.length - 1;
	}

	/**
	 * Gets an instruction at the specified address.
	 * @param address The instruction address
	 * @returns The instruction, or undefined if not found
	 */
	getInstruction(address: number): VdbeInstruction | undefined {
		return this._instructions[address];
	}

	/**
	 * Updates the P2 parameter of an instruction.
	 * Typically used for fixing jump targets.
	 * @param address The instruction address
	 * @param p2 The new P2 value
	 */
	updateInstructionP2(address: number, p2: number): void {
		const instruction = this._instructions[address];
		if (instruction) {
			instruction.p2 = p2;
		} else {
			warnLog(`Attempted to update non-existent instruction at address %d`, address);
		}
	}

	/**
	 * Gets the current instruction count.
	 * @returns The next instruction address
	 */
	getCurrentAddress(): number {
		return this._instructions.length;
	}

	/**
	 * Sets the required number of memory cells.
	 * @param count The required memory cell count
	 */
	setRequiredMemCells(count: number): void {
		this._numMemCells = Math.max(this._numMemCells, count);
	}

	/**
	 * Sets the required number of cursors.
	 * @param count The required cursor count
	 */
	setRequiredCursors(count: number): void {
		this._numCursors = Math.max(this._numCursors, count);
	}

	/**
	 * Adds a constant to the program's constant pool.
	 * @param value The constant value to add
	 * @returns The index of the added constant
	 */
	addConstant(value: SqlValue): number {
		this._constants.push(value);
		return this._constants.length - 1;
	}

	/**
	 * Registers a parameter with its memory cell location.
	 * @param name The parameter name or index
	 * @param memIdx The memory cell index for this parameter
	 */
	registerParameter(name: string | number, memIdx: number): void {
		this._parameters.set(name, { memIdx });
	}

	/**
	 * Sets the column names for the result set.
	 * @param names The column names
	 */
	setColumnNames(names: string[]): void {
		this._columnNames = [...names];
	}

	/**
	 * Builds and returns the immutable program.
	 * @returns The built VDBE program
	 */
	build(): VdbeProgram {
		return {
			instructions: Object.freeze([...this._instructions]),
			numMemCells: this._numMemCells,
			numCursors: this._numCursors,
			constants: Object.freeze([...this._constants]),
			parameters: Object.freeze(new Map(this._parameters)),
			columnNames: Object.freeze([...this._columnNames]),
			sql: this._sql,
		};
	}
}
