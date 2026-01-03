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
import { withAsyncRowContext, createRowSlot } from '../context-helpers.js';
import { expressionToString } from '../../emit/ast-stringify.js';

interface ConstraintMetadataEntry {
	schema: RowConstraintSchema;
	flatRowDescriptor: RowDescriptor;
	evaluator: (ctx: RuntimeContext) => OutputValue;
	constraintName: string;
	constraintExpr: string; // Stringified constraint expression
	shouldDefer: boolean;
	baseTable: string;
	contextRow?: Row; // Mutation context row if present
	contextDescriptor?: RowDescriptor; // Mutation context row descriptor
}

export function emitConstraintCheck(plan: ConstraintCheckNode, ctx: EmissionContext): Instruction {
	// Get the table schema to access constraints
	const tableSchema = plan.table.tableSchema;

	// Use the pre-built flat row descriptor from the plan
	const flatRowDescriptor = plan.flatRowDescriptor;

	// Get mutation context from the plan (passed from DML builders)
	const mutationContextValues = plan.mutationContextValues;
	const contextAttributes = plan.contextAttributes;
	const contextDescriptor = plan.contextDescriptor;

	// Emit mutation context value evaluators if present
	const contextEvaluatorInstructions: Instruction[] = [];
	if (mutationContextValues && contextAttributes) {
		for (const attr of contextAttributes) {
			const valueExpr = mutationContextValues.get(attr.name);
			if (valueExpr) {
				contextEvaluatorInstructions.push(emitCallFromPlan(valueExpr, ctx));
			}
		}
	}

	// Emit evaluator instructions for each pre-built constraint expression
	const checkEvaluators = plan.constraintChecks.map(check =>
		emitCallFromPlan(check.expression, ctx)
	);

	const constraintMetadata: ConstraintMetadataEntry[] = plan.constraintChecks.map((check, idx) => {
		const evaluatorInstruction = checkEvaluators[idx];
		const constraintName = check.constraint.name ?? generateDefaultConstraintName(tableSchema, check.constraint);
		const constraintExpr = expressionToString(check.constraint.expr);
		return {
			schema: check.constraint,
			flatRowDescriptor: plan.flatRowDescriptor,
			evaluator: evaluatorInstruction.run,
			constraintName,
			constraintExpr,
			shouldDefer: Boolean(check.deferrable || check.initiallyDeferred || check.containsSubquery),
			baseTable: `${tableSchema.schemaName}.${tableSchema.name}`,
			contextRow: undefined,
			contextDescriptor
		};
	});

	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>, ...evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		if (!inputRows) {
			return;
		}

		// Evaluate mutation context values once per statement (not per row)
		let contextRow: Row | undefined;
		let contextSlot: ReturnType<typeof createRowSlot> | undefined;

		if (contextEvaluatorInstructions.length > 0 && contextDescriptor) {
			// Split evaluatorFunctions into context evaluators and constraint evaluators
			const contextEvalFunctions = evaluatorFunctions.slice(0, contextEvaluatorInstructions.length);
			const constraintEvalFunctions = evaluatorFunctions.slice(contextEvaluatorInstructions.length);

			// Evaluate all context values
			contextRow = [];
			for (const contextEvaluator of contextEvalFunctions) {
				const value = await contextEvaluator(rctx) as SqlValue;
				contextRow.push(value);
			}

			// Store context row in metadata for deferred constraints
			constraintMetadata.forEach(meta => {
				meta.contextRow = contextRow;
			});

			// Create a row slot for the mutation context that persists for the whole statement
			contextSlot = createRowSlot(rctx, contextDescriptor);
			contextSlot.set(contextRow);

			// Use constraint evaluators for the rest of the function
			evaluatorFunctions = constraintEvalFunctions;
		}

		try {
			for await (const inputRow of inputRows) {
				const flatRow = inputRow;

				// If we have mutation context, compose it with the flat row for constraint evaluation
				const combinedRow = contextRow ? [...contextRow, ...flatRow] : flatRow;
				const combinedDescriptor = contextDescriptor && contextRow
					? composeCombinedDescriptor(contextDescriptor, flatRowDescriptor)
					: flatRowDescriptor;

				const result = await withAsyncRowContext(rctx, combinedDescriptor, () => combinedRow, async () => {
					// Check all constraints that apply to this operation
					await checkConstraints(rctx, plan, tableSchema, flatRow, constraintMetadata, evaluatorFunctions);

					// If all constraints pass, yield the flat row for downstream processing
					// All downstream operations (INSERT executor, DELETE executor, RETURNING) expect flat rows
					return flatRow;
				});

				yield result;
			}
		} finally {
			// Clean up context slot if we created one
			if (contextSlot) {
				contextSlot.close();
			}
		}
	}

	// Emit the source instruction
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...contextEvaluatorInstructions, ...checkEvaluators],
		run: run as InstructionRun,
		note: `constraintCheck(${plan.operation}, ${contextEvaluatorInstructions.length} ctx, ${plan.constraintChecks.length} checks)`
	};
}

/**
 * Composes a combined row descriptor that includes both context and flat (OLD/NEW) descriptors.
 * Context attributes come first, followed by OLD/NEW attributes with offset indices.
 */
function composeCombinedDescriptor(contextDescriptor: RowDescriptor, flatRowDescriptor: RowDescriptor): RowDescriptor {
	const combined: RowDescriptor = [];
	const contextLength = Object.keys(contextDescriptor).filter(k => contextDescriptor[parseInt(k)] !== undefined).length;

	// Copy context descriptor as-is (indices 0..contextLength-1)
	for (const attrIdStr in contextDescriptor) {
		const attrId = parseInt(attrIdStr);
		if (contextDescriptor[attrId] !== undefined) {
			combined[attrId] = contextDescriptor[attrId];
		}
	}

	// Copy flat descriptor with offset indices (indices contextLength..end)
	for (const attrIdStr in flatRowDescriptor) {
		const attrId = parseInt(attrIdStr);
		if (flatRowDescriptor[attrId] !== undefined) {
			combined[attrId] = flatRowDescriptor[attrId] + contextLength;
		}
	}

	return combined;
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
				activeConnectionId,
				metadata.contextRow,
				metadata.contextDescriptor
			);
			continue;
		}

		try {
			const result = await evaluator(rctx) as SqlValue;

			// CHECK constraint passes if result is truthy or NULL
			// It fails only if result is false or 0 (SQLite-style numeric boolean)
			if (result === false || result === 0) {
				// Include constraint expression in error message for better debugging
				const exprHint = metadata.constraintExpr.length <= 60
					? ` (${metadata.constraintExpr})`
					: '';
				throw new QuereusError(
					`CHECK constraint failed: ${metadata.constraintName}${exprHint}`,
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
