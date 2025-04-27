import { Opcode } from './opcodes.js';
import type { FunctionSchema } from '../schema/function.js';
import type { TableSchema } from '../schema/table.js';
import type { ConflictResolution } from '../common/constants.js';
import type { SchemaChangeInfo } from '../vtab/module.js';

/**
 * Represents a single instruction in the VDBE program.
 * Mimics the structure of SQLite's VdbeOp.
 */
export interface VdbeInstruction {
	/** The operation code */
	opcode: Opcode;
	/** First operand */
	p1: number;
	/** Second operand */
	p2: number;
	/** Third operand */
	p3: number;
	/** Fourth operand (often a string, pointer, or complex object) */
	p4: any | null;
	/** Fifth operand (typically flags or counts) */
	p5: number;
	/** Optional comment for debugging/explanation */
	comment?: string;
}

/**
 * Creates a VDBE instruction.
 *
 * @param opcode The operation code
 * @param p1 Operand 1
 * @param p2 Operand 2
 * @param p3 Operand 3
 * @param p4 Operand 4 (type varies by opcode)
 * @param p5 Operand 5 (typically flags)
 * @param comment Optional descriptive comment
 * @returns The created instruction object
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

// --- P4 Operand Types ---

/** P4 operand for Opcode.Function */
export interface P4FuncDef {
	/** The actual function definition/callbacks */
	funcDef: FunctionSchema;
	/** Number of arguments expected */
	nArgs: number;
	/** Discriminant type */
	type: 'funcdef';
}

/** P4 operand for virtual table opcodes */
export interface P4Vtab {
	/** Store the resolved schema */
	tableSchema: TableSchema;
	/** Discriminant type */
	type: 'vtab';
}

/** P4 operand for collation sequence */
export interface P4Coll {
	/** Collation sequence name (e.g., "BINARY", "NOCASE") */
	name: string;
	/** Discriminant type */
	type: 'coll';
}

/** P4 operand for key information */
export interface P4KeyInfo {
	/** Discriminant type */
	type: 'keyinfo';
}

/** P4 operand for sorting with MemoryTable */
export interface P4SortKey {
	/** Indices of columns in the input row used for sorting */
	keyIndices: ReadonlyArray<number>;
	/** Sort direction for each key column (true for DESC) */
	directions: ReadonlyArray<boolean>;
	/** Optional collation names for each key column */
	collations?: ReadonlyArray<string | undefined>;
	/** Discriminant type */
	type: 'sortkey';
}

/** P4 operand for Opcode.VUpdate */
export interface P4Update {
	/** Conflict resolution strategy */
	onConflict: ConflictResolution;
	/** The schema of the table being updated */
	table: TableSchema;
	/** Discriminant type */
	type: 'update';
}

/** P4 operand for Opcode.OpenTvf */
export interface P4OpenTvf {
	/** Name of table-valued function module */
	moduleName: string;
	/** Alias for the TVF in the current query */
	alias: string;
	/** Discriminant type */
	type: 'opentvf';
}

// --- Placeholder P4 Types ---
export type P4JumpTarget = any;
export type P4IndexDef = any;
export type P4TableDef = any;
export type P4ViewDef = any;
export type P4FunctionContext = any;

/** P4 type for SchemaChange */
export type P4SchemaChange = SchemaChangeInfo;

/** Union type for all possible P4 operands */
export type P4Operand =
	| P4Coll
	| P4FuncDef
	| P4SortKey
	| TableSchema
	| P4SchemaChange
	| P4IndexDef
	| P4TableDef
	| P4ViewDef
	| P4OpenTvf
	| string
	| number
	| null;
