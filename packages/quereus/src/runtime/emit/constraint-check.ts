import type { ConstraintCheckNode } from '../../planner/nodes/constraint-check-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { RowOp } from '../../schema/table.js';
import { buildExpression } from '../../planner/building/expression.js';
import { GlobalScope } from '../../planner/scopes/global.js';
import { RegisteredScope } from '../../planner/scopes/registered.js';
import { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import * as AST from '../../parser/ast.js';

export function emitConstraintCheck(plan: ConstraintCheckNode, ctx: EmissionContext): Instruction {
	// Get the table schema to access constraints
	const tableSchema = plan.table.tableSchema;

	// Create flat row descriptor that includes both OLD and NEW attributes
	const flatRowDescriptor: RowDescriptor = [];

	// OLD attributes are at indices 0..n-1, NEW attributes at n..2n-1
	if (plan.oldRowDescriptor) {
		for (const attrIdStr in plan.oldRowDescriptor) {
			const attrId = parseInt(attrIdStr);
			const columnIndex = plan.oldRowDescriptor[attrId];
			if (columnIndex !== undefined) {
				flatRowDescriptor[attrId] = columnIndex; // OLD section: 0..n-1
			}
		}
	}

	if (plan.newRowDescriptor) {
		for (const attrIdStr in plan.newRowDescriptor) {
			const attrId = parseInt(attrIdStr);
			const columnIndex = plan.newRowDescriptor[attrId];
			if (columnIndex !== undefined) {
				flatRowDescriptor[attrId] = tableSchema.columns.length + columnIndex; // NEW section: n..2n-1
			}
		}
	}

	// Discover attribute mappings for constraint building
	const newAttrIdByCol: Record<string, number> = {};
	const oldAttrIdByCol: Record<string, number> = {};

	if (plan.newRowDescriptor) {
		for (const attrIdStr in plan.newRowDescriptor) {
			const attrId = parseInt(attrIdStr);
			const columnIndex = plan.newRowDescriptor[attrId];
			if (columnIndex !== undefined && columnIndex < tableSchema.columns.length) {
				const column = tableSchema.columns[columnIndex];
				newAttrIdByCol[column.name.toLowerCase()] = attrId;
			}
		}
	}

	if (plan.oldRowDescriptor) {
		for (const attrIdStr in plan.oldRowDescriptor) {
			const attrId = parseInt(attrIdStr);
			const columnIndex = plan.oldRowDescriptor[attrId];
			if (columnIndex !== undefined && columnIndex < tableSchema.columns.length) {
				const column = tableSchema.columns[columnIndex];
				oldAttrIdByCol[column.name.toLowerCase()] = attrId;
			}
		}
	}

	const checkConstraintData = tableSchema.checkConstraints
		.filter((constraint: RowConstraintSchema) => shouldCheckConstraint(constraint, plan.operation))
		.map((constraint: RowConstraintSchema) => {
			// Build a PlanNode from the AST expression
			// Create a scope that has access to the table columns for constraint evaluation
			const scope = new RegisteredScope(new GlobalScope(ctx.db.schemaManager));

			// Register table columns for constraint evaluation using flat row attributes
			tableSchema.columns.forEach((tableColumn: ColumnSchema, tableColIndex: number) => {
				const colNameLower = tableColumn.name.toLowerCase();

				// Register NEW.<col> (defaults to NEW for unqualified references)
				const newAttrId = newAttrIdByCol[colNameLower];
				if (newAttrId !== undefined) {
					// Unqualified column name (defaults to NEW)
					scope.registerSymbol(colNameLower, (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, {
							typeClass: 'scalar',
							affinity: tableColumn.affinity,
							nullable: !tableColumn.notNull,
							isReadOnly: false
						}, newAttrId, tableColIndex));

					// NEW.<col>
					scope.registerSymbol(`new.${colNameLower}`, (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, {
							typeClass: 'scalar',
							affinity: tableColumn.affinity,
							nullable: !tableColumn.notNull,
							isReadOnly: false
						}, newAttrId, tableColIndex));
				}

				// Register OLD.<col>
				const oldAttrId = oldAttrIdByCol[colNameLower];
				if (oldAttrId !== undefined) {
					scope.registerSymbol(`old.${colNameLower}`, (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, {
							typeClass: 'scalar',
							affinity: tableColumn.affinity,
							nullable: true, // OLD values can be NULL
							isReadOnly: false
						}, oldAttrId, tableColIndex));
				}
			});

			const exprPlanNode = buildExpression(
				{ scope, db: ctx.db, parameters: {}, schemaManager: ctx.db.schemaManager },
				constraint.expr
			);

			return {
				constraint,
				evaluator: emitCallFromPlan(exprPlanNode, ctx)
			};
		});

	// Extract just the constraint metadata and evaluator functions
	const constraintMetadata = checkConstraintData.map(item => item.constraint);
	const checkEvaluators = checkConstraintData.map(item => item.evaluator);

	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>, ...evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		if (!inputRows) {
			return;
		}

		for await (const inputRow of inputRows) {
			const flatRow = inputRow;

			// Set up single flat context
			rctx.context.set(flatRowDescriptor, () => flatRow);

			try {
				// Check all constraints that apply to this operation
				await checkConstraints(rctx, plan, tableSchema, flatRow, constraintMetadata, evaluatorFunctions);

				// If all constraints pass, yield the flat row for downstream processing
				// All downstream operations (INSERT executor, DELETE executor, RETURNING) expect flat rows
				yield flatRow;
			} finally {
				// Clean up flat context
				rctx.context.delete(flatRowDescriptor);
			}
		}
	}

	// Emit the source instruction
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...checkEvaluators],
		run: run as any,
		note: `constraintCheck(${plan.operation})`
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
	if (plan.operation === RowOp.DELETE) {
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
	// Evaluate each CHECK constraint
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
				// IMPORTANT: Use the original index from the full tableSchema.checkConstraints array
				// not the filtered index, to get the correct constraint name
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

function shouldCheckConstraint(constraint: RowConstraintSchema, operation: RowOp): boolean {
	// Check if the current operation is in the constraint's operations bitmask
	return (constraint.operations & operation) !== 0;
}

function generateDefaultConstraintName(tableSchema: TableSchema, constraint: RowConstraintSchema): string {
	// Find the index of this constraint in the original array to get the correct constraint number
	const originalIndex = tableSchema.checkConstraints.findIndex((c: RowConstraintSchema) => c === constraint);
	return `check_${originalIndex >= 0 ? originalIndex : 'unknown'}`;
}
