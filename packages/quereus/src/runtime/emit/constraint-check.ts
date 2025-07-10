import type { ConstraintCheckNode } from '../../planner/nodes/constraint-check-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import { RowOpFlag } from '../../schema/table.js';
import { withAsyncRowContext } from '../context-helpers.js';

export function emitConstraintCheck(plan: ConstraintCheckNode, ctx: EmissionContext): Instruction {
	// Get the table schema to access constraints
	const tableSchema = plan.table.tableSchema;

	// Use the pre-built flat row descriptor from the plan
	const flatRowDescriptor = plan.flatRowDescriptor;

	// Emit evaluator instructions for each pre-built constraint expression
	const checkEvaluators = plan.constraintChecks.map(check =>
		emitCallFromPlan(check.expression, ctx)
	);

	// Extract just the constraint metadata for the runtime checker
	const constraintMetadata = plan.constraintChecks.map(c => c.constraint);

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
		run: run as any,
		note: `constraintCheck(${plan.operation}, ${plan.constraintChecks.length} checks)`
	};
}

async function checkConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: TableSchema,
	row: Row,
	constraintMetadata: Array<RowConstraintSchema>,
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>
): Promise<void> {
	// Check PRIMARY KEY constraints (UNIQUE constraints on PK columns)
	await checkPrimaryKeyConstraints(rctx, plan, tableSchema, row);

	// Check NOT NULL constraints on individual columns
	await checkNotNullConstraints(rctx, plan, tableSchema, row);

	// Check CHECK constraints (both column-level and table-level)
	await checkCheckConstraints(rctx, plan, tableSchema, constraintMetadata, evaluatorFunctions);
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
	constraintMetadata: Array<RowConstraintSchema>,
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>
): Promise<void> {
	// Evaluate each CHECK constraint using pre-built evaluators
	for (let i = 0; i < constraintMetadata.length; i++) {
		const constraint = constraintMetadata[i];
		const evaluator = evaluatorFunctions[i];

		try {
			// Use the evaluator function to get the constraint result
			const result = evaluator(rctx) as SqlValue;

			// CHECK constraint passes if result is truthy or NULL
			// It fails only if result is false or 0 (SQLite-style numeric boolean)
			if (result === false || result === 0) {
				// Generate a proper constraint name if none was provided
				const constraintName = constraint.name || generateDefaultConstraintName(tableSchema, constraint);
				throw new QuereusError(
					`CHECK constraint failed: ${constraintName}`,
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
