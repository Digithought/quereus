import type { ConstraintCheckNode } from '../../planner/nodes/constraint-check-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { RowConstraintSchema } from '../../schema/table.js';
import { RowOp } from '../../schema/table.js';
import { buildExpression } from '../../planner/building/expression.js';
import { GlobalScope } from '../../planner/scopes/global.js';

export function emitConstraintCheck(plan: ConstraintCheckNode, ctx: EmissionContext): Instruction {
	// Get the table schema to access constraints
	const tableSchema = plan.table.tableSchema;

	// Create row descriptors for the input rows
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	// Pre-emit CHECK constraint expressions for performance
	const checkInstructions = tableSchema.checkConstraints
		.filter((constraint: RowConstraintSchema) => shouldCheckConstraint(constraint, plan.operation))
		.map((constraint: RowConstraintSchema) => {
			// Build a PlanNode from the AST expression
			// For now, use a basic global scope - in the future we might need to set up
			// proper scoping for OLD/NEW references
			const scope = new GlobalScope(ctx.db.schemaManager);
			const exprPlanNode = buildExpression(
				{ scope, db: ctx.db, parameters: {}, schemaManager: ctx.db.schemaManager },
				constraint.expr
			);

			return {
				constraint,
				instruction: emitPlanNode(exprPlanNode, ctx)
			};
		});

	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): AsyncIterable<Row> {
		if (!inputRows) {
			return;
		}

		for await (const row of inputRows) {
			// Set up context for the current row
			rctx.context.set(sourceRowDescriptor, () => row);

			try {
				// Set up OLD row context if available
				if (plan.oldRowDescriptor) {
					rctx.context.set(plan.oldRowDescriptor, () => row);
				}

				// Set up NEW row context if available
				if (plan.newRowDescriptor) {
					rctx.context.set(plan.newRowDescriptor, () => row);
				}

				try {
					// Check all constraints that apply to this operation
					await checkConstraints(rctx, plan, tableSchema, row, checkInstructions);

					// If all constraints pass, yield the row
					yield row;
				} finally {
					// Clean up OLD/NEW contexts
					if (plan.oldRowDescriptor) {
						rctx.context.delete(plan.oldRowDescriptor);
					}
					if (plan.newRowDescriptor) {
						rctx.context.delete(plan.newRowDescriptor);
					}
				}
			} finally {
				// Clean up source context
				rctx.context.delete(sourceRowDescriptor);
			}
		}
	}

	// Emit the source instruction
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run,
		note: `constraintCheck(${plan.operation})`
	};
}

async function checkConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: any,
	row: Row,
	checkInstructions: Array<{ constraint: RowConstraintSchema, instruction: Instruction }>
): Promise<void> {
	// Check NOT NULL constraints on individual columns
	await checkNotNullConstraints(rctx, plan, tableSchema, row);

	// Check CHECK constraints (both column-level and table-level)
	await checkCheckConstraints(rctx, plan, checkInstructions);
}

async function checkNotNullConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: any,
	row: Row
): Promise<void> {
	// For INSERT operations, check NOT NULL on new values
	// For UPDATE operations, check NOT NULL on new values
	// DELETE operations don't need NOT NULL checks
	if (plan.operation === RowOp.DELETE) {
		return;
	}

	// Check each column for NOT NULL constraint
	for (let i = 0; i < tableSchema.columns.length; i++) {
		const column = tableSchema.columns[i];
		if (column.notNull) {
			// For INSERT/UPDATE, we check the row value directly since it's the NEW value
			const value = row[i];

			if (value === null || value === undefined) {
				throw new QuereusError(
					`NOT NULL constraint failed: ${tableSchema.name}.${column.name}`,
					StatusCode.CONSTRAINT
				);
			}
		}
	}
}

async function checkCheckConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	checkInstructions: Array<{ constraint: RowConstraintSchema, instruction: Instruction }>
): Promise<void> {
	// Evaluate each CHECK constraint
	for (const { constraint, instruction } of checkInstructions) {
		const result = await instruction.run(rctx);

		// CHECK constraint passes if result is truthy or NULL
		// It fails only if result is false (not just falsy)
		if (result === false) {
			// Generate a proper constraint name if none was provided
			const constraintName = constraint.name || generateDefaultConstraintName(plan.table.tableSchema, constraint);
			throw new QuereusError(
				`CHECK constraint failed: ${constraintName}`,
				StatusCode.CONSTRAINT
			);
		}
	}
}

function shouldCheckConstraint(constraint: RowConstraintSchema, operation: RowOp): boolean {
	// Check if the current operation is in the constraint's operations bitmask
	return (constraint.operations & operation) !== 0;
}

function generateDefaultConstraintName(tableSchema: any, constraint: RowConstraintSchema): string {
	// Generate names like 'check_0', 'check_1', etc.
	const checkIndex = tableSchema.checkConstraints.indexOf(constraint);
	return `check_${checkIndex >= 0 ? checkIndex : 'unknown'}`;
}
