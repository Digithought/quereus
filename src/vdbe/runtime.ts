import { StatusCode, type SqlValue } from '../common/types.js';
import { SqliteError } from '../common/errors.js';
import type { Database } from '../core/database.js';
import type { Statement } from '../core/statement.js';
import type { VdbeProgram } from './program.js';
import { FunctionContext } from '../func/context.js';
import type { VmCtx, VdbeCursor, MemoryCell } from './handler-types.js';
import { handlers } from './handlers.js';
import { Opcode } from './opcodes.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('vdbe:runtime');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * Represents an execution instance of a VDBE program.
 * Uses a stack-based memory model with activation frames.
 */
export class VdbeRuntime implements VmCtx {
  // Public properties required by VmCtx interface
  readonly db: Database;
  readonly program: VdbeProgram;
  readonly stmt: Statement;
  readonly vtabContext: FunctionContext;
  readonly udfContext: FunctionContext;

  // VM state
  framePointer: number = 0;
  stackPointer: number = 0;
  pc: number = 0;
  done: boolean = false;
  hasYielded: boolean = false;
  error?: SqliteError;

  // Internal state
  private stack: MemoryCell[] = [];
  private vdbeCursors: VdbeCursor[] = [];
  private appliedBindings: boolean = false;
  private readonly localsStartOffset = 2; // Locals start after control info
  aggregateContexts?: Map<string, { accumulator: any, keyValues: ReadonlyArray<SqlValue> }>;
  aggregateIterator?: Iterator<[string, { accumulator: any; keyValues: ReadonlyArray<SqlValue>; }]>;
  currentAggregateEntry?: [string, { accumulator: any; keyValues: ReadonlyArray<SqlValue>; }] | null;

  constructor(stmt: Statement, program: VdbeProgram) {
    this.stmt = stmt;
    this.db = stmt.db;
    this.program = program;
    this.vtabContext = new FunctionContext(this.db);
    this.udfContext = new FunctionContext(this.db);

    // Initialize Stack
    const initialStackSize = Math.max(program.numMemCells + 100, 1000);
    this.stack = new Array(initialStackSize).fill(null).map(() => ({ value: null }));
    this.stackPointer = 0;
    this.framePointer = 0; // Main frame starts at 0

    // Initialize cursors
    this.vdbeCursors = new Array(program.numCursors).fill(null).map(() => ({
      instance: null,
      vtab: null,
      isEphemeral: false,
      sortedResults: null
    }));

    // --- Initialize aggregate contexts --- //
    this.aggregateContexts = new Map();
  }

  /**
   * Applies bound parameters to the runtime stack.
   * @param bindings Map of parameter names/indices to values
   */
  applyBindings(bindings: Map<number | string, SqlValue>): void {
    if (this.appliedBindings) return;
    bindings.forEach((value, key) => {
      const paramInfo = this.program.parameters.get(key);
      const stackIndex = paramInfo?.memIdx; // Absolute index from compiler
      if (stackIndex !== undefined && stackIndex >= 0) {
        this.setStackValue(stackIndex, value);
      } else {
        warnLog(`Could not map parameter %s to stack cell`, key);
      }
    });
    this.appliedBindings = true;
  }

  /**
   * Clears the applied bindings flag.
   */
  clearAppliedBindings(): void {
    this.appliedBindings = false;
  }

  /**
   * Resets the VM to its initial state.
   */
  async reset(): Promise<void> {
    this.pc = 0;
    this.stackPointer = 0;
    this.framePointer = 0;
    this.appliedBindings = false;
    this.hasYielded = false;
    this.done = false;
    this.error = undefined;
    this.udfContext._clear();
    this.udfContext._cleanupAuxData();
    this.aggregateContexts?.clear();
    this.aggregateIterator = undefined;
    this.currentAggregateEntry = null;

    const closePromises: Promise<void>[] = [];
    for (let i = 0; i < this.vdbeCursors.length; i++) {
      const cursor = this.vdbeCursors[i];
      if (cursor.sortedResults) cursor.sortedResults = null;
      if (cursor.instance) closePromises.push(cursor.instance.close());
      this.vdbeCursors[i] = { instance: null, vtab: null, sortedResults: null };
    }
    await Promise.allSettled(closePromises);
  }

  /**
   * Executes the VDBE program until completion or a yield point.
   * @returns Status code indicating execution result
   */
  async run(): Promise<StatusCode> {
    if (this.done || this.error) {
      return this.error?.code ?? StatusCode.MISUSE;
    }
    this.hasYielded = false;

    try {
      if (!this.appliedBindings) {
        // Apply empty bindings if none were provided
        this.applyBindings(new Map());
      }

      const code = this.program.instructions;

      // Main execution loop
      while (this.pc < code.length) {
        const currentPc = this.pc; // Store PC at start of iteration
        const inst = code[currentPc];

        if (!inst) {
          this.error = new SqliteError(`Invalid program counter: ${currentPc}`, StatusCode.INTERNAL);
          break;
        }

        const p4Str = inst.p4 ? JSON.stringify(inst.p4, (key, value) =>
          typeof value === 'bigint' ? value.toString() + 'n' : value // Append 'n' for clarity
        ).substring(0, 150) : '';
        const comment = inst.comment ? `// ${inst.comment}` : '';
        log(
          '[%s] %s P1=%d P2=%d P3=%d P4=%s P5=%d %s',
          currentPc.toString().padStart(3),
          Opcode[inst.opcode]?.padEnd(15) ?? 'UNKNOWN',
          inst.p1,
          inst.p2,
          inst.p3,
          p4Str,
          inst.p5,
          comment
        );

        // Get the handler for this opcode
        const handler = handlers[inst.opcode];
        if (!handler) {
            this.error = new SqliteError(`No handler found for opcode ${inst.opcode} (${Opcode[inst.opcode]})`, StatusCode.INTERNAL);
            break;
        }

        // Execute the handler
        const result = handler(this, inst);
        let status: StatusCode | undefined = undefined;

        // Only await when the handler returns a Promise
        if (result instanceof Promise) {
          status = await result;
        } else {
          status = result;
        }

        // Check if handler returned a status code
        if (status !== undefined) {
          return status;
        }

        // Check if the instruction yielded a row
        if (this.hasYielded) {
          this.hasYielded = false; // Reset for next step
          if (this.pc === currentPc) { // Ensure handler didn't already jump
            this.pc++;
          }
          return StatusCode.ROW;
        }

        // Post-execution checks
        if (this.done) {
          return StatusCode.DONE;
        }
        if (this.error) {
          return (this.error as SqliteError).code ?? StatusCode.MISUSE;
        }

        // Update program counter if the handler didn't change it
        if (this.pc === currentPc) {
          this.pc++;
        }
      }
    } catch (e) {
      errorLog('VDBE Execution Error: %O', e);
      if (e instanceof SqliteError) {
        this.error = e;
      } else if (e instanceof Error) {
        this.error = new SqliteError(`Runtime error: ${e.message}`, StatusCode.ERROR);
      } else {
        this.error = new SqliteError("Unknown runtime error", StatusCode.INTERNAL);
      }
      this.done = true;
    }

    // Determine final status
    if (this.error) {
      return this.error.code as StatusCode;
    }
    if (this.pc >= this.program.instructions.length && !this.done) {
        this.done = true;
    }
    return this.done ? StatusCode.DONE : StatusCode.INTERNAL;
  }

  // --- VmCtx Implementation ---

  /**
   * Sets a value at an absolute stack index.
   */
  setStackValue(index: number, value: SqlValue): void {
    if (index < 0) throw new SqliteError(`Invalid stack write index ${index}`, StatusCode.INTERNAL);

    // Ensure stack capacity
    while (index >= this.stack.length) {
      const newLength = Math.max(this.stack.length * 2, index + 1);
      const oldLength = this.stack.length;
      this.stack.length = newLength;
      // Initialize new cells
      for (let i = oldLength; i < newLength; i++) {
        this.stack[i] = { value: null };
      }
    }

    // Update stack pointer if writing beyond current top
    this.stackPointer = Math.max(this.stackPointer, index + 1);

    // Deep copy blobs, other values are immutable or primitives
    this.stack[index].value = (value instanceof Uint8Array) ? value.slice() : value;
  }

  /**
   * Gets a value from an absolute stack index.
   */
  getStackValue(index: number): SqlValue {
    if (index < 0 || index >= this.stack.length) {
      return null;
    }
    if (index >= this.stackPointer) {
      return null;
    }
    return this.stack[index]?.value ?? null;
  }

  /**
   * Gets a value relative to the frame pointer.
   */
  getMem(offset: number): SqlValue {
    const stackIndex = this.framePointer + offset;
    return this.getStackValue(stackIndex);
  }

  /**
   * Sets a value relative to the frame pointer.
   */
  setMem(offset: number, value: SqlValue): void {
    // Locals should be at or above localsStartOffset
    if (offset < this.localsStartOffset) {
      throw new SqliteError(`Write attempt to control info/argument area: Offset=${offset}`, StatusCode.INTERNAL);
    }
    const stackIndex = this.framePointer + offset;
    this.setStackValue(stackIndex, value);
  }

  /**
   * Pushes a value onto the stack.
   */
  pushStack(value: SqlValue): void {
    this.setStackValue(this.stackPointer, value);
  }

  /**
   * Gets a cursor by index.
   */
  getCursor(idx: number): VdbeCursor | undefined {
    return this.vdbeCursors[idx];
  }

  /**
   * Gets a constant from the program constants pool.
   */
  getConstant(idx: number): SqlValue {
    return this.program.constants[idx];
  }
}
