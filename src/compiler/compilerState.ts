import { Opcode } from '../vdbe/opcodes.js';
import type { SqlValue } from '../common/types.js';
import { createInstruction } from '../vdbe/instruction.js';
import type { Compiler } from './compiler.js';

/**
 * Allocates memory cells within the current frame
 *
 * @param compiler The compiler instance
 * @param count Number of memory cells to allocate
 * @returns Starting offset relative to the frame pointer
 */
export function allocateMemoryCellsHelper(compiler: Compiler, count: number): number {
	// Frame slots 0 and 1 are reserved for RetAddr and OldFP
	// Locals start at offset 2
	const localsStartOffset = 2;
	// Calculate base offset relative to current frame's local usage
	const baseOffset = (compiler as any).currentFrameLocals < localsStartOffset
		? localsStartOffset
		: (compiler as any).currentFrameLocals + 1;

	// Update max offset used in this frame
	const newMaxOffset = baseOffset + count - 1;
	(compiler as any).currentFrameLocals = Math.max((compiler as any).currentFrameLocals, newMaxOffset);
	// Track overall max offset used *within this specific frame* for FrameEnter P1
	(compiler as any).maxLocalOffsetInCurrentFrame = Math.max((compiler as any).maxLocalOffsetInCurrentFrame, newMaxOffset);

	// Update overall stack size estimate (absolute index across all frames - useful for debugging/estimation)
	const absoluteIndex = (compiler as any).framePointer + newMaxOffset;
	compiler.numMemCells = Math.max(compiler.numMemCells, absoluteIndex);

	// Return starting offset relative to FP
	return baseOffset;
}

/**
 * Allocates a new cursor index
 *
 * @param compiler The compiler instance
 * @returns The allocated cursor index
 */
export function allocateCursorHelper(compiler: Compiler): number {
	// Cursors are still global within a compilation context
	const cursorIdx = compiler.numCursors;
	compiler.numCursors++;
	return cursorIdx;
}

/**
 * Adds a constant to the constants pool
 *
 * @param compiler The compiler instance
 * @param value The constant value to add
 * @returns The index of the constant in the pool
 */
export function addConstantHelper(compiler: Compiler, value: SqlValue): number {
	// Constants are global
	const idx = compiler.constants.length;
	compiler.constants.push(value);
	return idx;
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
export function emitInstruction(
	compiler: Compiler,
	opcode: Opcode,
	p1: number = 0,
	p2: number = 0,
	p3: number = 0,
	p4: any = null,
	p5: number = 0,
	comment?: string
): number {
	// Emit to main instructions or subroutine code based on depth
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	const instruction = createInstruction(opcode, p1, p2, p3, p4, p5, comment);
	targetArray.push(instruction);
	// Return address relative to the start of the *specific code block* (main or subroutine)
	return targetArray.length - 1;
}

/**
 * Allocates an address placeholder for forward jumps
 *
 * @param compiler The compiler instance
 * @param purpose A debug label for the placeholder's purpose
 * @returns A negative placeholder value to be resolved later
 */
export function allocateAddressHelper(compiler: Compiler, purpose: string = 'unknown'): number {
	// Determine the current instruction array (main or subroutine)
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	const instructionIndex = targetArray.length; // The index where the *next* instruction will be placed

	// Generate a unique negative placeholder ID
	const placeholder = (compiler as any).nextPlaceholderId--;

	// Store the mapping from the unique ID to its intended instruction index, array, and purpose
	compiler.pendingPlaceholders.set(placeholder, { instructionIndex, targetArray, purpose });

	console.log(`DEBUG: Allocating placeholder ID ${placeholder} (purpose: ${purpose}) for future instruction at index ${instructionIndex} (subroutineDepth=${compiler.subroutineDepth})`);
	return placeholder;
}

/**
 * Resolves a previously allocated address placeholder
 *
 * @param compiler The compiler instance
 * @param placeholder The negative placeholder value to resolve
 * @returns The resolved target address, or -1 if placeholder was invalid
 */
export function resolveAddressHelper(compiler: Compiler, placeholderId: number): number {
	if (placeholderId >= 0) {
		//console.warn(`DEBUG: Attempting to resolve a non-placeholder ID: ${placeholderId}`);
		return -1; // Indicate invalid placeholder
	}

	// Retrieve the intended instruction index and target array from the map
	const placeholderInfo = compiler.pendingPlaceholders.get(placeholderId);

	if (!placeholderInfo) {
		//console.warn(`DEBUG: Attempting to resolve unknown or already resolved placeholder ID: ${placeholderId}`);
		return -1; // Indicate invalid placeholder
	}

	const { instructionIndex: predictedIndex, targetArray, purpose } = placeholderInfo;
	const targetAddress = targetArray.length; // Resolve to the *current* end of the instruction array

	// Remove the placeholder from the map now that we are resolving it
	compiler.pendingPlaceholders.delete(placeholderId);

	//console.log(`DEBUG: Resolving placeholder ID ${placeholderId} (purpose: ${purpose}, predicted instr index ${predictedIndex}) to target address ${targetAddress} (current length ${targetArray.length}, subroutineDepth=${compiler.subroutineDepth})`);

	// Opcodes whose P2 parameter holds a jump target address
	const jumpOpcodes = new Set<Opcode>([
		Opcode.Goto, Opcode.IfTrue, Opcode.IfFalse, Opcode.IfZero,
		Opcode.IfNull, Opcode.IfNotNull, Opcode.Eq, Opcode.Ne,
		Opcode.Lt, Opcode.Le, Opcode.Gt, Opcode.Ge, Opcode.Once,
		Opcode.VFilter, Opcode.VNext, Opcode.Rewind, Opcode.Subroutine
	]);

	let patchedCount = 0;
	// Iterate through the relevant instruction array to find actual usage(s)
	// We only need to search up to the current length, as jumps should point forward
	for (let i = 0; i < targetAddress; i++) {
		const instr = targetArray[i];
		// Check if this opcode uses P2 for jumps and if P2 matches the placeholder ID
		if (jumpOpcodes.has(instr.opcode) && instr.p2 === placeholderId) {
			//console.log(`DEBUG: Patching instruction at index ${i} (${Opcode[instr.opcode]}): Setting P2 from ${instr.p2} to ${targetAddress}`);
			instr.p2 = targetAddress;
			patchedCount++;
		}
		// TODO: Add checks for other parameters (p1, p3) if any opcodes use them for jumps
	}

	if (patchedCount === 0) {
		// This is unexpected if the placeholder was allocated and resolved.
		// It might mean the instruction using the placeholder was never emitted, or used a different parameter.
		//console.warn(`DEBUG: Placeholder ID ${placeholderId} (purpose: ${purpose}) resolved, but no instructions were found using it in P2.`);
		// Log the instruction at the predicted index for extra info, if it exists
		if (predictedIndex >= 0 && predictedIndex < targetAddress) {
			const predictedInstr = targetArray[predictedIndex];
			//console.log(`DEBUG: Instruction at predicted index ${predictedIndex}: ${Opcode[predictedInstr.opcode]} P1=${predictedInstr.p1} P2=${predictedInstr.p2} P3=${predictedInstr.p3}`);
		}
	}

	// Return the resolved address
	return targetAddress;
}

/**
 * Gets the current address in the instruction stream
 *
 * @param compiler The compiler instance
 * @returns The current instruction address
 */
export function getCurrentAddressHelper(compiler: Compiler): number {
	// Address relative to the current code block (main or subroutine)
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	return targetArray.length;
}
