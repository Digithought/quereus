import type { RuntimeValue, SqlParameters, OutputValue, Row } from "../common/types.js";
import type { Database } from "../core/database.js";
import type { Statement } from "../core/statement.js";
import type { RowDescriptor, RowGetter, TableDescriptor, TableGetter } from "../planner/nodes/plan-node.js";
import type { Scheduler } from "./scheduler.js";
import type { EmissionContext } from "./emission-context.js";
import type { VirtualTableConnection } from "../vtab/connection.js";

export type RuntimeContext = {
	db: Database;
	stmt: Statement | null; // Can be null for transient exec statements
	params: SqlParameters; // User-provided values for the current execution
	/** Row contexts by row descriptor */
	context: Map<RowDescriptor, RowGetter>;
	/** Table contexts by table name, used for recursive CTEs or other temporary table situations */
	tableContexts: Map<TableDescriptor, TableGetter>;
	/** Debug tracer for instruction execution, if enabled */
	tracer?: InstructionTracer;
	/** Active connection for the current transaction context */
	activeConnection?: VirtualTableConnection;
	/** Whether to collect runtime execution metrics */
	enableMetrics: boolean;
	/** Context tracking for debugging context leaks */
	contextTracker?: ContextTracker;
};

export type InstructionRun = (ctx: RuntimeContext, ...args: any[]) => OutputValue;

export type Instruction = {
	params: Instruction[];
	run: InstructionRun;
	/** Optional human-readable note about what this instruction does */
	note?: string;
	/** Optional sub-programs used to execute this instruction - this is here for tracing purposes */
	programs?: Scheduler[];
	/** Optional emission context for schema validation */
	emissionContext?: EmissionContext;
	/** Optional runtime statistics collected during execution */
	runtimeStats?: InstructionRuntimeStats;
};

/**
 * Runtime statistics for instruction execution
 */
export interface InstructionRuntimeStats {
	/** Number of input values/rows processed */
	in: number;
	/** Number of output values/rows produced */
	out: number;
	/** Total execution time in nanoseconds */
	elapsedNs: bigint;
	/** Number of times this instruction was executed */
	executions: number;
}

/** * Trace event for instruction execution. */
export interface InstructionTraceEvent {
	instructionIndex: number;
	note?: string;
	type: 'input' | 'output' | 'row' | 'error';
	timestamp: number;
	args?: RuntimeValue[];
	result?: OutputValue;
	error?: string;
	/** Information about sub-programs if this instruction has any */
	subPrograms?: SubProgramInfo[];
	/** Row index within the async iterable (for 'row' type events) */
	rowIndex?: number;
	/** Row data (for 'row' type events) */
	row?: Row;
}

/** Information about a sub-program for tracing purposes */
export interface SubProgramInfo {
	programIndex: number;
	instructionCount: number;
	rootNote?: string;
}

/** * Interface for tracing instruction execution. */
export interface InstructionTracer {
	/** Called before an instruction executes */
	traceInput(instructionIndex: number, instruction: Instruction, args: RuntimeValue[]): void;
	/** Called after an instruction executes */
	traceOutput(instructionIndex: number, instruction: Instruction, result: OutputValue): void;
	/** Called when an instruction throws an error */
	traceError(instructionIndex: number, instruction: Instruction, error: Error): void;
	/** Called for each row emitted by an async iterable instruction */
	traceRow(instructionIndex: number, instruction: Instruction, rowIndex: number, row: Row): void;
	/** Gets collected trace events (if supported by the tracer) */
	getTraceEvents?(): InstructionTraceEvent[];
	/** Gets information about all sub-programs encountered during tracing */
	getSubPrograms?(): Map<number, { scheduler: Scheduler; parentInstructionIndex: number }>;
}

/** * Tracer that collects execution events for later analysis. */
export class CollectingInstructionTracer implements InstructionTracer {
	private events: InstructionTraceEvent[] = [];
	private subPrograms = new Map<number, { scheduler: Scheduler; parentInstructionIndex: number }>();
	private nextSubProgramId = 0;

	traceInput(instructionIndex: number, instruction: Instruction, args: RuntimeValue[]): void {
		const subPrograms = this.collectSubProgramInfo(instructionIndex, instruction);

		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'input',
			timestamp: Date.now(),
			args: this.cloneArgs(args),
			subPrograms
		});
	}

	traceOutput(instructionIndex: number, instruction: Instruction, result: OutputValue): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'output',
			timestamp: Date.now(),
			result: this.cloneResult(result)
		});
	}

	traceError(instructionIndex: number, instruction: Instruction, error: Error): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'error',
			timestamp: Date.now(),
			error: error.message
		});
	}

	traceRow(instructionIndex: number, instruction: Instruction, rowIndex: number, row: Row): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'row',
			timestamp: Date.now(),
			rowIndex,
			row
		});
	}

	getTraceEvents(): InstructionTraceEvent[] {
		return [...this.events];
	}

	getSubPrograms(): Map<number, { scheduler: Scheduler; parentInstructionIndex: number }> {
		return new Map(this.subPrograms);
	}

	clear(): void {
		this.events = [];
		this.subPrograms.clear();
		this.nextSubProgramId = 0;
	}

	private collectSubProgramInfo(instructionIndex: number, instruction: Instruction): SubProgramInfo[] | undefined {
		if (!instruction.programs || instruction.programs.length === 0) {
			return undefined;
		}

		return instruction.programs.map(scheduler => {
			const programId = this.nextSubProgramId++;
			this.subPrograms.set(programId, { scheduler, parentInstructionIndex: instructionIndex });

			return {
				programIndex: programId,
				instructionCount: scheduler.instructions.length,
				rootNote: scheduler.instructions[scheduler.instructions.length - 1]?.note
			};
		});
	}

	private cloneArgs(args: RuntimeValue[]): RuntimeValue[] {
		return args.map(arg => this.cloneValue(arg));
	}

	private cloneResult(result: OutputValue): OutputValue {
		return this.cloneValue(result);
	}

	private cloneValue(value: any): any {
		if (value === null || value === undefined) return value;
		if (typeof value === 'function') return '[Function]';
		if (typeof value === 'object' && Symbol.asyncIterator in value) return '[AsyncIterable]';
		if (Array.isArray(value)) return value.map(v => this.cloneValue(v));
		if (typeof value === 'object') return '[Object]';
		return value;
	}
}

/**
 * Tracks context additions and removals for debugging context leaks
 */
export interface ContextTracker {
	/** Record that a context was added */
	addContext(descriptor: RowDescriptor, source: string): void;
	/** Record that a context was removed */
	removeContext(descriptor: RowDescriptor): void;
	/** Get all remaining contexts with their sources */
	getRemainingContexts(): Array<{ descriptor: RowDescriptor; source: string }>;
	/** Check if there are any remaining contexts */
	hasRemainingContexts(): boolean;
}

/**
 * Default implementation of ContextTracker
 */
export class DefaultContextTracker implements ContextTracker {
	private contexts = new Map<RowDescriptor, string>();

	addContext(descriptor: RowDescriptor, source: string): void {
		this.contexts.set(descriptor, source);
	}

	removeContext(descriptor: RowDescriptor): void {
		this.contexts.delete(descriptor);
	}

	getRemainingContexts(): Array<{ descriptor: RowDescriptor; source: string }> {
		return Array.from(this.contexts.entries()).map(([descriptor, source]) => ({
			descriptor,
			source
		}));
	}

	hasRemainingContexts(): boolean {
		return this.contexts.size > 0;
	}
}
