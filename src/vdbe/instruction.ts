import { Opcode } from '../common/constants';
import type { SqlValue } from '../common/types';
import type { FunctionSchema } from '../schema/function';
import type { TableSchema } from '../schema/table';
import type { ConflictResolution } from '../common/constants';
import type * as AST from '../parser/ast';
import type { IndexConstraintOp } from '../common/constants';
import type { SchemaChangeInfo } from '../vtab/module';

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

/** P4 operand for Opcode.VUpdate */
export interface P4Update {
	/** Conflict resolution strategy */
	onConflict: ConflictResolution;
	/** The schema of the table being updated */
	table: TableSchema;
	/** Discriminant type */
	type: 'update';
}

// Add more P4 types as needed (P4_MEM, P4_INTARRAY, P4_SUBPROGRAM, etc.)

// --- Define missing placeholder P4 types --- //
export type P4JumpTarget = any; // Placeholder - likely number (address)
export type P4IndexDef = any; // Placeholder - structure defining index
export type P4TableDef = any; // Placeholder - structure defining table
export type P4ViewDef = any; // Placeholder - structure defining view
export type P4FunctionContext = any; // Placeholder - context for function call
// ----------------------------------------- //

// --- Add P4 type for SchemaChange (before union) --- //
export type P4SchemaChange = SchemaChangeInfo;
// --------------------------------------------------- //

/** Union type for all possible P4 operands */
export type P4Operand =
	| P4Coll
	| P4FuncDef
	| P4SortKey
	| TableSchema // For OpenWrite etc.
	| P4SchemaChange // For SchemaChange
	| P4IndexDef // For CreateIndex
	| P4TableDef // For CreateTable
	| P4ViewDef // For CreateView
	| string // Simple string operand (e.g., Pragma name)
	| number // Simple numeric operand
	| null; // No operand
