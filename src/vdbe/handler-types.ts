import { SqliteError } from '../common/errors.js';
import type { StatusCode, SqlValue } from '../common/types.js';
import type { Database } from '../core/database.js';
import type { FunctionContext } from '../func/context.js';
import type { VdbeInstruction } from './instruction.js';
import type { VdbeProgram } from './program.js';
import type { VirtualTable } from '../vtab/table.js';
import type { VirtualTableCursor } from '../vtab/cursor.js';
import type { MemoryIndex } from '../vtab/memory/index.js';
import type { Statement } from '../core/statement.js';

/**
 * Represents a single VDBE memory cell (register)
 */
export interface MemoryCell {
  value: SqlValue;
}

/**
 * Internal state for a VDBE cursor
 */
export interface VdbeCursor {
  instance: VirtualTableCursor<any> | null;
  vtab: VirtualTable | null;
  isEphemeral?: boolean;
  sortedResults?: { rows: MemoryCell[][], index: number } | null;
  sortingIndex?: MemoryIndex | null;
}

/**
 * Status result from a handler function.
 * - undefined means continue execution (PC was handled by handler)
 * - StatusCode means stop execution with this result
 */
export type Status = StatusCode | undefined;

/**
 * Interface for the VM execution context accessible to handlers.
 * This abstracts the internal state of the VM for use by handlers.
 */
export interface VmCtx {
  // Core state
  readonly db: Database;
  readonly program: VdbeProgram;
  readonly stmt: Statement;
  pc: number;
  done: boolean;
  hasYielded: boolean;
  error?: SqliteError;

  // Stack and registers
  getMem(offset: number): SqlValue;
  setMem(offset: number, value: SqlValue): void;
  pushStack(value: SqlValue): void;

  // Cursor access
  getCursor(idx: number): VdbeCursor | undefined;

  // Helper contexts
  readonly vtabContext: FunctionContext;
  readonly udfContext: FunctionContext;

  // Frame management
  framePointer: number;
  stackPointer: number;

  // Special getters/setters for internal engine operations
  getStackValue(index: number): SqlValue;
  setStackValue(index: number, value: SqlValue): void;

  // Access to constants
  getConstant(idx: number): SqlValue;

  // Aggregate state (optional, might be managed internally by VmCtx impl)
  aggregateContexts?: Map<string, { accumulator: any, keyValues: ReadonlyArray<SqlValue> }>;
  aggregateIterator?: Iterator<[string, { accumulator: any, keyValues: ReadonlyArray<SqlValue> }]> | null;
  currentAggregateEntry?: [string, { accumulator: any, keyValues: ReadonlyArray<SqlValue> }] | null;
}

/**
 * Synchronous handler function type.
 */
export type HandlerSync = (ctx: VmCtx, i: VdbeInstruction) => Status;

/**
 * Asynchronous handler function type.
 */
export type HandlerAsync = (ctx: VmCtx, i: VdbeInstruction) => Promise<Status>;

/**
 * Union type for both handler types.
 */
export type Handler = HandlerSync | HandlerAsync;
