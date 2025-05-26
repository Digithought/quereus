import type { RuntimeValue, SqlParameters, OutputValue, Row, SqlValue } from "../common/types.js";
import type { Database } from "../core/database.js";
import type { Statement } from "../core/statement.js";
import type { PlanNode } from "../planner/nodes/plan-node.js";
import type { Scheduler } from "./scheduler.js";

export type RuntimeContext = {
	db: Database;
	stmt: Statement | null; // Can be null for transient exec statements
	params: SqlParameters; // User-provided values for the current execution
	context: Map<PlanNode, () => SqlValue | Row>;
	/** Debug tracer for instruction execution, if enabled */
	tracer?: InstructionTracer;
};

export type InstructionRun = (ctx: RuntimeContext, ...args: any[]) => OutputValue | Promise<OutputValue>;

export type Instruction = {
	params: Instruction[];
	run: InstructionRun;
	/** Optional human-readable note about what this instruction does */
	note?: string;
	/** Optional sub-programs used to execute this instruction - this is here for tracing purposes */
	programs?: Scheduler[];
};

/** * Trace event for instruction execution. */
export interface InstructionTraceEvent {
	instructionIndex: number;
	note?: string;
	type: 'input' | 'output' | 'error';
	timestamp: number;
	args?: RuntimeValue[];
	result?: OutputValue;
	error?: string;
}

/** * Interface for tracing instruction execution. */
export interface InstructionTracer {
	/** Called before an instruction executes */
	traceInput(instructionIndex: number, instruction: Instruction, args: RuntimeValue[]): void;
	/** Called after an instruction executes */
	traceOutput(instructionIndex: number, instruction: Instruction, result: OutputValue): void;
	/** Called when an instruction throws an error */
	traceError(instructionIndex: number, instruction: Instruction, error: Error): void;
	/** Gets collected trace events (if supported by the tracer) */
	getTraceEvents?(): InstructionTraceEvent[];
}

/** * Tracer that collects execution events for later analysis. */
export class CollectingInstructionTracer implements InstructionTracer {
	private events: InstructionTraceEvent[] = [];

	traceInput(instructionIndex: number, instruction: Instruction, args: RuntimeValue[]): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'input',
			timestamp: Date.now(),
			args: this.cloneArgs(args)
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

	getTraceEvents(): InstructionTraceEvent[] {
		return [...this.events];
	}

	clear(): void {
		this.events = [];
	}

	private cloneArgs(args: RuntimeValue[]): RuntimeValue[] {
		return args.map(arg => this.cloneValue(arg));
	}

	private cloneResult(result: OutputValue): OutputValue {
		return this.cloneValue(result);
	}

	private cloneValue(value: any): any {
		if (value === null || value === undefined) return value;
		if (typeof value === 'object' && Symbol.asyncIterator in value) return '[AsyncIterable]';
		if (Array.isArray(value)) return value.map(v => this.cloneValue(v));
		if (typeof value === 'object') return '[Object]';
		return value;
	}
}
