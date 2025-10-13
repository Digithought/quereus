import type { ConstraintCheckNode } from '../../planner/nodes/constraint-check-node.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { RowOpFlag } from '../../schema/table.js';
import { withAsyncRowContext } from '../context-helpers.js';

interface ConstraintMetadataEntry {
	schema: RowConstraintSchema;
	flatRowDescriptor: RowDescriptor;
	evaluator: (ctx: RuntimeContext) => OutputValue;
	constraintName: string;
	shouldDefer: boolean;
	baseTable: string;
}

export function emitConstraintCheck(plan: ConstraintCheckNode, ctx: EmissionContext): Instruction {
	// Get the table schema to access constraints
	const tableSchema = plan.table.tableSchema;

	// Use the pre-built flat row descriptor from the plan
	const flatRowDescriptor = plan.flatRowDescriptor;

	// Emit evaluator instructions for each pre-built constraint expression
	const checkEvaluators = plan.constraintChecks.map(check =>
		emitCallFromPlan(check.expression, ctx)
	);

	const constraintMetadata = plan.constraintChecks.map((check, idx) => {
		const evaluatorInstruction = checkEvaluators[idx];
		const constraintName = check.constraint.name ?? generateDefaultConstraintName(tableSchema, check.constraint);
		return {
			schema: check.constraint,
			flatRowDescriptor: plan.flatRowDescriptor,
			evaluator: evaluatorInstruction.run,
			constraintName,
			shouldDefer: Boolean(check.deferrable || check.initiallyDeferred || check.containsSubquery),
			baseTable: `${tableSchema.schemaName}.${tableSchema.name}`
		};
	});

	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>, ...evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		if (!inputRows) {
			return;
		}

		for await (const inputRow of inputRows) {
			const flatRow = inputRow;

	const result = await withAsyncRowContext(rctx, flatRowDescriptor, () => flatRow, async () => {
		// Check all constraints that apply to this operation
		await checkConstraints(rctx, plan, tableSchema, flatRow, constraintMetadata, evaluatorFunctions);

				// If all constraints pass, yield the flat row for downstream processing
				// All downstream operations (INSERT executor, DELETE executor, RETURNING) expect flat rows
				return flatRow;
			});

			yield result;
		}
	}

	// Emit the source instruction
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...checkEvaluators],
		run: run as InstructionRun,
		note: `constraintCheck(${plan.operation}, ${plan.constraintChecks.length} checks)`
	};
}

async function checkConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: TableSchema,
	row: Row,
	constraintMetadata: ConstraintMetadataEntry[],
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>
): Promise<void> {
	// Check PRIMARY KEY constraints (UNIQUE constraints on PK columns)
	await checkPrimaryKeyConstraints(rctx, plan, tableSchema, row);

	// Check NOT NULL constraints on individual columns
	await checkNotNullConstraints(rctx, plan, tableSchema, row);

	// Check CHECK constraints (both column-level and table-level)
	await checkCheckConstraints(rctx, plan, tableSchema, row, constraintMetadata, evaluatorFunctions);
}

async function checkNotNullConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: TableSchema,
	flatRow: Row
): Promise<void> {
	// For INSERT operations, check NOT NULL on NEW values
	// For UPDATE operations, check NOT NULL on NEW values
	// DELETE operations don't need NOT NULL checks
	if (plan.operation === RowOpFlag.DELETE) {
		return;
	}

	// Check each column for NOT NULL constraint using NEW values
	if (plan.newRowDescriptor) {
		for (let i = 0; i < tableSchema.columns.length; i++) {
			const column = tableSchema.columns[i];
			if (column.notNull) {
				// Find the NEW value for this column in the flat row
				const newValueIndex = tableSchema.columns.length + i; // NEW section: n..2n-1
				const value = flatRow[newValueIndex];

				if (value === null || value === undefined) {
					throw new QuereusError(
						`NOT NULL constraint failed: ${tableSchema.name}.${column.name}`,
						StatusCode.CONSTRAINT
					);
				}
			}
		}
	}
}

async function checkPrimaryKeyConstraints(
	_rctx: RuntimeContext,
	_plan: ConstraintCheckNode,
	_tableSchema: TableSchema,
	_row: Row
): Promise<void> {
	// Primary Key constraints are enforced at the VTable level for now
	// This is simpler and more efficient than trying to implement it at the engine level
	// since the VTable has direct access to the current table state
	return;
}

async function checkCheckConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: TableSchema,
	row: Row,
	constraintMetadata: ConstraintMetadataEntry[],
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>
): Promise<void> {
	// Evaluate each CHECK constraint using pre-built evaluators
	for (let i = 0; i < constraintMetadata.length; i++) {
		const metadata = constraintMetadata[i];
		const evaluator = evaluatorFunctions[i] ?? metadata.evaluator;

		if (metadata.shouldDefer) {
			const activeConnectionId = rctx.activeConnection?.connectionId;
			rctx.db._queueDeferredConstraintRow(
				metadata.baseTable,
				metadata.constraintName,
				row.slice() as Row,
				metadata.flatRowDescriptor,
				evaluator,
				activeConnectionId
			);
			continue;
		}

		try {
			const result = await evaluator(rctx) as SqlValue;

			// CHECK constraint passes if result is truthy or NULL
			// It fails only if result is false or 0 (SQLite-style numeric boolean)
			if (result === false || result === 0) {
				throw new QuereusError(
					`CHECK constraint failed: ${metadata.constraintName}`,
					StatusCode.CONSTRAINT
				);
			}
		} catch (error) {
			if (error instanceof QuereusError && error.message.includes('CHECK constraint failed')) {
				throw error;
			}
			throw error;
		}
	}
}

function generateDefaultConstraintName(tableSchema: TableSchema, constraint: RowConstraintSchema): string {
	// Find the index of this constraint in the original array to get the correct constraint number
	const originalIndex = tableSchema.checkConstraints.findIndex((c: RowConstraintSchema) => c === constraint);
	return `_check_${originalIndex >= 0 ? originalIndex : 'unknown'}`;
}
