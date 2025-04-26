import { Opcode } from '../vdbe/opcodes.js';
import type { SqlValue } from '../common/types.js';
import { createInstruction } from '../vdbe/instruction.js';
import type { Compiler } from './compiler.js';

// --- Compiler State & VDBE Emission Helpers --- //

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

export function allocateCursorHelper(compiler: Compiler): number {
	// Cursors are still global within a compilation context
	const cursorIdx = compiler.numCursors;
	compiler.numCursors++;
	return cursorIdx;
}

export function addConstantHelper(compiler: Compiler, value: SqlValue): number {
	// Constants are global
	const idx = compiler.constants.length;
	compiler.constants.push(value);
	return idx;
}

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

export function allocateAddressHelper(compiler: Compiler): number {
	// Placeholder address needs to be relative to the current code block
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	// Negative index relative to current block end + 1
	return -(targetArray.length + 1);
}

export function resolveAddressHelper(compiler: Compiler, placeholder: number): void {
	if (placeholder >= 0) {
		console.warn(`Attempting to resolve a non-placeholder address: ${placeholder}`);
		return;
	}
	// Resolve based on the current code block (main or subroutine)
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	const targetAddress = targetArray.length; // Address is the index of the *next* instruction
	const instructionIndex = -(placeholder + 1); // Get original index from placeholder

	if (instructionIndex < 0 || instructionIndex >= targetArray.length) {
		console.warn(`Placeholder address ${placeholder} corresponds to invalid index ${instructionIndex} in current code block.`);
		return;
	}

	const instr = targetArray[instructionIndex];

	// Check which parameter (typically P2) holds the jump target address
	const addressParams: { [op in Opcode]?: 'p1' | 'p2' | 'p3' } = {
		[Opcode.Goto]: 'p2',
		[Opcode.IfTrue]: 'p2',
		[Opcode.IfFalse]: 'p2',
		[Opcode.IfZero]: 'p2',
		[Opcode.IfNull]: 'p2',
		[Opcode.IfNotNull]: 'p2',
		[Opcode.Eq]: 'p2',
		[Opcode.Ne]: 'p2',
		[Opcode.Lt]: 'p2',
		[Opcode.Le]: 'p2',
		[Opcode.Gt]: 'p2',
		[Opcode.Ge]: 'p2',
		[Opcode.Once]: 'p2',
		[Opcode.VFilter]: 'p2',
		[Opcode.VNext]: 'p2',
		[Opcode.Rewind]: 'p2',
		[Opcode.Subroutine]: 'p2',
		// Add others like Init, Function?, etc. if they use placeholders
	};

	// Fix: Check if opcode is a valid key before indexing
	const opCodeKey = instr.opcode;
	if (opCodeKey in addressParams) {
		const paramKey = addressParams[opCodeKey as keyof typeof addressParams]; // Now type-safe access
		if (paramKey && (instr as any)[paramKey] === placeholder) {
			(instr as any)[paramKey] = targetAddress;
		} else {
			console.warn(`Instruction at index ${instructionIndex} (${Opcode[instr.opcode]}) does not match placeholder ${placeholder} for its expected address parameter (${paramKey || 'none'}).`);
		}
	} else {
		console.warn(`Opcode ${Opcode[instr.opcode]} not configured for address resolution.`);
	}
}

export function getCurrentAddressHelper(compiler: Compiler): number {
	// Address relative to the current code block (main or subroutine)
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	return targetArray.length;
}
