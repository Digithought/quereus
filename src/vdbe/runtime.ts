import { StatusCode, type SqlValue } from '../common/types.js';
import { SqliteError } from '../common/errors.js';
import type { Database } from '../core/database.js';
import type { Statement } from '../core/statement.js';
import type { VdbeProgram } from './program.js';
import { FunctionContext } from '../func/context.js';
import type { VmCtx, VdbeCursor, MemoryCell } from './handler-types.js';
import { handlers } from './handlers.js';

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
  }

  /** Apply bound parameters. Parameters are placed at absolute stack indices. */
  applyBindings(bindings: Map<number | string, SqlValue>): void {
    if (this.appliedBindings) return;
    bindings.forEach((value, key) => {
      const paramInfo = this.program.parameters.get(key);
      const stackIndex = paramInfo?.memIdx; // Absolute index from compiler
      if (stackIndex !== undefined && stackIndex >= 0) {
        // Parameters are generally for the main frame, access directly.
        this.setStackValue(stackIndex, value);
      } else {
        console.warn(`Could not map parameter ${key} to stack cell`);
      }
    });
    this.appliedBindings = true;
  }

  /**
   * Clear the applied bindings flag
   */
  clearAppliedBindings(): void {
    this.appliedBindings = false;
  }

  /** Resets the VM to its initial state */
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

    const closePromises: Promise<void>[] = [];
    for (let i = 0; i < this.vdbeCursors.length; i++) {
      const cursor = this.vdbeCursors[i];
      if (cursor.sortedResults) cursor.sortedResults = null;
      if (cursor.instance) closePromises.push(cursor.instance.close());
      this.vdbeCursors[i] = { instance: null, vtab: null, sortedResults: null };
    }
    await Promise.allSettled(closePromises);
  }

  /** Executes the VDBE program */
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

        // Only debug log in development
        if (process.env.NODE_ENV === 'development') {
          console.debug(`VDBE Exec: [${currentPc}] FP=${this.framePointer} SP=${this.stackPointer} ${inst.opcode}`);
        }

        // Get the handler for this opcode
        const handler = handlers[inst.opcode];
        if (!handler) {
            this.error = new SqliteError(`No handler found for opcode ${inst.opcode}`, StatusCode.INTERNAL);
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

        // Check if handler returned a status code (e.g., ROW, DONE, ERROR)
        if (status !== undefined) {
          // If ROW or DONE was returned, the handler should have updated state.
          // If ERROR was returned, the handler should have set this.error.
          // In any case where a status is returned, we exit the loop.
          return status;
        }

        // Post-execution checks (handler might have set these flags)
        if (this.done) {
          return StatusCode.DONE;
        }
        if (this.hasYielded) {
          return StatusCode.ROW;
        }
        if (this.error) {
          return (this.error as SqliteError).code ?? StatusCode.MISUSE;
        }

        // Update program counter *only* if the handler didn't change it.
        // Handlers modify this.pc for jumps, yields, function calls/returns etc.
        if (this.pc === currentPc) {
          this.pc++;
        }
        // The loop condition `this.pc < code.length` will handle termination
      }
    } catch (e) {
      console.error("VDBE Execution Error:", e);
      if (e instanceof SqliteError) {
        this.error = e;
      } else if (e instanceof Error) {
        this.error = new SqliteError(`Runtime error: ${e.message}`, StatusCode.ERROR);
      } else {
        this.error = new SqliteError("Unknown runtime error", StatusCode.INTERNAL);
      }
      this.done = true; // Mark as done on any unhandled exception
    }

    // Determine final status after loop completion or error
    if (this.error) {
      return this.error.code as StatusCode;
    }
    // If loop finished naturally (pc >= code.length) without Done being set by Halt,
    // it implies successful completion without yielding a final row.
    if (this.pc >= this.program.instructions.length && !this.done) {
        this.done = true; // Ensure done is set if we reach the end
        return StatusCode.DONE;
    }
    if (this.done) return StatusCode.DONE; // If Halt instruction set done=true
    // Should not usually reach here if logic is correct
    return StatusCode.INTERNAL;
  }

  // --- Stack Access Helpers (VmCtx implementation) ---
  /** Sets an absolute stack index */
  setStackValue(index: number, value: SqlValue): void {
    if (index < 0) throw new SqliteError(`Invalid stack write index ${index}`, StatusCode.INTERNAL);

    // Ensure stack capacity
    while (index >= this.stack.length) {
      // Double the stack size for better amortized performance
      const newLength = Math.max(this.stack.length * 2, index + 1);
      const oldLength = this.stack.length;
      this.stack.length = newLength;
      // Initialize new cells explicitly
      for (let i = oldLength; i < newLength; i++) {
        this.stack[i] = { value: null };
      }
    }

    // Update stack pointer if writing beyond current top
    // Note: stackPointer points to the *next available* slot, so it should be index + 1
    this.stackPointer = Math.max(this.stackPointer, index + 1);

    // Deep copy blobs, other values are immutable or primitives
    this.stack[index].value = (value instanceof Uint8Array) ? value.slice() : value;
  }

  /** Gets an absolute stack index */
  getStackValue(index: number): SqlValue {
    // Check if index is valid and within the allocated part of the stack
    if (index < 0 || index >= this.stack.length) {
      // Accessing outside allocated memory is an error or implies uninitialized read
      // Depending on strictness, could throw or return null. Returning null is safer.
      // console.warn(`Attempt to read potentially uninitialized stack index ${index}`);
      return null;
    }
     // Allow reads up to stackPointer, even if slightly beyond last written index, treat as null.
     if (index >= this.stackPointer) {
       return null;
     }
    return this.stack[index]?.value ?? null; // Return null if cell is unexpectedly undefined
  }

  /** Gets value relative to Frame Pointer */
  getMem(offset: number): SqlValue {
    const stackIndex = this.framePointer + offset;
    return this.getStackValue(stackIndex);
  }

  /** Sets value relative to Frame Pointer */
  setMem(offset: number, value: SqlValue): void {
    // Locals should be at or above localsStartOffset
    if (offset < this.localsStartOffset) {
      throw new SqliteError(`Write attempt to control info/argument area: Offset=${offset}`, StatusCode.INTERNAL);
    }
    const stackIndex = this.framePointer + offset;
    this.setStackValue(stackIndex, value);
  }

  /** Push a value onto the stack */
  pushStack(value: SqlValue): void {
    this.setStackValue(this.stackPointer, value);
    // setStackValue already increments stackPointer correctly
  }

  /** Get a cursor by index */
  getCursor(idx: number): VdbeCursor | undefined {
    return this.vdbeCursors[idx];
  }

  /** Get a constant from the program constants pool */
  getConstant(idx: number): SqlValue {
    return this.program.constants[idx];
  }
}
