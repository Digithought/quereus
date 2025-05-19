import type { Instruction, RuntimeContext } from "./types.js";
import type { OutputValue, RuntimeValue } from "../common/types.js";

type ResultDestination = number | null;

export class Scheduler {
	readonly instructions: Instruction[] = [];
	/** Index of the instruction that consumes the output of each instruction. */
	readonly destinations: ResultDestination[];

	constructor(root: Instruction) {
		const argIndexes: number[][] = [];

		const buildPlan = (inst: Instruction): number => {
			const instArgIndexes = inst.params.map(p => buildPlan(p));

			const currentIndex = this.instructions.push(inst) - 1;

			argIndexes[currentIndex] = instArgIndexes;

			return currentIndex;
		};

		buildPlan(root);

		this.destinations = new Array<ResultDestination>(this.instructions.length).fill(null);

		for (let instIndex = 0; instIndex < this.instructions.length; ++instIndex) {
			const instArgIndexes = argIndexes[instIndex];
			if (instArgIndexes) {
				for (let argIndex = 0; argIndex < instArgIndexes.length; ++argIndex) {
					this.destinations[instArgIndexes[argIndex]] = instIndex;
				}
			}
		}
	}

	async run(ctx: RuntimeContext): Promise<OutputValue[]> {
		// Argument lists for each instruction.
		const instrArgs = new Array(this.instructions.length).fill(null).map(() => [] as OutputValue[] | undefined);
		// Instruction indexes that have promise arguments
		const hasPromise: boolean[] = [];
		// Running output
		let output: OutputValue | undefined;

		for (let i = 0; i < this.instructions.length; ++i) {
			let args = instrArgs[i]!;
			if (hasPromise[i]) {
				args = await Promise.all(args);	// (Promise.all() can take non-promise values)
			}

			output = this.instructions[i].run(ctx, ...(args as RuntimeValue[]));

			// Clear args as we go to minimize memory usage.
			instrArgs[i] = undefined;

			// Store the output in the argument list for the target instruction.
			const destination = this.destinations[i];
			if (destination !== null) {
				instrArgs[destination]!.push(output);
				if (output instanceof Promise) {
					hasPromise[destination] = true;
				}
			}
		}

		return output as OutputValue[];
	}
}
