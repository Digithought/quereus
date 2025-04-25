import { StatusCode, type SqlValue, SqlDataType } from '../common/types';
import { SqliteError, ConstraintError } from '../common/errors';
import type { Database } from '../core/database';
import type { Statement } from '../core/statement';
import type { VdbeProgram } from './program';
import type { VdbeInstruction, P4FuncDef, P4Coll, P4SchemaChange, P4SortKey } from './instruction';
import { Opcode, ConflictResolution } from '../common/constants';
import { evaluateIsTrue, compareSqlValues } from '../util/comparison';
import { applyNumericAffinity, applyTextAffinity, applyIntegerAffinity, applyRealAffinity, applyBlobAffinity } from '../util/affinity';
import type { VirtualTableCursor } from '../vtab/cursor';
import type { VirtualTable } from '../vtab/table';
import { FunctionContext } from '../func/context';
import type { TableSchema } from '../schema/table';
import { MemoryTable } from '../vtab/memory-table';
import { MemoryTableModule } from '../vtab/memory-module';
import { type MemoryTableRow } from '../vtab/memory-table';
import { MemoryTableCursor } from '../vtab/memory-cursor';
import type { FunctionSchema } from '../schema/function';
import type * as AST from '../parser/ast'; // Import AST namespace
import type { VirtualTableModule } from '../vtab/module'; // <-- Import VirtualTableModule

/** Represents a single VDBE memory cell (register) */
export interface MemoryCell {
	value: SqlValue;
}

/** Internal state for a VDBE cursor */
interface VdbeCursor {
	instance: VirtualTableCursor<any> | null;
	vtab: VirtualTable | null; // Keep vtab ref for module access (xUpdate, xBegin etc.)
	// isValid is now implicitly handled by cursor.eof()
	// isEof is now implicitly handled by cursor.eof()
	isEphemeral?: boolean;
	sortedResults?: { rows: MemoryCell[][], index: number } | null;
}

/**
 * Represents an execution instance of a VDBE program.
 * Uses a stack-based memory model with activation frames.
 */
export class Vdbe {
	private readonly db: Database;
	private readonly program: VdbeProgram;
	private readonly stmt: Statement;

	private programCounter: number = 0;
	// --- Stack-based Memory ---
	private stack: MemoryCell[] = []; // Main execution stack
	private framePointer: number = 0; // Points to base of current frame on the stack
	private stackPointer: number = 0; // Points to top of stack (next free slot)
	// --- Updated Frame Layout ---
	// FP+0: Return Address (set by Subroutine)
	// FP+1: Old Frame Pointer (set by FrameEnter)
	// FP+2..N: Locals (set by compiler, init by FrameEnter)
	// FP-1, FP-2,... : Arguments pushed by caller (accessed via negative offset)
	private readonly localsStartOffset = 2; // Locals start after control info
	// --------------------------
	private vdbeCursors: VdbeCursor[]; // Renamed from cursors
	private hasYielded = false;
	private done = false;
	private error: SqliteError | null = null;
	private appliedBindings: boolean = false;
	private vtabContext: FunctionContext;
	private udfContext: FunctionContext;
	private ephemeralTables: Map<number, { table: MemoryTable, module: MemoryTableModule }> = new Map();
	private static ephemeralModule = new MemoryTableModule();
	private aggregateContexts: Map<string | number, any> = new Map();
	private aggregateIterator: Iterator<[string | number, any]> | null = null;
	private currentAggregateEntry: [string | number, any] | null = null;
	private savepoints: string[] = [];

	constructor(stmt: Statement, program: VdbeProgram) {
		this.stmt = stmt;
		this.db = stmt.db;
		this.program = program;
		// --- Initialize Stack ---
		const initialStackSize = Math.max(program.numMemCells + 100, 1000);
		this.stack = new Array(initialStackSize).fill(null).map(() => ({ value: null }));
		this.stackPointer = 0;
		this.framePointer = 0; // Main frame starts at 0
		// -----------------------
		this.vdbeCursors = new Array(program.numCursors).fill(null).map(() => ({
			instance: null,
			vtab: null,
			// Removed isValid, isEof
			isEphemeral: false,
			sortedResults: null
		}));
		this.vtabContext = new FunctionContext(this.db);
		this.udfContext = new FunctionContext(this.db);
	}

	/** Apply bound parameters. Parameters are placed at absolute stack indices. */
	applyBindings(bindings: Map<number | string, SqlValue>): void {
		if (this.appliedBindings) return;
		console.log("VDBE applying bindings to stack...");
		bindings.forEach((value, key) => {
			const paramInfo = this.program.parameters.get(key);
			const stackIndex = paramInfo?.memIdx; // Absolute index from compiler
			if (stackIndex !== undefined && stackIndex >= 0) {
				// Parameters are generally for the main frame, access directly.
				this._setStackValue(stackIndex, value);
			} else {
				console.warn(`Could not map parameter ${key} to stack cell`);
			}
		});
		this.appliedBindings = true;
	}

	clearAppliedBindings(): void {
		this.appliedBindings = false;
	}

	/** Resets the VDBE to its initial state */
	async reset(): Promise<void> {
		this.programCounter = 0;
		this.stackPointer = 0;
		this.framePointer = 0;
		this.appliedBindings = false;
		this.hasYielded = false;
		this.done = false;
		this.error = null;
		this.udfContext._clear();
		this.udfContext._cleanupAuxData();
		this.aggregateContexts.clear();
		this.aggregateIterator = null;
		this.currentAggregateEntry = null;
		this.savepoints = [];

		const closePromises: Promise<void>[] = [];
		for (let i = 0; i < this.vdbeCursors.length; i++) {
			const cursor = this.vdbeCursors[i];
			if (cursor.sortedResults) cursor.sortedResults = null;
			if (cursor.instance) closePromises.push(cursor.instance.close()); // Call close on cursor instance
			if (cursor.isEphemeral) this.ephemeralTables.delete(i);
			this.vdbeCursors[i] = { instance: null, vtab: null, sortedResults: null }; // Reset cursor info
		}
		this.ephemeralTables.clear();
		await Promise.allSettled(closePromises);
	}

	/** Executes the VDBE program */
	async run(): Promise<StatusCode> {
		if (this.done || this.error) {
			return this.error ? this.error.code : StatusCode.MISUSE;
		}
		this.hasYielded = false;

		try {
			if (!this.appliedBindings) {
				// Apply empty bindings if none were provided, to ensure parameter slots are initialized (likely to null)
				this.applyBindings(new Map());
			}
			while (!this.done && !this.hasYielded && !this.error) {
				const instruction = this.program.instructions[this.programCounter];
				if (!instruction) {
					this.error = new SqliteError(`Invalid program counter: ${this.programCounter}`, StatusCode.INTERNAL);
					break;
				}

				console.debug(`VDBE Exec: [${this.programCounter}] FP=${this.framePointer} SP=${this.stackPointer} ${Opcode[instruction.opcode]} ${instruction.p1} ${instruction.p2} ${instruction.p3} ${instruction.p4 !== null ? `P4:${String(instruction.p4)}` : ''} ${instruction.comment ? `-- ${instruction.comment}` : ''}`);

				await this.executeInstruction(instruction);

				// Check if instruction handled PC, otherwise increment
				if (!this.error && !this.done && !this.hasYielded && this.programCounter < this.program.instructions.length && this.program.instructions[this.programCounter] === instruction) {
					this.programCounter++;
				}
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
			this.done = true;
		}

		if (this.error) return this.error.code;
		if (this.hasYielded) return StatusCode.ROW;
		if (this.done) return StatusCode.DONE;

		return StatusCode.INTERNAL;
	}

	// --- Stack Access Helpers ---
	/** Sets an absolute stack index */
	private _setStackValue(index: number, value: SqlValue): void {
		if (index < 0) throw new SqliteError(`Invalid stack write index ${index}`, StatusCode.INTERNAL);
		// Ensure stack capacity
		while (index >= this.stack.length) this.stack.push({ value: null });
		// Update stack pointer if writing beyond current top
		if (index >= this.stackPointer) this.stackPointer = index + 1;
		// Ensure cell exists (though while loop should handle it)
		if (!this.stack[index]) this.stack[index] = { value: null };
		// Deep copy blobs, other values are immutable or primitives
		this.stack[index].value = (value instanceof Uint8Array) ? value.slice() : value;
	}

	/** Gets an absolute stack index */
	private _getStackValue(index: number): SqlValue {
		if (index < 0 || index >= this.stackPointer) {
			// Accessing uninitialized stack or below stack base - return NULL
			// console.warn(`Read attempt outside stack bounds: Index=${index}, SP=${this.stackPointer}`);
			return null;
		}
		// Cell might not exist if stack shrunk and grew again? Unlikely with current logic.
		return this.stack[index]?.value ?? null;
	}

	/** Gets value relative to Frame Pointer (handles locals, control info, and caller args) */
	private _getMemValue(frameOffset: number): SqlValue {
		const stackIndex = this.framePointer + frameOffset;
		return this._getStackValue(stackIndex);
	}

	/** Sets value relative to Frame Pointer (only for locals >= localsStartOffset) */
	private _setMem(frameOffset: number, value: SqlValue): void {
		// Strict check: Only allow setting locals via _setMem
		if (frameOffset < this.localsStartOffset) {
			throw new SqliteError(`Write attempt to control info/argument area via _setMem: Offset=${frameOffset}`, StatusCode.INTERNAL);
		}
		const stackIndex = this.framePointer + frameOffset;
		this._setStackValue(stackIndex, value);
	}
	// -------------------------

	/** Executes a single VDBE instruction */
	private async executeInstruction(inst: VdbeInstruction): Promise<void> {
		const p1 = inst.p1;
		const p2 = inst.p2;
		const p3 = inst.p3;
		const p4 = inst.p4;
		const p5 = inst.p5;

		const conditionalJump = (result: boolean) => {
			if (result) this.programCounter = p2;
			else this.programCounter++;
		};

		switch (inst.opcode) {
			case Opcode.Init:
			case Opcode.Goto: this.programCounter = p2; return;

			// --- Frame Management ---
			case Opcode.FrameEnter: { // P1=FrameSize (num locals + control info)
				const frameSize = p1; // Includes control info + locals
				const newFP = this.stackPointer - 1; // FP points to Return Addr slot
				const requiredStackTop = newFP + frameSize;
				while (requiredStackTop > this.stack.length) this.stack.push({ value: null });
				this._setStackValue(newFP + 1, this.framePointer); // Save Old FP at FP+1
				for (let i = this.localsStartOffset; i < frameSize; i++) {
					this._setStackValue(newFP + i, null);
				}
				this.framePointer = newFP; // Update FP to new frame base
				this.stackPointer = requiredStackTop; // Update SP to top of allocated frame
				break; // PC increments normally
			}
			case Opcode.FrameLeave: { // P1= Unused (Return handles jump)
				if (this.framePointer === 0 && this._getStackValue(1) === null) { // Check if we are in the initial frame
					console.warn("FrameLeave called on base frame? Potentially harmless if program ends.");
				} else {
					const oldFPVal = this._getStackValue(this.framePointer + 1); // Old FP is at FP+1
					const oldFP = typeof oldFPVal === 'number' ? oldFPVal : -1;
					if (isNaN(oldFP) || oldFP < 0) throw new SqliteError(`Invalid old frame pointer ${oldFPVal} at FP ${this.framePointer + 1}`, StatusCode.INTERNAL);
					this.stackPointer = this.framePointer; // Pop frame by resetting SP to frame base (where RetAddr was)
					this.framePointer = oldFP; // Restore caller's FP
				}
				break; // PC increments normally (Return opcode handles the jump)
			}
			case Opcode.Push: { // P1=SrcRegOffset (relative to current FP)
				const valueToPush = this._getMemValue(p1);
				this._setStackValue(this.stackPointer, valueToPush); // SP automatically increments
				break;
			}

			// --- Subroutine/Return (Stack Frame Aware) ---
			case Opcode.Subroutine: { // P1=NumArgsPushed, P2=addr_Target
				const targetAddr = p2;
				const returnAddr = this.programCounter + 1;
				this._setStackValue(this.stackPointer, returnAddr); // SP increments
				this.programCounter = targetAddr; // Jump to subroutine
				return; // PC handled
			}
			case Opcode.Return: { // P1=unused
				const jumpTargetVal = this._getStackValue(this.stackPointer); // Read RetAddr saved by Subroutine (now at SP)
				const jumpTarget = typeof jumpTargetVal === 'number' ? jumpTargetVal : -1;
				if (!Number.isInteger(jumpTarget) || jumpTarget < 0) throw new SqliteError(`Invalid return address ${jumpTargetVal} at SP ${this.stackPointer} (expected after FrameLeave)`, StatusCode.INTERNAL);
				this.stackPointer++; // Increment SP *after* reading the value at the old SP
				this.programCounter = jumpTarget;
				return; // PC handled
			}

			// --- Standard Register Ops (Use _setMem/_getMem for frame-relative access) ---
			case Opcode.Integer: this._setMem(p2, p1); break;
			case Opcode.Int64: this._setMem(p2, this.program.constants[p4 as number]); break;
			case Opcode.String8: this._setMem(p2, this.program.constants[p4 as number]); break;
			case Opcode.Null: this._setMem(p2, null); break;
			case Opcode.Real: this._setMem(p2, this.program.constants[p4 as number]); break;
			case Opcode.Blob: this._setMem(p2, this.program.constants[p4 as number]); break;
			case Opcode.ZeroBlob: { const s=Number(this._getMemValue(p1)); this._setMem(p2, new Uint8Array(s>=0?Math.trunc(s):0)); break; }
			case Opcode.SCopy: this._setMem(p2, this._getMemValue(p1)); break;
			case Opcode.Clear: {
				const startOffset = p1; const count = p2; if (startOffset < this.localsStartOffset) throw new SqliteError(`Clear opcode attempt to clear control/arg area: Offset=${startOffset}`, StatusCode.INTERNAL);
				const clearStartIdx = this.framePointer + startOffset; const clearEndIdx = clearStartIdx + count;
				if (clearStartIdx < 0 || clearEndIdx > this.stackPointer) throw new SqliteError(`Clear opcode stack access out of bounds: FP=${this.framePointer} Offset=${startOffset} Count=${count} SP=${this.stackPointer}`, StatusCode.INTERNAL);
				for (let i = clearStartIdx; i < clearEndIdx; i++) this._setStackValue(i, null);
				break;
			}
			case Opcode.IfTrue: conditionalJump(evaluateIsTrue(this._getMemValue(p1))); return;
			case Opcode.IfFalse: conditionalJump(!evaluateIsTrue(this._getMemValue(p1))); return;
			case Opcode.IfZero: { const v = this._getMemValue(p1); conditionalJump(v === 0 || v === 0n || v === null); return; }
			case Opcode.IfNull: conditionalJump(this._getMemValue(p1) === null); return;
			case Opcode.IfNotNull: conditionalJump(this._getMemValue(p1) !== null); return;
			case Opcode.IsNull: this._setMem(p2, this._getMemValue(p1) === null); break;
			case Opcode.NotNull: this._setMem(p2, this._getMemValue(p1) !== null); break;

			// Comparisons use frame-relative _getMemValue implicitly
			case Opcode.Eq: case Opcode.Ne: case Opcode.Lt: case Opcode.Le: case Opcode.Gt: case Opcode.Ge: {
				const v1 = this._getMemValue(p1); const v2 = this._getMemValue(p3); const jumpTarget = p2;
				const p4Coll = p4 as P4Coll | null; const collationName = p4Coll?.type === 'coll' ? p4Coll.name : 'BINARY';
				const comparisonResult = compareSqlValues(v1, v2, collationName); let conditionMet = false;
				switch (inst.opcode) {
					case Opcode.Eq: conditionMet = comparisonResult === 0; break; case Opcode.Ne: conditionMet = comparisonResult !== 0; break;
					case Opcode.Lt: conditionMet = comparisonResult < 0; break; case Opcode.Le: conditionMet = comparisonResult <= 0; break;
					case Opcode.Gt: conditionMet = comparisonResult > 0; break; case Opcode.Ge: conditionMet = comparisonResult >= 0; break;
				}
				conditionalJump(conditionMet); return;
			}

			// Arithmetic/String ops use frame-relative _getMemValue/_setMem implicitly
			case Opcode.Add: this._binaryArithOp(p1, p2, p3, (a, b) => Number(a) + Number(b)); break;
			case Opcode.Subtract: this._binaryArithOp(p1, p2, p3, (a, b) => Number(b) - Number(a)); break;
			case Opcode.Multiply: this._binaryArithOp(p1, p2, p3, (a, b) => Number(a) * Number(b)); break;
			case Opcode.Divide: { const d = this._getMemValue(p1); const n = this._getMemValue(p2); this._setMem(p3, (d === 0 || d === 0n || d === null || n === null || Number(d) === 0) ? null : Number(n) / Number(d)); } break;
			case Opcode.Remainder: { const d = this._getMemValue(p1); const n = this._getMemValue(p2); let res: SqlValue = null; try { if(d!==null && n!==null) { if(typeof d==='bigint' || typeof n==='bigint'){const b1=BigInt(d as any);const b2=BigInt(n as any);if(b1!==0n)res=b2%b1;}else{const n1=Number(d);const n2=Number(n);if(n1!==0&&!isNaN(n1)&&!isNaN(n2))res=n2%n1;}}}catch{} this._setMem(p3, res); } break;
			case Opcode.Concat: { let r = ''; for (let i = p1; i <= p2; i++) { const v = this._getMemValue(i); if(v!==null && !(v instanceof Uint8Array)) r += String(v); } this._setMem(p3, r); break; }
			case Opcode.Negative: { const v = this._getMemValue(p1); let res: SqlValue = null; try { if(v!==null) res = typeof v === 'bigint' ? -v : -Number(v); if(typeof res === 'number' && isNaN(res)) res = null; } catch { res = null; } this._setMem(p2, res); } break;
			case Opcode.BitAnd: case Opcode.BitOr: { const v1=this._getMemValue(p1); const v2=this._getMemValue(p2); let res: SqlValue = null; try { if(v1!==null&&v2!==null){ const i1=BigInt(v1 as any); const i2=BigInt(v2 as any); res = inst.opcode===Opcode.BitAnd ? (i1&i2) : (i1|i2); } } catch { res = 0n; } this._setMem(p3, res); break; }
			case Opcode.ShiftLeft: case Opcode.ShiftRight: { const amt=this._getMemValue(p1); const val=this._getMemValue(p2); let res: SqlValue = null; try { if(amt!==null&&val!==null){ const iAmt=BigInt(amt as any); const iVal=BigInt(val as any); res = inst.opcode===Opcode.ShiftLeft ? (iVal<<iAmt) : (iVal>>iAmt); } } catch { res = 0n; } this._setMem(p3, res); break; }
			case Opcode.BitNot: { const v=this._getMemValue(p1); let res: SqlValue = null; try { if(v!==null) res = ~BigInt(v as any); } catch { res = -1n; } this._setMem(p2, res); break; }

			// --- Function calls use frame-relative args ---
			case Opcode.Function: {
				const p4Func = p4 as P4FuncDef; if(!p4Func || p4Func.type !== 'funcdef') throw new SqliteError("Invalid P4 for Function", StatusCode.INTERNAL);
				const args: SqlValue[] = []; for(let i=0; i<p4Func.nArgs; i++) args.push(this._getMemValue(p2 + i));
				this.udfContext = new FunctionContext(this.db, p4Func.funcDef.userData); this.udfContext._clear();
				try { p4Func.funcDef.xFunc!(this.udfContext, Object.freeze(args)); const err = this.udfContext._getError(); if(err) throw err; this._setMem(p3, this.udfContext._getResult()); } catch(e) { if(e instanceof Error) throw new SqliteError(`Func ${p4Func.funcDef.name}: ${e.message}`, StatusCode.ERROR); throw e; }
				break;
			}

			// --- Aggregation Ops use frame-relative args/keys ---
			case Opcode.MakeRecord: { const v:SqlValue[]=[]; for(let i=0; i<p2; i++) v.push(this._getMemValue(p1+i)); const serKey = JSON.stringify(v, (_,val)=>typeof val==='bigint'?val.toString()+'n':val instanceof Uint8Array?`blob:${Buffer.from(val).toString('hex')}`:val); this._setMem(p3, serKey); break; }
			case Opcode.AggStep: {
				const p4Func = p4 as P4FuncDef; if(!p4Func || p4Func.type !== 'funcdef') throw new SqliteError("Invalid P4 for AggStep", StatusCode.INTERNAL);
				const serializedKey = this._getMemValue(p3) as string; let mapKey:string|number = serializedKey;
				const args: SqlValue[] = []; for(let i=0; i<p4Func.nArgs; i++) args.push(this._getMemValue(p2+i));
				let entry = this.aggregateContexts.get(mapKey); this.udfContext._clear(); this.udfContext._setAggregateContextRef(entry?.accumulator);
				try {
					p4Func.funcDef.xStep!(this.udfContext, Object.freeze(args)); const stepError = this.udfContext._getError(); if (stepError) throw stepError;
					const newAcc = this.udfContext._getAggregateContextRef();
					if(entry === undefined && newAcc !== undefined){ const keys=[]; for(let i=0; i<p5; i++) keys.push(this._getMemValue(p1+i)); this.aggregateContexts.set(mapKey, {accumulator:newAcc, keyValues:Object.freeze(keys)}); }
					else if(entry !== undefined && newAcc !== undefined && newAcc !== entry.accumulator) { entry.accumulator = newAcc; }
				} catch(e) {
					console.error(`VDBE AggStep Error in function ${p4Func.funcDef.name}:`, e);
					if (e instanceof SqliteError) { this.error = e; } else if (e instanceof Error) { this.error = new SqliteError(`Runtime error in aggregate ${p4Func.funcDef.name} xStep: ${e.message}`, StatusCode.ERROR); }
					else { this.error = new SqliteError(`Unknown runtime error in aggregate ${p4Func.funcDef.name} xStep`, StatusCode.INTERNAL); } this.done = true; return;
				}
				break;
			}
			case Opcode.AggFinal: {
				const p4Func = p4 as P4FuncDef; if(!p4Func || p4Func.type !== 'funcdef') throw new SqliteError("Invalid P4 for AggFinal", StatusCode.INTERNAL);
				const serializedKey = this._getMemValue(p1) as string; let mapKey:string|number = serializedKey;
				const entry = this.aggregateContexts.get(mapKey); this.udfContext = new FunctionContext(this.db, p4Func.funcDef.userData); this.udfContext._clear(); this.udfContext._setAggregateContextRef(entry?.accumulator);
				try { p4Func.funcDef.xFinal!(this.udfContext); const err = this.udfContext._getError(); if(err) throw err; this._setMem(p3, this.udfContext._getResult()); } catch(e) { this.handleUdfError(e, p4Func.funcDef.name, this.programCounter, 'xFinal'); return; }
				break;
			}
			case Opcode.AggReset: { this.aggregateContexts.clear(); this.aggregateIterator = null; this.currentAggregateEntry = null; break; } // PC increments normally
			case Opcode.AggIterate: this.aggregateIterator = this.aggregateContexts.entries(); this.currentAggregateEntry = null; break; // PC increments normally
			case Opcode.AggNext: { if(!this.aggregateIterator) throw new SqliteError("AggNext without AggIterate", StatusCode.INTERNAL); const n=this.aggregateIterator.next(); if(n.done){this.currentAggregateEntry=null;this.programCounter=p2;}else{this.currentAggregateEntry=n.value;this.programCounter++;} return; }
			case Opcode.AggKey: { if(!this.currentAggregateEntry) throw new SqliteError("AggKey on invalid iterator", StatusCode.INTERNAL); let storeKey:SqlValue=this.currentAggregateEntry[0]; this._setMem(p2, storeKey); break; }
			case Opcode.AggContext: { if(!this.currentAggregateEntry) throw new SqliteError("AggContext on invalid iterator", StatusCode.INTERNAL); this._setMem(p2, this.currentAggregateEntry[1]?.accumulator); break; }
			case Opcode.AggGroupValue: { if(!this.currentAggregateEntry) throw new SqliteError("AggGroupValue on invalid iterator", StatusCode.INTERNAL); this._setMem(p3, this.currentAggregateEntry[1]?.keyValues[p2]??null); break; }

			// Affinity uses frame-relative registers
			case Opcode.Affinity: {
				const startOffset = p1; const count = p2; const affinityStr = (p4 as string).toUpperCase();
				const startIdx = this.framePointer + startOffset; const endIdx = startIdx + count;
				if (startOffset < this.localsStartOffset) throw new SqliteError(`Affinity opcode attempt on control/arg area: Offset=${startOffset}`, StatusCode.INTERNAL);
				if (startIdx < 0 || endIdx > this.stackPointer) throw new SqliteError(`Affinity opcode stack access out of bounds: FP=${this.framePointer} Offset=${startOffset} Count=${count} SP=${this.stackPointer}`, StatusCode.INTERNAL);
				let applyAffinityFn: (v: SqlValue) => SqlValue;
				switch (affinityStr) {
					case 'NUMERIC': applyAffinityFn = applyNumericAffinity; break; case 'INTEGER': applyAffinityFn = applyIntegerAffinity; break;
					case 'REAL': applyAffinityFn = applyRealAffinity; break; case 'TEXT': applyAffinityFn = applyTextAffinity; break;
					case 'BLOB': applyAffinityFn = applyBlobAffinity; break; default: applyAffinityFn = (v) => v;
				}
				for (let i = 0; i < count; i++) { const offset = startOffset + i; const currentValue = this._getMemValue(offset); const newValue = applyAffinityFn(currentValue); if (newValue !== currentValue) this._setMem(offset, newValue); }
				break;
			}

			case Opcode.Move: {
				const srcOffset = p1; const destOffset = p2; const count = p3;
				const srcBaseIdx = this.framePointer + srcOffset; const destBaseIdx = this.framePointer + destOffset;
				if (srcBaseIdx < 0 || destBaseIdx < 0 || srcBaseIdx + count > this.stackPointer || destBaseIdx + count > this.stackPointer) throw new SqliteError(`Move opcode stack access out of bounds: FP=${this.framePointer} SrcOff=${srcOffset} DestOff=${destOffset} Count=${count} SP=${this.stackPointer}`, StatusCode.INTERNAL);
				if (srcBaseIdx === destBaseIdx) break;
				if (destBaseIdx > srcBaseIdx && destBaseIdx < srcBaseIdx + count) { for (let i = count - 1; i >= 0; i--) this._setStackValue(destBaseIdx + i, this._getStackValue(srcBaseIdx + i)); }
				else { for (let i = 0; i < count; i++) this._setStackValue(destBaseIdx + i, this._getStackValue(srcBaseIdx + i)); }
				break;
			}

			// --- Cursor Ops (Updated to use cursor methods) ---
			case Opcode.OpenRead: case Opcode.OpenWrite: {
				const cIdx = p1; const schema = p4 as TableSchema;
				if (!schema?.vtabInstance?.module?.xOpen) throw new SqliteError("Missing vtab instance or module.xOpen for OpenRead/OpenWrite", StatusCode.INTERNAL);
				const v = schema.vtabInstance;
				// Module's xOpen creates the cursor instance
				const ci = await v.module.xOpen(v);
				this.vdbeCursors[cIdx] = { instance: ci, vtab: v, sortedResults: null };
				break;
			}
			case Opcode.Close: {
				const cIdx = p1; const c = this.vdbeCursors[cIdx];
				if (c) {
					if (c.sortedResults) c.sortedResults = null;
					// Call close directly on the cursor instance
					if (c.instance) await c.instance.close();
					if (c.isEphemeral) this.ephemeralTables.delete(cIdx);
					this.vdbeCursors[cIdx] = { instance: null, vtab: null, sortedResults: null }; // Reset VDBE cursor state
				}
				break;
			}
			case Opcode.VFilter: {
				const cIdx = p1, addr = p2, argsReg = p3, info = p4 as any;
				const c = this.vdbeCursors[cIdx];
				if (!c?.instance) throw new SqliteError("VFilter on unopened cursor", StatusCode.INTERNAL);
				const args: SqlValue[] = []; for (let i = 0; i < info.nArgs; i++) args.push(this._getMemValue(argsReg + i));
				try {
					// Call filter on cursor instance
					await c.instance.filter(info.idxNum, info.idxStr, args);
					const eof = c.instance.eof(); // Check cursor's EOF state
					if (eof) this.programCounter = addr; else this.programCounter++;
				} catch (e) { this.handleVTabError(e, c.vtab?.tableName ?? `cursor ${cIdx}`, 'filter', this.programCounter); return; }
				return;
			}
			case Opcode.VNext: {
				const cIdx = p1, addr = p2;
				const c = this.vdbeCursors[cIdx];
				if (c?.sortedResults) { /* Sorted results logic remains the same */
					const s = c.sortedResults;
					s.index++;
					if (s.index >= s.rows.length) this.programCounter = addr; // EOF for sorted results
					else this.programCounter++;
					return;
				}
				if (!c?.instance) throw new SqliteError("VNext on unopened cursor", StatusCode.INTERNAL);
				try {
					// Call next on cursor instance
					await c.instance.next();
					const eof = c.instance.eof(); // Check cursor's EOF state
					if (eof) this.programCounter = addr; else this.programCounter++;
				} catch (e) { this.handleVTabError(e, c.vtab?.tableName ?? `cursor ${cIdx}`, 'next', this.programCounter); return; }
				return;
			}
			case Opcode.Rewind: {
				const cIdx = p1, addr = p2;
				const c = this.vdbeCursors[cIdx];
				if (c?.sortedResults) { /* Sorted results logic remains the same */
					const s = c.sortedResults;
					s.index = 0;
					if (s.index >= s.rows.length) this.programCounter = addr; // EOF if empty
					else this.programCounter++;
					return;
				}
				if (!c?.instance) throw new SqliteError("Rewind on unopened cursor", StatusCode.INTERNAL);
				try {
					// Call filter with no constraints on cursor instance
					await c.instance.filter(0, null, []);
					const eof = c.instance.eof(); // Check cursor's EOF state
					if (eof) this.programCounter = addr; else this.programCounter++;
				} catch (e) { this.handleVTabError(e, c.vtab?.tableName ?? `cursor ${cIdx}`, 'filter(rewind)', this.programCounter); return; }
				return;
			}
			case Opcode.VColumn: {
				const cIdx = p1, col = p2, destOff = p3;
				const c = this.vdbeCursors[cIdx];
				if (c?.sortedResults) { /* Sorted results logic remains the same */
					const s = c.sortedResults;
					if (s.index < 0 || s.index >= s.rows.length) throw new SqliteError("VColumn on invalid sorted cursor", StatusCode.INTERNAL);
					const r = s.rows[s.index];
					if (col < -1 || col >= r.length) throw new SqliteError(`VColumn index ${col} out of bounds for sorted cursor ${cIdx}`, StatusCode.INTERNAL);
					// Assuming rowid is handled elsewhere or not needed for sorted ephemerals
					this._setMem(destOff, r[col].value);
					break;
				}
				if (!c?.instance || c.instance.eof()) throw new SqliteError("VColumn on invalid/EOF cursor", StatusCode.INTERNAL);
				try {
					this.vtabContext._clear();
					// Call column on cursor instance
					const st = c.instance.column(this.vtabContext, col);
					if (st !== StatusCode.OK) throw new SqliteError(`column failed (col ${col}, cursor ${cIdx})`, st);
					this._setMem(destOff, this.vtabContext._getResult());
				} catch (e) { this.handleVTabError(e, c.vtab?.tableName ?? `cursor ${cIdx}`, 'column', this.programCounter); return; }
				break;
			}
			case Opcode.VRowid: {
				const cIdx = p1, destOff = p2;
				const c = this.vdbeCursors[cIdx];
				if (!c?.instance || c.instance.eof()) throw new SqliteError("VRowid on invalid/EOF cursor", StatusCode.INTERNAL);
				try {
					// Call rowid on cursor instance
					const rid = await c.instance.rowid();
					this._setMem(destOff, rid);
				} catch (e) { this.handleVTabError(e, c.vtab?.tableName ?? `cursor ${cIdx}`, 'rowid', this.programCounter); return; }
				break;
			}
			case Opcode.VUpdate:	// VUpdate still calls the module's xUpdate method
				{
					const regDataStart = p2; // Start register of data (rowid, col0, col1...)
					const regOut = p3;	 	 // Register to store result (e.g., new rowid for INSERT)
					const nData = p1; // Number of data elements (including rowid)
					const p4Info = p4 as { table: TableSchema, onConflict?: ConflictResolution };
					// Module and xUpdate method check remains on the *module* instance
					if (!p4Info?.table?.vtabInstance?.module?.xUpdate) {
						throw new SqliteError("VUpdate called on non-virtual table or module lacks xUpdate", StatusCode.INTERNAL);
					}

					const values: SqlValue[] = []; for (let i = 0; i < nData; i++) values.push(this._getMemValue(regDataStart + i) ?? null);
					(values as any)._onConflict = p4Info.onConflict || ConflictResolution.ABORT;
					const rowidFromData = values[0];

					try {
						// Call xUpdate on the *module* instance, passing the *table* instance
						const result = await p4Info.table.vtabInstance.module.xUpdate(p4Info.table.vtabInstance, values, rowidFromData as bigint | null);
						if (regOut > 0) {
							if (values[0] === null) { // INSERT operation
								if (result && result.rowid !== undefined) { this._setMem(regOut, result.rowid); }
								else { this._setMem(regOut, null); }
							} else { this._setMem(regOut, null); } // UPDATE/DELETE
						}
					} catch (e) { this.handleVTabError(e, p4Info.table.name, 'xUpdate', this.programCounter); return; }
				}
				break;
			case Opcode.VBegin: case Opcode.VCommit: case Opcode.VRollback: case Opcode.VSync:
			case Opcode.VSavepoint: case Opcode.VRelease: case Opcode.VRollbackTo:
				// These still call module methods, logic remains the same
				{
					const vtabOp = async (action: 'xBegin' | 'xCommit' | 'xRollback' | 'xSync' | 'xSavepoint' | 'xRelease' | 'xRollbackTo', savepointIdx?: number) => {
						for (let i = p1; i < p2; i++) {
							const c = this.vdbeCursors[i];
							if (c?.vtab?.module && typeof (c.vtab.module as any)[action] === 'function') {
								try {
									if (action === 'xSavepoint' || action === 'xRelease' || action === 'xRollbackTo') {
										await (c.vtab.module as any)[action](c.vtab, savepointIdx);
									} else {
										await (c.vtab.module as any)[action](c.vtab);
									}
								} catch (e) { this.handleVTabError(e, c.vtab.tableName, action, this.programCounter); return false; }
							}
						}
						return true;
					};
					let success = false;
					switch (inst.opcode) {
						case Opcode.VBegin: success = await vtabOp('xBegin'); break;
						case Opcode.VCommit: success = await vtabOp('xCommit'); break;
						case Opcode.VRollback: success = await vtabOp('xRollback'); break;
						case Opcode.VSync: success = await vtabOp('xSync'); break;
						case Opcode.VSavepoint: success = await vtabOp('xSavepoint', p3); break;
						case Opcode.VRelease: success = await vtabOp('xRelease', p3); break;
						case Opcode.VRollbackTo: success = await vtabOp('xRollbackTo', p3); break;
					}
					if (!success) return; // Error handled by vtabOp
				}
				break;

			case Opcode.ResultRow: // P1=startOffset, P2=count (Unchanged)
				const startIdx = this.framePointer + p1;
				if (startIdx < 0 || startIdx + p2 > this.stackPointer) throw new SqliteError(`ResultRow stack access out of bounds: FP=${this.framePointer} Offset=${p1} Count=${p2} SP=${this.stackPointer}`, StatusCode.INTERNAL);
				this.stmt.setCurrentRow(this.stack.slice(startIdx, startIdx + p2));
				this.hasYielded = true;
				this.programCounter++;
				return;

			case Opcode.Sort: // P1=cursorIdx, P4=SortKeyInfo (Unchanged - still uses module methods implicitly via MemoryTable)
				{
					const cIdx = p1;
					const sortInfo = p4 as P4SortKey | null;
					const c = this.vdbeCursors[cIdx];
					if (!c || !c.vtab || !(c.vtab instanceof MemoryTable) || !sortInfo) {
						throw new SqliteError(`Sort requires an open ephemeral MemoryTable cursor and SortKeyInfo`, StatusCode.INTERNAL);
					}
					const memTable = c.vtab as MemoryTable;
					if (!memTable.isSorter) {
						memTable._configureAsSorter(sortInfo);
					}
					// The actual sorting happens implicitly via BTree insertion order.
					// The Rewind/Next opcodes on this cursor will now yield sorted data.
					// We *could* materialize into sortedResults here, but let's rely on BTree iteration for now.
				}
				break;

			case Opcode.Halt: // (Unchanged)
				this.done = true;
				if (p1 !== StatusCode.OK) {
					this.error = new SqliteError(p4 ?? `Execution halted with code ${p1}`, p1);
				}
				break;

			case Opcode.Noop: break; // Do nothing

			case Opcode.OpenEphemeral: { // (Unchanged)
				const ephCursorIdx = p1; const ephNumCols = p2; const providedSchema = p4 as TableSchema | null;
				const ephTable = new MemoryTable(this.db, Vdbe.ephemeralModule, '_temp_internal', `_eph_${ephCursorIdx}`);
				this.ephemeralTables.set(ephCursorIdx, { table: ephTable, module: Vdbe.ephemeralModule });
				if (providedSchema?.columns && providedSchema.primaryKeyDefinition) {
					const cols = providedSchema.columns.map(c => ({ name: c.name, type: undefined, collation: c.collation }));
					ephTable.setColumns(cols, providedSchema.primaryKeyDefinition);
				} else {
					const defaultCols = Array.from({ length: ephNumCols }, (_, i) => ({ name: `eph_col${i}`, type: undefined, collation: 'BINARY' }));
					ephTable.setColumns(defaultCols, []);
				}
				// Use module xOpen to get the cursor instance
				const ephInstance = await Vdbe.ephemeralModule.xOpen(ephTable);
				this.vdbeCursors[ephCursorIdx] = { instance: ephInstance, vtab: ephTable, isEphemeral: true, sortedResults: null };
				break;
			}

			case Opcode.ConstraintViolation: { // (Unchanged)
				const context = (typeof p4 === 'string' && p4) ? p4 : 'Constraint failed';
				throw new ConstraintError(context);
			}

			case Opcode.StackPop: { // P1=Count (Unchanged)
				const count = p1; if (count < 0) throw new SqliteError("StackPop count cannot be negative", StatusCode.INTERNAL);
				if (this.stackPointer < count) throw new SqliteError(`Stack underflow during StackPop: SP=${this.stackPointer}, Count=${count}`, StatusCode.INTERNAL);
				this.stackPointer -= count;
				break;
			}

			// --- New SeekRelative opcode --- (Updated to use cursor method)
			case Opcode.SeekRelative: {
				const cIdx = p1; const addrJump = p2; const offsetReg = p3; const invertJump = p5 === 1;
				const cursor = this.vdbeCursors[cIdx];
				if (!cursor?.instance) throw new SqliteError(`SeekRelative: Invalid cursor index ${cIdx}`, StatusCode.INTERNAL);

				const offsetValue = this._getMemValue(offsetReg);
				let offset: number;
				if (typeof offsetValue === 'number') offset = offsetValue;
				else if (typeof offsetValue === 'bigint') offset = Number(offsetValue);
				else throw new SqliteError(`SeekRelative: Offset value must be a number or bigint, got ${typeof offsetValue}`, StatusCode.INTERNAL);

				let seekResult = false;
				try {
					// Call seekRelative on cursor instance
					seekResult = await cursor.instance.seekRelative(offset);
				} catch (e) { this.handleVTabError(e, `cursor ${cIdx}`, 'seekRelative', this.programCounter); return; }

				// Jump logic
				if ((seekResult && !invertJump) || (!seekResult && invertJump)) this.programCounter = addrJump;
				else this.programCounter++;
				return;
			}

			// --- New SeekRowid opcode --- (Updated to use cursor method)
			case Opcode.SeekRowid: {
				const cIdx = p1; const addrJump = p2; const rowidReg = p3; const invertJump = p5 === 1;
				const cursor = this.vdbeCursors[cIdx];
				if (!cursor?.instance) throw new SqliteError(`SeekRowid: Invalid cursor index ${cIdx}`, StatusCode.INTERNAL);

				const rowidValue = this._getMemValue(rowidReg);
				let targetRowid: bigint;
				if (typeof rowidValue === 'bigint') targetRowid = rowidValue;
				else if (typeof rowidValue === 'number' && Number.isInteger(rowidValue)) targetRowid = BigInt(rowidValue);
				else throw new SqliteError(`SeekRowid: Target rowid must be an integer or bigint, got ${typeof rowidValue}`, StatusCode.INTERNAL);

				let seekResult = false;
				try {
					// Call seekToRowid on cursor instance
					seekResult = await cursor.instance.seekToRowid(targetRowid);
				} catch (e) { this.handleVTabError(e, `cursor ${cIdx}`, 'seekToRowid', this.programCounter); return; }

				// Jump logic
				if ((seekResult && !invertJump) || (!seekResult && invertJump)) this.programCounter = addrJump;
				else this.programCounter++;
				return;
			}

			// --- Add SchemaChange handler --- (Unchanged - still uses module method)
			case Opcode.SchemaChange:
				{
					const cursorIdx = p1!;
					const changeInfo = p4 as P4SchemaChange;
					try {
						if (cursorIdx < 0 || cursorIdx >= this.vdbeCursors.length || !this.vdbeCursors[cursorIdx]) throw new SqliteError(`SchemaChange: Invalid cursor index ${cursorIdx}`, StatusCode.INTERNAL);
						const cursor = this.vdbeCursors[cursorIdx];
						const vtab = cursor.vtab;
						if (!vtab) throw new SqliteError(`SchemaChange: Cursor ${cursorIdx} does not refer to an open virtual table`, StatusCode.INTERNAL);
						const module = vtab.module as VirtualTableModule<any, any, any>;
						if (typeof module.xAlterSchema === 'function') {
							await module.xAlterSchema(vtab, changeInfo);
							console.log(`VDBE SchemaChange: Successfully executed on table ${vtab.tableName}`);
						} else {
							throw new SqliteError(`ALTER TABLE operation not supported by virtual table module for table '${vtab.tableName}'`, StatusCode.MISUSE);
						}
					} catch (e: any) {
						if (e instanceof SqliteError) { this.error = e; } else { const msg = `SchemaChange failed: ${e instanceof Error ? e.message : String(e)}`; this.error = new SqliteError(msg, StatusCode.ERROR, e instanceof Error ? e : undefined); }
						this.done = true; return;
					}
					this.programCounter++; // Increment PC only on success
				}
				return;

			case Opcode.AlterTable: // Placeholder - No action needed yet (Unchanged)
				break; // PC increments normally

			default:
				throw new SqliteError(`Unsupported opcode: ${Opcode[inst.opcode]} (${inst.opcode})`, StatusCode.INTERNAL);
		}

		// Default PC increment
		if (this.programCounter < this.program.instructions.length && this.program.instructions[this.programCounter] === inst) {
			this.programCounter++;
		}
	}

	// --- Updated binaryArithOp --- (Unchanged)
	private _binaryArithOp(r1Offset: number, r2Offset: number, destOffset: number, op: (a: any, b: any) => any): void {
		const v1 = this._getMemValue(r1Offset); const v2 = this._getMemValue(r2Offset); let result: SqlValue = null;
		if (v1 !== null && v2 !== null) {
			if (typeof v1 === 'bigint' || typeof v2 === 'bigint') { try { result = op(BigInt(v1 as any), BigInt(v2 as any)); } catch { result = null; } }
			else { const n1 = Number(v1); const n2 = Number(v2); if (!isNaN(n1) && !isNaN(n2)) { try { result = op(n1, n2); } catch { result = null; } } }
		}
		this._setMem(destOffset, result);
	}

	/** Generic VDBE error handler */
	private handleVdbeError(e: any, opcodeName: string, pc: number): void {
		const message = `VDBE Error during ${opcodeName} at PC ${pc}: ${e instanceof Error ? e.message : String(e)}`;
		const code = e instanceof SqliteError ? e.code : StatusCode.INTERNAL;
		this.error = new SqliteError(message, code, e instanceof Error ? e : undefined);
		this.done = true;
		console.error(this.error);
	}

	/** VTab error handler */
	private handleVTabError(e: any, vtabName: string, method: string, pc: number): void {
		const message = `Error in VTab ${vtabName}.${method} at PC ${pc}: ${e instanceof Error ? e.message : String(e)}`;
		const code = e instanceof SqliteError ? e.code : StatusCode.ERROR;
		this.error = new SqliteError(message, code, e instanceof Error ? e : undefined);
		this.done = true;
		console.error(this.error);
	}

	/** UDF error handler */
	private handleUdfError(e: any, funcName: string, pc: number, step: string = 'xFunc'): void {
		const message = `Error in function ${funcName} (${step}) at PC ${pc}: ${e instanceof Error ? e.message : String(e)}`;
		const code = e instanceof SqliteError ? e.code : StatusCode.ERROR;
		this.error = new SqliteError(message, code, e instanceof Error ? e : undefined);
		this.done = true;
		console.error(this.error);
	}
}
