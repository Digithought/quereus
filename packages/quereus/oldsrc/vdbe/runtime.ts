import { StatusCode, type SqlValue } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import type { Database } from '../core/database.js';
import type { Statement } from '../core/statement.js';
import type { VdbeProgram } from './program.js';
import { FunctionContext } from '../func/context.js';
import type { VmCtx, VdbeCursor, MemoryCell } from './handler-types.js';
import { handlers } from './handlers.js';
import { Opcode } from './opcodes.js';
import { createLogger } from '../common/logger.js';
import { safeJsonStringify } from '../util/serialization.js';

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
  error?: QuereusError;

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
        this.setStack(stackIndex, value);
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
        // --- REVERTED Early Exit --- //
        return this.error?.code ?? StatusCode.MISUSE;
        // --- END REVERT --- //
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
        const currentPc = this.pc;
        const inst = code[currentPc];

        if (!inst) {
          this.error = new QuereusError(`Invalid program counter: ${currentPc}`, StatusCode.INTERNAL);
          break;
        }

        // Modify the replacer to handle nested BigInts for logging
        const p4Str = inst.p4 ? safeJsonStringify(inst.p4).substring(0, 150) : '';
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
            this.error = new QuereusError(`No handler found for opcode ${inst.opcode} (${Opcode[inst.opcode]})`, StatusCode.INTERNAL);
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

        // *** CHECK HANDLER STATUS *** (e.g., Halt returns 0, ResultRow returns undefined)
        if (status !== undefined) {
          if (this.done && status === StatusCode.OK) {
              // console.log(`>>> run [PC=${currentPc}, Op=${Opcode[inst.opcode]}] RETURNING: OK from Halt handler`);
              return StatusCode.OK; // Handle Halt OK
          }
          // console.log(`>>> run [PC=${currentPc}, Op=${Opcode[inst.opcode]}] RETURNING: Status from handler: ${status} (${StatusCode[status] ?? 'Unknown'})`);
          return status; // Returns status from handler (ERROR, etc.)
        }

        // *** CHECK YIELD *** (ResultRow sets this.hasYielded = true)
        if (this.hasYielded) {
          this.hasYielded = false;
          if (this.pc === currentPc) { this.pc++; } // Advance PC *after* yield
          // console.log(`>>> run [PC=${currentPc}, Op=${Opcode[inst.opcode]}] RETURNING: ROW from yield`);
          return StatusCode.ROW; // Return ROW
        }

        // *** POST-HANDLER CHECKS *** (Should only be reached if handler returned undefined)
        if (this.done) { // If Halt was executed (done=true) but didn't return status? Should not happen.
          errorLog('Runtime loop ended with done=true but Halt status was not returned?');
          // console.log(`>>> run [PC=${currentPc}, Op=${Opcode[inst.opcode]}] RETURNING: DONE from post-handler check (done=true)`);
          return StatusCode.DONE;
        }
        if (this.error) { // If handler set an error without returning code?
           const errCode = (this.error as QuereusError).code ?? StatusCode.MISUSE;
           // console.log(`>>> run [PC=${currentPc}, Op=${Opcode[inst.opcode]}] RETURNING: Error from post-handler check: ${errCode} (${StatusCode[errCode] ?? 'Unknown'})`);
          return errCode;
        }

        // *** ADVANCE PC *** (If handler didn't jump)
        if (this.pc === currentPc) {
          this.pc++;
        }
      }
    } catch (e) {
      errorLog('VDBE Execution Error: %O', e);
      if (e instanceof QuereusError) {
        this.error = e;
      } else if (e instanceof Error) {
        this.error = new QuereusError(`Runtime error: ${e.message}`, StatusCode.ERROR);
      } else {
        this.error = new QuereusError("Unknown runtime error", StatusCode.INTERNAL);
      }
      this.done = true;
    }

    // *** DETERMINE FINAL STATUS *** (If loop finished or error occurred)
    if (this.error) {
        const errCode = this.error.code as StatusCode;
        // --- ADDED LOGGING ---
        log(`>>> run [PC=${this.pc}] RETURNING: Final status from error: ${errCode} (${StatusCode[errCode] ?? 'Unknown'})`);
        // --- END LOGGING ---
        return errCode;
    }
    if (this.pc >= this.program.instructions.length && !this.done) { this.done = true; }
    const finalReturn = this.done ? StatusCode.DONE : StatusCode.INTERNAL;
    // --- ADDED LOGGING ---
    log(`>>> run [PC=${this.pc}, Done=${this.done}] RETURNING: Final status from loop end/done: ${finalReturn} (${StatusCode[finalReturn] ?? 'Unknown'})`);
    // --- END LOGGING ---
    return finalReturn;
  }

  // --- VmCtx Implementation ---

  /**
   * Sets a value at an absolute stack index.
   */
  setStack(index: number, value: SqlValue): void {
    if (index < 0) throw new QuereusError(`Invalid stack write index ${index}`, StatusCode.INTERNAL);

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
  getStack(index: number): SqlValue {
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
    return this.getStack(stackIndex);
  }

  /**
   * Sets a value relative to the frame pointer.
   */
  setMem(offset: number, value: SqlValue): void {
    // Locals should be at or above localsStartOffset
    if (offset < this.localsStartOffset) {
      throw new QuereusError(`Write attempt to control info/argument area: Offset=${offset}`, StatusCode.INTERNAL);
    }
    const stackIndex = this.framePointer + offset;
    this.setStack(stackIndex, value);
  }

  /**
   * Pushes a value onto the stack.
   */
  pushStack(value: SqlValue): void {
    this.setStack(this.stackPointer, value);
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
