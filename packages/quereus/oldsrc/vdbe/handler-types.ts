import { QuereusError } from '../common/errors.js';
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
 * Represents a single VDBE memory cell (register).
 */
export interface MemoryCell {
  value: SqlValue;
}

/**
 * Internal state for a VDBE cursor.
 */
export interface VdbeCursor {
  /** The cursor's virtual table instance */
  instance: VirtualTableCursor<any> | null;
  /** The associated virtual table */
  vtab: VirtualTable | null;
  /** Whether this is an ephemeral cursor (temp table) */
  isEphemeral?: boolean;
  /** Optionally pre-materialized rows for sorting/grouped data */
  sortedResults?: { rows: MemoryCell[][], index: number } | null;
  /** Optional sorting index */
  sortingIndex?: MemoryIndex | null;
  /** Target address for VFilter/Rewind to jump to on EOF, used by VNext */
  currentEofJumpTarget?: number;
}

/**
 * Status result from a handler function.
 * - undefined means continue execution (PC was handled by handler)
 * - StatusCode means stop execution with this result
 */
export type Status = StatusCode | undefined;

/**
 * Interface for the VM execution context accessible to handlers.
 * This abstracts the internal state of the VM for use by opcode handlers.
 */
export interface VmCtx {
  // Core state
  /** The database connection */
  readonly db: Database;
  /** The program being executed */
  readonly program: VdbeProgram;
  /** The statement being executed */
  readonly stmt: Statement;
  /** Program counter - current instruction address */
  pc: number;
  /** Whether execution is complete */
  done: boolean;
  /** Whether execution has yielded a row */
  hasYielded: boolean;
  /** Error encountered during execution, if any */
  error?: QuereusError;

  // Stack and registers
  /** Gets a value from a register, relative to frame pointer */
  getMem(offset: number): SqlValue;
  /** Sets a value in a register, relative to frame pointer */
  setMem(offset: number, value: SqlValue): void;
  /** Pushes a value onto the stack */
  pushStack(value: SqlValue): void;

  // Cursor access
  /** Gets a cursor by index */
  getCursor(idx: number): VdbeCursor | undefined;

  // Helper contexts
  /** Context for virtual table operations */
  readonly vtabContext: FunctionContext;
  /** Context for UDF function calls */
  readonly udfContext: FunctionContext;

  // Frame management
  /** Current frame pointer */
  framePointer: number;
  /** Current stack pointer */
  stackPointer: number;

  // Special getters/setters for absolute stack access
  /** Gets a value at an absolute stack index */
  getStack(index: number): SqlValue;
  /** Sets a value at an absolute stack index */
  setStack(index: number, value: SqlValue): void;

  // Constants access
  /** Gets a constant from the program's constant pool */
  getConstant(idx: number): SqlValue;

  // Aggregate state
  /** Map of aggregate contexts for GROUP BY */
  aggregateContexts?: Map<string, { accumulator: any, keyValues: ReadonlyArray<SqlValue> }>;
  /** Iterator for aggregate processing */
  aggregateIterator?: Iterator<[string, { accumulator: any, keyValues: ReadonlyArray<SqlValue> }]> | null;
  /** Current aggregate entry during iteration */
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
