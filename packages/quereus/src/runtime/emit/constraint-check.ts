import type { ConstraintCheckNode } from '../../planner/nodes/constraint-check-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import type { RowConstraintSchema } from '../../schema/table.js';
import { RowOp } from '../../schema/table.js';
import { buildExpression } from '../../planner/building/expression.js';
import { GlobalScope } from '../../planner/scopes/global.js';
import { RegisteredScope } from '../../planner/scopes/registered.js';
import { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import { PlanNode } from '../../planner/nodes/plan-node.js';
import * as AST from '../../parser/ast.js';

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
	// ------------------------------------------------------------------
	// NEW/OLD ATTRIBUTE ID DISCOVERY
	// The planning phase already created attribute IDs for NEW/OLD references
	// and populated the row descriptors. We need to discover these mappings
	// so we can register the correct symbols during constraint building.
	// ------------------------------------------------------------------
	const newAttrIdByCol: Record<string, number> = {};
	const oldAttrIdByCol: Record<string, number> = {};

	// Discover existing NEW attribute mappings from the row descriptor
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

	// Discover existing OLD attribute mappings from the row descriptor
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

			// Register table columns in the scope so constraint expressions can reference them
			// We need to register the actual table column names, mapping them to the correct source attributes
			const sourceAttributes = plan.source.getAttributes();
			const sourceType = plan.source.getType();

			// Map table columns to source columns by matching names
			tableSchema.columns.forEach((tableColumn: any, tableColIndex: number) => {
				// Find the corresponding source column by name
				let sourceColumnIndex = -1;
				let sourceAttr: any = null;

				for (let i = 0; i < sourceType.columns.length; i++) {
					if (sourceType.columns[i].name.toLowerCase() === tableColumn.name.toLowerCase()) {
						sourceColumnIndex = i;
						sourceAttr = sourceAttributes[i];
						break;
					}
				}

				if (sourceColumnIndex >= 0 && sourceAttr) {
					// Register the table column name so CHECK constraints can reference it
					scope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, {
							typeClass: 'scalar',
							affinity: tableColumn.affinity,
							nullable: !tableColumn.notNull,
							isReadOnly: false
						}, sourceAttr.id, sourceColumnIndex));

					// NEW.<col>
					if (plan.newRowDescriptor) {
						const newAttrId = newAttrIdByCol[tableColumn.name.toLowerCase()];
						if (newAttrId !== undefined) {
							scope.registerSymbol(`NEW.${tableColumn.name}`, (exp, s) =>
								new ColumnReferenceNode(s, exp as AST.ColumnExpr, {
									typeClass: 'scalar',
									affinity: tableColumn.affinity,
									nullable: !tableColumn.notNull,
									isReadOnly: false
								}, newAttrId, tableColIndex));
						}
					}

					// OLD.<col>
					if (plan.oldRowDescriptor) {
						const oldAttrId = oldAttrIdByCol[tableColumn.name.toLowerCase()];
						if (oldAttrId !== undefined) {
							scope.registerSymbol(`OLD.${tableColumn.name}`, (exp, s) =>
								new ColumnReferenceNode(s, exp as AST.ColumnExpr, {
									typeClass: 'scalar',
									affinity: tableColumn.affinity,
									nullable: !tableColumn.notNull,
									isReadOnly: false
								}, oldAttrId, tableColIndex));
						}
					}
				} else {
					console.warn(`Could not map table column ${tableColumn.name} to source column`);
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

		let rowCount = 0;
		for await (const row of inputRows) {
			rowCount++;
			// Clear any existing contexts to ensure constraint expressions resolve to the correct row
			rctx.context.clear();

			// Extract update metadata if this is an UPDATE operation
			const updateRowData = (row as any).__updateRowData;
			const isUpdateOperation = updateRowData?.isUpdateOperation;

			// Set up the primary source context to point to the appropriate row
			rctx.context.set(sourceRowDescriptor, () => row);

			try {
				// Set up OLD and NEW row contexts if available
				if (plan.operation === RowOp.UPDATE && isUpdateOperation) {
					if (plan.oldRowDescriptor && Object.keys(plan.oldRowDescriptor).length > 0) {
						rctx.context.set(plan.oldRowDescriptor, () => updateRowData.oldRow); // OLD values
					}
					if (plan.newRowDescriptor && Object.keys(plan.newRowDescriptor).length > 0) {
						rctx.context.set(plan.newRowDescriptor, () => updateRowData.newRow); // NEW values
					}
				} else if (plan.operation === RowOp.DELETE) {
					// For DELETE operations, the current row IS the OLD row
					if (plan.oldRowDescriptor && Object.keys(plan.oldRowDescriptor).length > 0) {
						rctx.context.set(plan.oldRowDescriptor, () => row); // OLD values are the current row being deleted
					}
				}

				try {
					// Check all constraints that apply to this operation
					await checkConstraints(rctx, plan, tableSchema, row, constraintMetadata, evaluatorFunctions);

					// If all constraints pass, yield the row
					if (isUpdateOperation) {
						// For UPDATE operations, we need to preserve the OLD row's primary key values
						// so UpdateExecutor can identify which row to update
						const cleanUpdatedRow = [...updateRowData.newRow];

						// Attach OLD row primary key information for UpdateExecutor
						Object.defineProperty(cleanUpdatedRow, '__oldRowKeyValues', {
							value: updateRowData.oldRow,
							enumerable: false,
							writable: false
						});

						yield cleanUpdatedRow;
					} else {
						yield row;
					}
				} finally {
					// Clean up OLD/NEW contexts
					if (plan.oldRowDescriptor && Object.keys(plan.oldRowDescriptor).length > 0) {
						rctx.context.delete(plan.oldRowDescriptor);
					}
					if (plan.newRowDescriptor && Object.keys(plan.newRowDescriptor).length > 0) {
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
		params: [sourceInstruction, ...checkEvaluators],
		run: run as any,
		note: `constraintCheck(${plan.operation})`
	};
}

async function checkConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: any,
	row: Row,
	constraintMetadata: Array<RowConstraintSchema>,
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>
): Promise<void> {
	// Check NOT NULL constraints on individual columns
	await checkNotNullConstraints(rctx, plan, tableSchema, row);

	// Check CHECK constraints (both column-level and table-level)
	await checkCheckConstraints(rctx, plan, tableSchema, constraintMetadata, evaluatorFunctions);
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
	tableSchema: any,
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

function generateDefaultConstraintName(tableSchema: any, constraint: RowConstraintSchema): string {
	// Find the index of this constraint in the original array to get the correct constraint number
	const originalIndex = tableSchema.checkConstraints.findIndex((c: RowConstraintSchema) => c === constraint);
	return `check_${originalIndex >= 0 ? originalIndex : 'unknown'}`;
}
