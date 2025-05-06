import { Opcode } from '../vdbe/opcodes.js';
import type { SqlValue } from '../common/types.js';
import { createInstruction, type VdbeInstruction } from '../vdbe/instruction.js';
import type { Compiler } from './compiler.js';
import { createLogger } from '../common/logger.js';
import { StatusCode } from '../common/types.js';
import { SqliteError } from '../common/errors.js';
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
	if (count <= 0) return -1;

	let baseReg: number;
	if (compiler.subroutineDepth > 0) {
		baseReg = compiler.framePointer + compiler.maxLocalOffsetInCurrentFrame + 1; // Relative to current frame
	} else {
		// Ensure base register for main program is >= 2 (0=PC?, 1=OldFP?)
		// Let's reserve 0 and 1 explicitly.
		const firstAvailableReg = 2;
		baseReg = Math.max(firstAvailableReg, compiler.stackPointer + 1);
	}

	const newMaxOffset = compiler.subroutineDepth > 0
		? compiler.maxLocalOffsetInCurrentFrame + count
		: baseReg + count - 1; // Absolute index

	if (compiler.subroutineDepth > 0) {
		compiler.maxLocalOffsetInCurrentFrame = newMaxOffset;
	} else {
		compiler.stackPointer = newMaxOffset;
	}

	// Update overall max memory cells needed for the program
	compiler.numMemCells = Math.max(compiler.numMemCells, newMaxOffset);

	return baseReg;
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
export function allocateAddressHelper(compiler: Compiler, purpose: string): number {
	const placeholderId = compiler.nextPlaceholderId--; // Get a unique negative ID
	const targetArray = compiler.subroutineDepth > 0 ? compiler.subroutineCode : compiler.instructions;
	const instructionIndex = targetArray.length; // Index where the resolved instruction WILL be
	compiler.pendingPlaceholders.set(placeholderId, { instructionIndex, targetArray, purpose });
	debugLog(`Allocated placeholder ${placeholderId} for ${purpose} (target index ${instructionIndex})`);
	return placeholderId; // Return the negative placeholder ID
}

/**
 * Resolves a previously allocated address placeholder
 *
 * @param compiler The compiler instance
 * @param placeholder The negative placeholder value to resolve
 * @returns The resolved target address, or -1 if placeholder was invalid
 */
export function resolveAddressHelper(compiler: Compiler, placeholder: number): number {
	const placeholderInfo = compiler.pendingPlaceholders.get(placeholder);
	if (!placeholderInfo) {
		errorLog(`Attempted to resolve unknown or already resolved placeholder: ${placeholder}`);
		throw new SqliteError(`Internal error: Invalid address placeholder ${placeholder}`, StatusCode.INTERNAL);
	}

	const currentAddress = placeholderInfo.targetArray.length; // Current address in the correct array

	compiler.resolvedAddresses.set(placeholder, currentAddress);

	// Optionally, track resolved addresses for debugging/verification if needed
	compiler.pendingPlaceholders.delete(placeholder); // Mark as resolved (pending deleted, actual address stored)

	// console.log(`Resolved placeholder ${placeholder} (${placeholderInfo.purpose}) to address ${currentAddress}`);
	return currentAddress; // Return the resolved address
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
	// Patch main instructions
	for (const instruction of compiler.instructions) {
		patchInstructionOperands(compiler, instruction);
	}
	// Patch subroutine instructions (if any)
	for (const instruction of compiler.subroutineCode) {
		patchInstructionOperands(compiler, instruction);
	}

	// Verify all placeholders were resolved
	if (compiler.pendingPlaceholders.size > 0) {
		const unresolved = Array.from(compiler.pendingPlaceholders.entries())
			.map(([id, info]) => `${id} (${info.purpose})`).join(', ');
		errorLog(`Internal error: Unresolved address placeholders remain after compilation: ${unresolved}`);
		throw new SqliteError(`Internal error: Unresolved address placeholders: ${unresolved}`, StatusCode.INTERNAL);
	}
}

function patchInstructionOperands(compiler: Compiler, instruction: VdbeInstruction): void {
	// Check operands that typically hold jump addresses (P2 for most jumps/branches)
	// Add checks for P1, P3 if other opcodes use them for addresses
	if (typeof instruction.p2 === 'number' && instruction.p2 < 0) {
		const resolvedAddress = compiler.resolvedAddresses.get(instruction.p2);
		if (resolvedAddress === undefined) {
			// This case should ideally not happen if patchJumpAddresses is called correctly
			// and all placeholders were resolved.
			// Use Opcode enum to get the name for the error message
			errorLog(`Internal error: Found unresolved placeholder ${instruction.p2} in instruction [${compiler.instructions.indexOf(instruction)}] ${Opcode[instruction.opcode]} during final patching.`);
			// Decide whether to throw or log based on strictness
			throw new SqliteError(`Internal error: Unresolved placeholder ${instruction.p2} during patching`, StatusCode.INTERNAL);
		}
		// console.log(`Patching P2 of [${compiler.instructions.indexOf(instruction)}] ${Opcode[instruction.opcode]}: ${instruction.p2} -> ${resolvedAddress}`);
		instruction.p2 = resolvedAddress;
	}
	// Add similar checks for instruction.p1, instruction.p3 if necessary
}


/**
 * Starts a subroutine compilation context by setting up a new frame
 *
 * @returns The address of the FrameEnter instruction
 */
export function beginSubroutineHelper(compiler: Compiler, numArgs: number, argMap?: ArgumentMap): number {
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