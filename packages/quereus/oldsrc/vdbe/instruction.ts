import { Opcode } from './opcodes.js';
import type { FunctionSchema } from '../schema/function.js';
import type { TableSchema } from '../schema/table.js';
import type { ConflictResolution } from '../common/constants.js';
import type { SchemaChangeInfo } from '../vtab/module.js';
import type * as AST from '../parser/ast.js';

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

/** P4 operand type for Function/AggStep/AggFinal */
export interface P4FuncDef { type: 'funcdef', funcDef: FunctionSchema, nArgs: number }

/** P4 operand type for comparisons using specific collation */
export interface P4Coll { type: 'coll', name: string }

/** P4 operand type for sort key definitions */
export interface P4SortKey {
	type: 'sortkey';
	keyIndices: number[];
	collations?: string[];
	directions: boolean[]; // true for DESC
}

/** P4 operand type for VUpdate */
export interface P4Update {
	type: 'update';
	onConflict: ConflictResolution;
	table: TableSchema;
}

/** P4 operand type for OpenTvf */
export interface P4OpenTvf {
	alias: string;
	moduleName: string;
	type: 'opentvf';
}

/** P4 operand type for OpenRead/OpenWrite (VTab info) */
export interface P4Vtab { type: 'vtab', tableSchema: TableSchema }

/** P4 operand type for DropTable/DropIndex/DropView */
export interface P4DropInfo {
	type: 'dropInfo'; // Add type discriminator
	schemaName: string;
	name: string; // Table, index, or view name
	ifExists: boolean;
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
