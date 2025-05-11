import type { SqlValue } from '../common/types.js';
import { Opcode } from '../vdbe/opcodes.js';
import { createInstruction, type VdbeInstruction } from '../vdbe/instruction.js';
import { SqliterError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
// import { createLogger } from '../../common/logger.js';

// const log = createLogger('emission:context');

export class EmissionContext {
  public instructions: VdbeInstruction[] = [];
  public subroutineCode: VdbeInstruction[] = []; // For VDBE-level subroutines
  public constants: SqlValue[] = [];

  public numMemCellsUsed: number = 0; // Max stack slot *index* used
  public numCursorsUsed: number = 0;  // Max cursor *index* used

  private pendingPlaceholders: Map<number, { instructionIndex: number; targetArray: VdbeInstruction[]; purpose: string }> = new Map();
  private nextPlaceholderId: number = -1; // Use unique negative IDs for placeholders
  private resolvedAddresses: Map<number, number> = new Map();

  // Register allocation state - starts at 2 to align with VDBE frame conventions
  private nextAvailableRegister: number = 2; // VDBE registers are 1-indexed for general use

  // Subroutine emission state
  private isEmittingToSubroutine: boolean = false;
  private currentSubroutineFrameEnterInsn: VdbeInstruction | null = null;
  private currentSubroutineFrameBase: number = 0; // Stack pointer at FrameEnter of current subroutine
  private maxLocalOffsetInCurrentSubroutineFrame: number = 0;
  // Stack for nested subroutines (though VDBE subroutines typically aren't deeply nested like plan execution)
  private subroutineFrameStateStack: Array<{
    frameEnterInsn: VdbeInstruction | null;
    frameBase: number;
    maxOffset: number;
  }> = [];

  constructor() {
    // Optionally, emit an Init instruction or similar setup if every context needs it.
    // For now, assuming the user of EmissionContext (e.g., Compiler) handles initial setup like Opcode.Init.
  }

  private getTargetInstructionArray(): VdbeInstruction[] {
    return this.isEmittingToSubroutine ? this.subroutineCode : this.instructions;
  }

  /** Emits an instruction and returns its address (index). */
  emit(opcode: Opcode, p1?: number, p2?: number, p3?: number, p4?: any, p5?: number, comment?: string): number {
    const instruction = createInstruction(opcode, p1, p2, p3, p4, p5, comment);
    const targetArray = this.getTargetInstructionArray();
    targetArray.push(instruction);
    const instructionAddress = targetArray.length - 1;

    if (this.isEmittingToSubroutine && !this.currentSubroutineFrameEnterInsn && opcode === Opcode.FrameEnter) {
      this.currentSubroutineFrameEnterInsn = instruction;
      this.currentSubroutineFrameBase = this.nextAvailableRegister; // Assuming FrameEnter is first, SP hasn't moved *within* sub yet
      this.maxLocalOffsetInCurrentSubroutineFrame = 0; // Reset for new subroutine frame
    }
    return instructionAddress;
  }

  /** Adds a constant to the pool and returns its index. */
  addConstant(value: SqlValue): number {
    const existingIndex = this.constants.indexOf(value);
    if (existingIndex !== -1) {
      return existingIndex;
    }
    this.constants.push(value);
    return this.constants.length - 1;
  }

  /** Allocates a block of contiguous memory cells (registers). */
  allocateMemoryCells(count: number): number {
    if (count <= 0) {
      throw new SqliterError('Must allocate at least one memory cell.', StatusCode.INTERNAL);
    }
    const baseRegister = this.nextAvailableRegister;
    this.nextAvailableRegister += count;
    this.numMemCellsUsed = Math.max(this.numMemCellsUsed, this.nextAvailableRegister - 1);

    if (this.isEmittingToSubroutine && this.currentSubroutineFrameEnterInsn) {
      // Calculate offset from the start of this subroutine's logical frame
      const currentOffsetInFrame = (this.nextAvailableRegister - 1) - this.currentSubroutineFrameBase + 1;
      this.maxLocalOffsetInCurrentSubroutineFrame = Math.max(this.maxLocalOffsetInCurrentSubroutineFrame, currentOffsetInFrame);
    }
    return baseRegister;
  }

  /** Frees previously allocated memory cells. Note: Simple contiguous model for now. */
  freeMemoryCells(baseRegister: number, count: number): void {
    // For a more complex allocator, this would mark registers as free.
    // For a simple stack-like allocator, this might adjust nextAvailableRegister
    // if baseRegister + count === nextAvailableRegister.
    // Current model: registers are not individually freed to simplify, only max is tracked.
    // If a stack discipline is strictly followed by the compiler, nextAvailableRegister could be rewound.
  }

  /** Allocates a new cursor index. */
  allocateCursor(): number {
    const cursorIndex = this.numCursorsUsed;
    this.numCursorsUsed++;
    return cursorIndex;
  }

  /** Reserves a placeholder for a future jump address. */
  allocateAddress(purpose: string = 'unknown'): number {
    const placeholderId = this.nextPlaceholderId--;
    // Record which array the placeholder will be in (for patching)
    // This is a bit indirect; the patching logic will handle it.
    return placeholderId;
  }

  /** Resolves a placeholder to the current address or a specified target address. */
  resolveAddress(placeholderId: number, targetAddress?: number): void {
    const address = targetAddress === undefined ? this.getTargetInstructionArray().length : targetAddress;
    this.resolvedAddresses.set(placeholderId, address);
  }

  /** Gets the address of the next instruction to be emitted. */
  getCurrentAddress(): number {
    return this.getTargetInstructionArray().length;
  }

  /** Begins emitting to a subroutine. */
  beginSubroutineEmission(): void {
    if (this.isEmittingToSubroutine) {
      // Push current subroutine state before starting a new nested one (if ever needed)
      this.subroutineFrameStateStack.push({
        frameEnterInsn: this.currentSubroutineFrameEnterInsn,
        frameBase: this.currentSubroutineFrameBase,
        maxOffset: this.maxLocalOffsetInCurrentSubroutineFrame
      });
    }
    this.isEmittingToSubroutine = true;
    this.currentSubroutineFrameEnterInsn = null; // Reset for the new subroutine
    this.currentSubroutineFrameBase = this.nextAvailableRegister; // Capture SP before any sub allocations
    this.maxLocalOffsetInCurrentSubroutineFrame = 0;
  }

  /** Ends emitting to a subroutine. */
  endSubroutineEmission(): void {
    if (!this.isEmittingToSubroutine) return; // Or throw error

    if (this.currentSubroutineFrameEnterInsn) {
        // The VDBE FrameEnter P1 is the number of cells in the frame INCLUDING args, locals, and return address slot.
        // SQLite's FrameEnter P1 = total cells in the new frame. If locals are R[0]..R[k-1] relative to FP,
        // and args are at FP[-1]..., P1 must account for all of them.
        // Our maxLocalOffsetInCurrentSubroutineFrame is the max *additional* register index used *beyond* FP.
        // If FP is where args end / locals begin, then maxLocalOffsetInCurrentSubroutineFrame effectively IS the size of locals.
        // Let's assume nextAvailableRegister at FrameEnter IS the FP for the new frame.
        // maxLocalOffsetInCurrentSubroutineFrame is relative to this FP.
        // For simplicity, assume FrameEnter P1 = number of registers used by the subroutine's own locals.
        // It needs to be count of cells from FP up to highest used by subroutine.
        this.currentSubroutineFrameEnterInsn.p1 = this.maxLocalOffsetInCurrentSubroutineFrame;
    }

    if (this.subroutineFrameStateStack.length > 0) {
      const prevState = this.subroutineFrameStateStack.pop()!;
      this.currentSubroutineFrameEnterInsn = prevState.frameEnterInsn;
      this.currentSubroutineFrameBase = prevState.frameBase;
      this.maxLocalOffsetInCurrentSubroutineFrame = prevState.maxOffset;
    } else {
      this.isEmittingToSubroutine = false;
      this.currentSubroutineFrameEnterInsn = null;
      // No need to reset frameBase/maxOffset here, they are for the *current* subroutine context
    }
  }

  /** Patches all jump addresses in the instruction list. */
  patchJumpAddresses(): void {
    const patchList = (instructions: VdbeInstruction[], listName: string) => {
      instructions.forEach((instr, index) => {
        if (instr.p1 !== undefined && this.resolvedAddresses.has(instr.p1)) {
          instr.p1 = this.resolvedAddresses.get(instr.p1)!;
        }
        if (instr.p2 !== undefined && this.resolvedAddresses.has(instr.p2)) {
          instr.p2 = this.resolvedAddresses.get(instr.p2)!;
        }
        if (instr.p3 !== undefined && this.resolvedAddresses.has(instr.p3)) {
          instr.p3 = this.resolvedAddresses.get(instr.p3)!;
        }
      });
    };
    patchList(this.instructions, 'main');
    patchList(this.subroutineCode, 'subroutine');
  }

  /** Finalizes the context and returns the generated program components. */
  finalize(): {
    instructions: VdbeInstruction[];
    constants: SqlValue[];
    numMemCells: number; // Total number of memory cells required for the VDBE
    numCursors: number;  // Total number of cursors required for the VDBE
  } {
    if (this.isEmittingToSubroutine) {
      // Ensure any active subroutine is properly ended if finalize is called.
      // This might indicate an issue if not explicitly ended by the compiler.
      // log.warn('Finalizing EmissionContext while still in subroutine emission mode.');
      this.endSubroutineEmission(); // Attempt to clean up
    }
    this.patchJumpAddresses();
    const finalInstructions = [...this.instructions, ...this.subroutineCode];
    return {
      instructions: finalInstructions,
      constants: this.constants,
      numMemCells: this.numMemCellsUsed + 1, // VDBE needs one more than max index used if 0-indexed, or just numMemCellsUsed if 1-indexed counts cells.
                                          // Assuming numMemCellsUsed is max *index*, so +1 for size.
      numCursors: this.numCursorsUsed,
    };
  }
}
