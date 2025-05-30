import { Opcode } from '../vdbe/opcodes.js';
import type { SqlValue } from '../common/types.js';
import { createInstruction, type VdbeInstruction } from '../vdbe/instruction.js';
import type { Compiler } from './compiler.js';
import { createLogger } from '../common/logger.js';
import { StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import type { ArgumentMap } from './handlers.js';

const log = createLogger('compiler:state');
const debugLog = log.extend('debug');
const errorLog = createLogger('compiler').extend('error');
const warnLog = createLogger('compiler').extend('warn');
debugLog.enabled = false;

/**
 * Allocates memory cells within the current frame
 *
 * @param compiler The compiler instance
 * @param count Number of memory cells to allocate
 * @returns Starting offset relative to the frame pointer
 */
export function allocateMemoryCellsHelper(compiler: Compiler, count: number): number {
	const base = compiler.stackPointer;
	compiler.stackPointer += count;
	compiler.numMemCells = Math.max(compiler.numMemCells, compiler.stackPointer);
	// Track max offset if inside a subroutine frame for FrameEnter P1
	if (compiler.subroutineDepth > 0 && compiler.currentFrameEnterInsn) {
		const currentOffset = compiler.stackPointer - compiler.framePointer; // Calculate offset from current frame base
		compiler.maxLocalOffsetInCurrentFrame = Math.max(compiler.maxLocalOffsetInCurrentFrame, currentOffset -1 ); // -1 because numMemCells is max index
	}
	return base;
}

/**
 * Allocates a new cursor index
 *
 * @param compiler The compiler instance
 * @returns The allocated cursor index
 */
export function allocateCursorHelper(compiler: Compiler): number {
	const cursorIndex = compiler.numCursors++;
	return cursorIndex;
}

/**
 * Adds a constant to the constants pool
 *
 * @param compiler The compiler instance
 * @param value The constant value to add
 * @returns The index of the constant in the pool
 */
export function addConstantHelper(compiler: Compiler, value: SqlValue): number {
	const index = compiler.constants.findIndex(c => c === value); // Simple check for now
	if (index !== -1) {
		return index;
	}
	compiler.constants.push(value);
	return compiler.constants.length - 1;
}

/**
 * Emits a VDBE instruction to the current target array
 *
 * @param compiler The compiler instance
 * @param opcode The operation code
 * @param p1 Parameter 1
 * @param p2 Parameter 2
 * @param p3 Parameter 3
 * @param p4 Parameter 4 (typically complex types)
 * @param p5 Parameter 5 (typically flags)
 * @param comment Optional comment for debugging
 * @returns The address of the emitted instruction
 */
export function emitInstruction(compiler: Compiler, opcode: Opcode, p1?: number, p2?: number, p3?: number, p4?: any, p5?: number, comment?: string): number {
	const instruction = createInstruction(opcode, p1, p2, p3, p4, p5, comment);
	const targetArray = compiler.subroutineDepth > 0 ? compiler.subroutineCode : compiler.instructions;
	targetArray.push(instruction);

	// Track max memory cell used (based on register operands p1, p2, p3 if they represent registers)
	// This requires knowledge of which opcodes use which parameters as registers.
	// Example: For Move R1, R2, N -> check max(R1, R2 + N -1)
	// For simplicity, memory tracking is primarily done in allocateMemoryCellsHelper for now.
	// A more robust solution would inspect operands here based on opcode definitions.

	return targetArray.length - 1; // Return address (index) of the emitted instruction
}

/**
 * Allocates an address placeholder for forward jumps
 *
 * @param compiler The compiler instance
 * @param purpose A debug label for the placeholder's purpose
 * @returns A negative placeholder value to be resolved later
 */
export function allocateAddressHelper(compiler: Compiler, purpose: string = 'unknown'): number {
	const placeholderId = compiler.nextPlaceholderId--;
	// Store where this placeholder is used for easier debugging if it's not resolved
	// Note: An address placeholder might be used in multiple instructions (e.g. start of a loop)
	// This records the first instruction that *uses* it. The patching will update all uses.
	// However, the current setup is that emitInstruction takes the placeholder,
	// and it's the *responsibility of the caller* to eventually call resolveAddress.
	// For now, this specific logging in pendingPlaceholders might be less critical
	// as the placeholder is returned to the caller.
	// compiler.pendingPlaceholders.set(placeholderId, { /* ... details ... */ });
	log(`Allocated address placeholder ${placeholderId} for: ${purpose}`);
	return placeholderId;
}

/**
 * Resolves a previously allocated address placeholder
 *
 * @param compiler The compiler instance
 * @param placeholder The negative placeholder value to resolve
 * @returns The resolved target address, or -1 if placeholder was invalid
 */
export function resolveAddressHelper(compiler: Compiler, placeholder: number): number {
	const targetAddress = getCurrentAddressHelper(compiler);
	if (compiler.resolvedAddresses.has(placeholder)) {
		warnLog(`Address placeholder ${placeholder} is already resolved to ${compiler.resolvedAddresses.get(placeholder)}, re-resolving to ${targetAddress} (Purpose: ${compiler.pendingPlaceholders.get(placeholder)?.purpose || 'N/A'})`);
	}
	compiler.resolvedAddresses.set(placeholder, targetAddress);
	// compiler.pendingPlaceholders.delete(placeholder); // Remove from pending
	log(`Resolved address placeholder ${placeholder} to PC=${targetAddress} (Current pending: ${compiler.pendingPlaceholders.get(placeholder)?.purpose || 'N/A'})`);
	return targetAddress;
}

/**
 * Gets the current address in the instruction stream
 *
 * @param compiler The compiler instance
 * @returns The current instruction address
 */
export function getCurrentAddressHelper(compiler: Compiler): number {
	const targetArray = compiler.subroutineDepth > 0 ? compiler.subroutineCode : compiler.instructions;
	return targetArray.length;
}

/**
 * Patches jump addresses at the end of compilation
 *
 * @param compiler The compiler instance
 */
export function patchJumpAddresses(compiler: Compiler): void {
	log('Starting jump address patching. Resolved addresses:', JSON.stringify(Array.from(compiler.resolvedAddresses.entries())));

	const patchList = (instructions: VdbeInstruction[], context: string) => {
		instructions.forEach((instr, index) => {
			let patched = false;
			const originalP1 = instr.p1;
			const originalP2 = instr.p2;
			const originalP3 = instr.p3;

			if (instr.p1 !== undefined && compiler.resolvedAddresses.has(instr.p1)) {
				instr.p1 = compiler.resolvedAddresses.get(instr.p1)!;
				log(`Patched ${context} Insn[${index}] ${Opcode[instr.opcode]}.P1 from ${originalP1} to ${instr.p1}`);
				patched = true;
			}
			if (instr.p2 !== undefined && compiler.resolvedAddresses.has(instr.p2)) {
				instr.p2 = compiler.resolvedAddresses.get(instr.p2)!;
				log(`Patched ${context} Insn[${index}] ${Opcode[instr.opcode]}.P2 from ${originalP2} to ${instr.p2}`);
				patched = true;
			}
			if (instr.p3 !== undefined && compiler.resolvedAddresses.has(instr.p3)) {
				instr.p3 = compiler.resolvedAddresses.get(instr.p3)!;
				log(`Patched ${context} Insn[${index}] ${Opcode[instr.opcode]}.P3 from ${originalP3} to ${instr.p3}`);
				patched = true;
			}

			// Special logging for VFilter if it was a candidate for patching P2
			if (instr.opcode === Opcode.VFilter && originalP2 !== undefined && compiler.resolvedAddresses.has(originalP2)) {
				if (patched && instr.p2 !== originalP2) {
					log(`VFilter P2 patched: Original=${originalP2}, New=${instr.p2}`);
				} else {
					log(`VFilter P2 was candidate for patching (${originalP2}), but new value is same or not patched: ${instr.p2}`);
				}
			} else if (instr.opcode === Opcode.VFilter && originalP2 !== undefined && !compiler.resolvedAddresses.has(originalP2)) {
				log(`VFilter P2 (${originalP2}) was NOT a candidate for patching (not in resolvedAddresses) at Insn[${index}]`);
			}
		});
	};

	patchList(compiler.instructions, 'Main');
	patchList(compiler.subroutineCode, 'Subroutine');

	// Verify no pending placeholders remain unresolved if strict checking is desired
	// compiler.pendingPlaceholders.forEach((details, id) => {

	// Verify all placeholders were resolved
	if (compiler.pendingPlaceholders.size > 0) {
		const unresolved = Array.from(compiler.pendingPlaceholders.entries())
			.map(([id, info]) => `${id} (${info.purpose})`).join(', ');
		errorLog(`Internal error: Unresolved address placeholders remain after compilation: ${unresolved}`);
		throw new QuereusError(`Internal error: Unresolved address placeholders: ${unresolved}`, StatusCode.INTERNAL);
	}
}

/**
 * Starts a subroutine compilation context by setting up a new frame
 *
 * @returns The address of the FrameEnter instruction
 */
export function beginSubroutineHelper(compiler: Compiler, _numArgs: number, _argMap?: ArgumentMap): number {
	compiler.subroutineDepth++;
	compiler.subroutineFrameStack.push({
		frameEnterInsn: compiler.currentFrameEnterInsn,
		maxOffset: compiler.maxLocalOffsetInCurrentFrame,
	});

	compiler.maxLocalOffsetInCurrentFrame = 0;
	const instruction = createInstruction(Opcode.FrameEnter, 0, 0, 0, null, 0, `Enter Subroutine Frame Depth ${compiler.subroutineDepth}`);
	compiler.subroutineCode.push(instruction);
	const frameEnterAddr = compiler.subroutineCode.length - 1;
	compiler.currentFrameEnterInsn = instruction;

	return frameEnterAddr;
}

/**
 * Ends a subroutine compilation context by patching the frame size
 * and restoring the previous frame context
 */
export function endSubroutineHelper(compiler: Compiler): void {
	if (compiler.subroutineDepth > 0) {
		if (compiler.currentFrameEnterInsn) {
			const frameSize = compiler.maxLocalOffsetInCurrentFrame + 1;
			compiler.currentFrameEnterInsn.p1 = frameSize;
		} else {
			errorLog("Missing FrameEnter tracking for the current frame being ended.");
		}

		compiler.subroutineDepth--;

		const previousFrame = compiler.subroutineFrameStack.pop();
		if (previousFrame) {
			compiler.currentFrameEnterInsn = previousFrame.frameEnterInsn;
			compiler.maxLocalOffsetInCurrentFrame = previousFrame.maxOffset;
		} else {
			compiler.currentFrameEnterInsn = null;
			compiler.maxLocalOffsetInCurrentFrame = 0;
			if (compiler.subroutineDepth !== 0) {
				errorLog("Subroutine stack underflow or depth mismatch.");
			}
		}
	} else {
		warnLog("Attempted to end subroutine compilation at depth 0");
	}
}
