import type { VdbeInstruction } from './instruction';
import type { SqlValue } from '../common/types';

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
    readonly constants: ReadonlyArray<SqlValue>; // For Opcode.String, Opcode.Int, etc.

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
 * Simple builder for VDBE programs during compilation.
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

    constructor(sql: string) {
        this._sql = sql;
    }

    addInstruction(instruction: VdbeInstruction): number {
        this._instructions.push(instruction);
        return this._instructions.length - 1; // Return address of instruction
    }

    getInstruction(address: number): VdbeInstruction | undefined {
        return this._instructions[address];
    }

    updateInstructionP2(address: number, p2: number): void {
        const instruction = this._instructions[address];
        if (instruction) {
            instruction.p2 = p2;
        } else {
            console.warn(`Attempted to update non-existent instruction at address ${address}`);
        }
    }

    getCurrentAddress(): number {
         return this._instructions.length; // Next instruction address
    }


    setRequiredMemCells(count: number): void {
        this._numMemCells = Math.max(this._numMemCells, count);
    }

    setRequiredCursors(count: number): void {
        this._numCursors = Math.max(this._numCursors, count);
    }

    addConstant(value: SqlValue): number {
        // TODO: Could optimize by reusing existing constants
        this._constants.push(value);
        return this._constants.length - 1; // Return index
    }

    registerParameter(name: string | number, memIdx: number): void {
         // Store the memory cell index where the parameter's value should be placed
        this._parameters.set(name, { memIdx });
    }

    setColumnNames(names: string[]): void {
        this._columnNames = [...names];
    }

    build(): VdbeProgram {
        return {
            instructions: Object.freeze([...this._instructions]),
            numMemCells: this._numMemCells,
            numCursors: this._numCursors,
            constants: Object.freeze([...this._constants]),
            parameters: Object.freeze(new Map(this._parameters)), // Make map readonly
            columnNames: Object.freeze([...this._columnNames]), // Freeze column names
            sql: this._sql,
        };
    }
}
