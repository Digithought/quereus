import { Opcode } from '../common/constants';
import type { SqlValue } from '../common/types';
import type { FunctionSchema } from '../schema/function';
import type { TableSchema } from '../schema/table';
import type * as AST from '../parser/ast';

/**
 * Represents a single instruction in the VDBE program.
 * Mimics the structure of SQLite's VdbeOp.
 */
export interface VdbeInstruction {
	/** The operation code (e.g., Halt, Goto, Column, ResultRow) */
	opcode: Opcode;
	/** First operand */
	p1: number;
	/** Second operand */
	p2: number;
	/** Third operand */
	p3: number;
	/** Fourth operand (often a string, pointer, or complex object) */
	p4: any | null; // Type depends heavily on the opcode
	/** Fifth operand (added later in SQLite, can store extra info) */
	p5: number; // Typically flags or counts
	/** Optional comment for debugging/explanation (not used by execution) */
	comment?: string;
}

/**
 * Creates a VDBE instruction.
 * @param opcode The operation code.
 * @param p1 Operand 1.
 * @param p2 Operand 2.
 * @param p3 Operand 3.
 * @param p4 Operand 4 (optional, type varies).
 * @param p5 Operand 5 (optional, flags).
 * @param comment Optional descriptive comment.
 */
export function createInstruction(
	opcode: Opcode,
	p1: number = 0,
	p2: number = 0,
	p3: number = 0,
	p4: any | null = null,
	p5: number = 0,
	comment?: string
): VdbeInstruction {
	return { opcode, p1, p2, p3, p4, p5, comment };
}

// --- Concrete types for P4 operands ---

/** P4 operand for Opcode.Function */
export interface P4FuncDef {
	funcDef: FunctionSchema; // The actual function definition/callbacks
	nArgs: number; // Number of arguments expected (or taken from funcDef?)
	type: 'funcdef';
}

/** Placeholder for P4 when it refers to a virtual table cursor (or its schema?) */
export interface P4Vtab {
	tableSchema: TableSchema; // Store the resolved schema
	type: 'vtab';
}

/** Placeholder for P4 when it refers to collation sequence */
export interface P4Coll {
	name: string; // Collation sequence name (e.g., "BINARY", "NOCASE")
	type: 'coll';
}

/** Placeholder for P4 storing multiple values (e.g., for comparisons) */
export interface P4KeyInfo {
	// columns: { index: number, sortOrder: 'ASC' | 'DESC', collation?: P4Coll }[];
	type: 'keyinfo';
}

/** Placeholder for P4 when sorting using MemoryTable */
export interface P4SortKey {
	/** Indices of columns in the input row used for sorting */
	keyIndices: ReadonlyArray<number>;
	/** Sort direction for each key column (true for DESC) */
	directions: ReadonlyArray<boolean>;
	/** Optional collation names for each key column */
	collations?: ReadonlyArray<string | undefined>;
	type: 'sortkey';
}

// Add more P4 types as needed (P4_MEM, P4_INTARRAY, P4_SUBPROGRAM, etc.)

/** P4 operand for Opcode.AggFrame */
export interface P5AggFrameInfo {
	type: 'aggframeinfo';
	funcDef: FunctionSchema;
	argIdx: number; // Index of the aggregate function argument in the sorter row, or -1 if none (e.g., COUNT(*))
	nArgs: number; // Original number of args passed to the function (might be redundant with funcDef)
}

/** P4 operand for Opcode.RangeScan */
export interface P4RangeScanInfo {
	type: 'rangescaninfo';
	frameDef: AST.WindowFrame; // The AST definition for the frame
	orderByIndices: number[]; // Indices of ORDER BY columns in the sorter row
	orderByDirs: boolean[]; // Directions (true=DESC) for ORDER BY columns
	orderByColls: (string | undefined)[]; // Collations for ORDER BY columns
	currPtrReg: number; // Register holding the pointer/rowid of the current row being processed
	partStartPtrReg: number; // Register holding the pointer/rowid of the first row in the partition
	startBoundReg?: number; // Optional register holding the bound value for START N PRECEDING/FOLLOWING
	endBoundReg?: number; // Optional register holding the bound value for END N PRECEDING/FOLLOWING
}

/** P4 operand for Opcode.Lag / Opcode.Lead */
export interface P4LagLeadInfo {
	type: 'lagleadinfo';
	currRowPtrReg: number; // Register holding the pointer/rowid of the current row being processed
	argColIdx: number; // Index of the argument column in the sorter row
}
