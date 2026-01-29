import type { DmlExecutorNode, UpsertClausePlan } from '../../planner/nodes/dml-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun, OutputValue } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError, ConstraintError } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue, isConstraintViolation } from '../../common/types.js';
import { getVTable, disconnectVTable } from '../utils.js';
import { ConflictResolution } from '../../common/constants.js';
import type { EmissionContext } from '../emission-context.js';
import { extractOldRowFromFlat, extractNewRowFromFlat } from '../../util/row-descriptor.js';
import { buildInsertStatement, buildUpdateStatement, buildDeleteStatement } from '../../util/mutation-statement.js';
import type { UpdateArgs, VirtualTable } from '../../vtab/table.js';
import type { TableSchema } from '../../schema/table.js';
import { hasNativeEventSupport } from '../../util/event-support.js';
import { sqlValuesEqual } from '../../util/comparison.js';
import { withAsyncRowContext } from '../context-helpers.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';

/**
 * Runtime UPSERT clause with pre-resolved evaluator callbacks.
 * The callbacks are resolved by the scheduler from the params array.
 */
interface RuntimeUpsertClause {
	conflictTargetIndices?: number[];
	action: 'nothing' | 'update';
	/** Indices into the evaluators array for each assignment (column index -> evaluator index) */
	assignmentIndices?: Map<number, number>;
	/** Index into the evaluators array for WHERE condition, or -1 if no WHERE */
	whereIndex: number;
	/** Row descriptor for NEW references */
	newRowDescriptor?: RowDescriptor;
	/** Row descriptor for existing row references */
	existingRowDescriptor?: RowDescriptor;
}

/**
 * Emit an automatic data change event for modules without native event support.
 */
function emitAutoDataEvent(
	ctx: RuntimeContext,
	tableSchema: TableSchema,
	type: 'insert' | 'update' | 'delete',
	key: SqlValue[],
	oldRow?: Row,
	newRow?: Row,
	changedColumns?: string[]
): void {
	ctx.db._getEventEmitter().emitAutoDataEvent(
		tableSchema.vtabModuleName ?? 'memory',
		{
			type,
			schemaName: tableSchema.schemaName,
			tableName: tableSchema.name,
			key,
			oldRow,
			newRow,
			changedColumns,
			remote: false, // Auto-emitted events are always local
		}
	);
}

export function emitDmlExecutor(plan: DmlExecutorNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Pre-calculate primary key column indices from schema (needed for update/delete)
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	// Emit mutation context evaluators if present
	const contextEvaluatorInstructions: Instruction[] = [];
	if (plan.mutationContextValues && plan.contextAttributes) {
		for (const attr of plan.contextAttributes) {
			const valueNode = plan.mutationContextValues.get(attr.name);
			if (!valueNode) {
				throw new QuereusError(`Missing mutation context value for '${attr.name}'`, StatusCode.INTERNAL);
			}
			const instruction = emitCallFromPlan(valueNode, ctx);
			contextEvaluatorInstructions.push(instruction);
		}
	}

	// Build UPSERT clause metadata and emit evaluator instructions
	// All evaluators are collected into a single array that gets passed as params
	const upsertEvaluatorInstructions: Instruction[] = [];
	let runtimeUpsertClauses: RuntimeUpsertClause[] | undefined;

	if (plan.upsertClauses && plan.upsertClauses.length > 0) {
		runtimeUpsertClauses = plan.upsertClauses.map(clause => {
			const runtime: RuntimeUpsertClause = {
				conflictTargetIndices: clause.conflictTargetIndices,
				action: clause.action,
				whereIndex: -1,
				newRowDescriptor: clause.newRowDescriptor,
				existingRowDescriptor: clause.existingRowDescriptor,
			};

			if (clause.action === 'update' && clause.assignments) {
				runtime.assignmentIndices = new Map();
				for (const [colIndex, valueNode] of clause.assignments) {
					const evaluatorIndex = upsertEvaluatorInstructions.length;
					const instruction = emitCallFromPlan(valueNode, ctx);
					upsertEvaluatorInstructions.push(instruction);
					runtime.assignmentIndices.set(colIndex, evaluatorIndex);
				}
			}

			if (clause.whereCondition) {
				runtime.whereIndex = upsertEvaluatorInstructions.length;
				const whereInstruction = emitCallFromPlan(clause.whereCondition, ctx);
				upsertEvaluatorInstructions.push(whereInstruction);
			}

			return runtime;
		});
	}

	// --- Operation-specific run generators ------------------------------------

	/**
	 * Match an UPSERT clause against a unique constraint violation.
	 * Returns the matching clause if found, undefined otherwise.
	 */
	function matchUpsertClause(
		existingRow: Row,
		proposedRow: Row,
		clauses: RuntimeUpsertClause[]
	): RuntimeUpsertClause | undefined {
		for (const clause of clauses) {
			if (!clause.conflictTargetIndices) {
				// No conflict target specified - matches any unique constraint
				return clause;
			}

			// Check if the conflict target columns match the PK columns
			// For now, we match if the conflict target is the PK or a subset
			// A more complete implementation would track which specific constraint was violated
			const isPkMatch = clause.conflictTargetIndices.length === pkColumnIndicesInSchema.length &&
				clause.conflictTargetIndices.every((idx, i) => idx === pkColumnIndicesInSchema[i]);

			if (isPkMatch) {
				return clause;
			}

			// Check if proposed values at conflict target indices match existing row
			// (this handles the case where the conflict is on those specific columns)
			const conflictMatch = clause.conflictTargetIndices.every(idx =>
				sqlValuesEqual(existingRow[idx], proposedRow[idx])
			);

			if (conflictMatch) {
				return clause;
			}
		}
		return undefined;
	}

	// Type for UPSERT evaluator callback (resolved by scheduler)
	type UpsertEvaluator = (ctx: RuntimeContext) => OutputValue;

	/**
	 * Execute the DO UPDATE path for an UPSERT clause.
	 * Returns the updated row or undefined if WHERE condition fails.
	 */
	async function executeUpsertUpdate(
		rctx: RuntimeContext,
		vtab: VirtualTable,
		clause: RuntimeUpsertClause,
		existingRow: Row,
		proposedRow: Row,
		contextRow: Row | undefined,
		upsertEvaluators: UpsertEvaluator[]
	): Promise<{ updatedRow: Row; flatRow: Row } | undefined> {
		// Check WHERE condition if present
		if (clause.whereIndex >= 0 && clause.newRowDescriptor && clause.existingRowDescriptor) {
			const whereEvaluator = upsertEvaluators[clause.whereIndex];
			// Evaluate WHERE with both NEW (proposed) and existing row contexts
			const whereResult = await withAsyncRowContext(rctx, clause.existingRowDescriptor, () => existingRow, async () => {
				return await withAsyncRowContext(rctx, clause.newRowDescriptor!, () => proposedRow, async () => {
					return await whereEvaluator(rctx);
				});
			});

			// If WHERE evaluates to false/null, skip this row (DO NOTHING equivalent)
			if (!whereResult) {
				return undefined;
			}
		}

		// Build the updated row by starting with existing row and applying assignments
		const updatedRow = [...existingRow] as Row;

		if (clause.assignmentIndices && clause.newRowDescriptor && clause.existingRowDescriptor) {
			// Evaluate assignment expressions with proper contexts
			for (const [colIndex, evaluatorIndex] of clause.assignmentIndices) {
				const evaluator = upsertEvaluators[evaluatorIndex];
				const value = await withAsyncRowContext(rctx, clause.existingRowDescriptor, () => existingRow, async () => {
					return await withAsyncRowContext(rctx, clause.newRowDescriptor!, () => proposedRow, async () => {
						return await evaluator(rctx);
					});
				}) as SqlValue;
				updatedRow[colIndex] = value;
			}
		}

		// Extract the primary key from existing row
		const keyValues = pkColumnIndicesInSchema.map(idx => existingRow[idx]);

		// Perform the UPDATE operation
		const updateArgs: UpdateArgs = {
			operation: 'update',
			values: updatedRow,
			oldKeyValues: keyValues,
			onConflict: ConflictResolution.ABORT,
			mutationStatement: vtab.wantStatements ?
				buildUpdateStatement(tableSchema, updatedRow, keyValues, contextRow) : undefined
		};

		const updateResult = await vtab.update!(updateArgs);

		if (isConstraintViolation(updateResult)) {
			throw new ConstraintError(
				updateResult.message ?? `${updateResult.constraint} constraint failed during UPSERT update`,
				StatusCode.CONSTRAINT
			);
		}

		if (!updateResult.row) {
			return undefined;
		}

		// Build a flat row for RETURNING (OLD = existing, NEW = updated)
		const flatRow: Row = [...existingRow, ...updatedRow];

		return { updatedRow, flatRow };
	}

	// INSERT ----------------------------------------------------
	// Number of context evaluators (used to split params in runInsert)
	const numContextEvaluators = contextEvaluatorInstructions.length;
	const numUpsertEvaluators = upsertEvaluatorInstructions.length;

	async function* runInsert(
		ctx: RuntimeContext,
		rows: AsyncIterable<Row>,
		...allEvaluators: Array<(ctx: RuntimeContext) => OutputValue>
	): AsyncIterable<Row> {
		// Split evaluators: first numContextEvaluators are context, rest are upsert
		const contextEvaluators = allEvaluators.slice(0, numContextEvaluators);
		const upsertEvaluators = allEvaluators.slice(numContextEvaluators) as UpsertEvaluator[];

		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db.hasDataListeners() && !hasNativeEventSupport(vtab);

		// Evaluate mutation context once per statement
		let contextRow: Row | undefined;
		if (contextEvaluators.length > 0) {
			contextRow = [];
			for (const evaluator of contextEvaluators) {
				const value = await evaluator(ctx) as SqlValue;
				contextRow.push(value);
			}
		}

		try {
			for await (const flatRow of rows) {
				const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);

				// Build mutation statement if logging is enabled
				let mutationStatement: string | undefined;
				if (vtab.wantStatements) {
					mutationStatement = buildInsertStatement(tableSchema, newRow, contextRow);
				}

				const args: UpdateArgs = {
					operation: 'insert',
					values: newRow,
					oldKeyValues: undefined,
					onConflict: plan.onConflict ?? ConflictResolution.ABORT,
					mutationStatement
				};

				const result = await vtab.update!(args);

				// Handle constraint violations
				if (isConstraintViolation(result)) {
					// Check for UPSERT clause handling
					if (result.constraint === 'unique' && runtimeUpsertClauses && result.existingRow) {
						const matchingClause = matchUpsertClause(result.existingRow, newRow, runtimeUpsertClauses);

						if (matchingClause) {
							if (matchingClause.action === 'nothing') {
								// DO NOTHING - skip this row silently
								continue;
							}

							// DO UPDATE - execute the update path
							const updateResult = await executeUpsertUpdate(
								ctx,
								vtab,
								matchingClause,
								result.existingRow,
								newRow,
								contextRow,
								upsertEvaluators
							);

							if (updateResult) {
								// Track change as UPDATE
								const existingKeyValues = pkColumnIndicesInSchema.map(idx => result.existingRow![idx]);
								const newKeyValues = pkColumnIndicesInSchema.map(idx => updateResult.updatedRow[idx]);
								ctx.db._recordUpdate(
									`${tableSchema.schemaName}.${tableSchema.name}`,
									existingKeyValues,
									newKeyValues
								);

								// Emit auto event for modules without native event support
								if (needsAutoEvents) {
									const changedColumns: string[] = [];
									for (let i = 0; i < tableSchema.columns.length; i++) {
										if (!sqlValuesEqual(result.existingRow![i], updateResult.updatedRow[i])) {
											changedColumns.push(tableSchema.columns[i].name);
										}
									}
									emitAutoDataEvent(
										ctx,
										tableSchema,
										'update',
										existingKeyValues,
										[...result.existingRow!],
										[...updateResult.updatedRow],
										changedColumns
									);
								}

								yield updateResult.flatRow;
							}
							continue;
						}
					}

					// No UPSERT clause matched or not a unique constraint - propagate as error
					throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
				}

				// Skip if row was not inserted (e.g., IGNORE mode returned ok with no row)
				if (!result.row) {
					continue;
				}

				// Track change (INSERT): record NEW primary key
				const pkValues = tableSchema.primaryKeyDefinition.map(def => newRow[def.index]);
				ctx.db._recordInsert(`${tableSchema.schemaName}.${tableSchema.name}`, pkValues);

				// Emit auto event for modules without native event support
				if (needsAutoEvents) {
					emitAutoDataEvent(ctx, tableSchema, 'insert', pkValues, undefined, [...newRow]);
				}

				yield flatRow; // make OLD/NEW available downstream (e.g. RETURNING)
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// UPDATE ----------------------------------------------------
	async function* runUpdate(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db.hasDataListeners() && !hasNativeEventSupport(vtab);

		// Evaluate mutation context once per statement
		let contextRow: Row | undefined;
		if (contextEvaluators.length > 0) {
			contextRow = [];
			for (const evaluator of contextEvaluators) {
				const value = await evaluator(ctx) as SqlValue;
				contextRow.push(value);
			}
		}

		try {
			for await (const flatRow of rows) {
				const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);
				const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);

				// Extract primary key values from the OLD row (these identify which row to update)
				const keyValues: SqlValue[] = pkColumnIndicesInSchema.map(pkColIdx => {
					if (pkColIdx >= oldRow.length) {
						throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
					}
					return oldRow[pkColIdx];
				});

				// Build mutation statement if logging is enabled
				let mutationStatement: string | undefined;
				if (vtab.wantStatements) {
					mutationStatement = buildUpdateStatement(tableSchema, newRow, keyValues, contextRow);
				}

				const args: UpdateArgs = {
					operation: 'update',
					values: newRow,
					oldKeyValues: keyValues,
					onConflict: ConflictResolution.ABORT,
					mutationStatement
				};

				const result = await vtab.update!(args);

				// Handle constraint violations
				if (isConstraintViolation(result)) {
					throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
				}

				// Skip if row was not updated (row not found returns ok with no row)
				if (!result.row) {
					continue;
				}

				// Track change (UPDATE): record OLD and NEW primary keys
				const newKeyValues: SqlValue[] = tableSchema.primaryKeyDefinition.map(pkColDef => newRow[pkColDef.index]);
				ctx.db._recordUpdate(`${tableSchema.schemaName}.${tableSchema.name}`, keyValues, newKeyValues);

				// Emit auto event for modules without native event support
				if (needsAutoEvents) {
					// Compute changed columns
					const changedColumns: string[] = [];
					for (let i = 0; i < tableSchema.columns.length; i++) {
						const oldVal = oldRow[i];
						const newVal = newRow[i];
						if (!sqlValuesEqual(oldVal, newVal)) {
							changedColumns.push(tableSchema.columns[i].name);
						}
					}
					emitAutoDataEvent(ctx, tableSchema, 'update', keyValues, [...oldRow], [...newRow], changedColumns);
				}

				yield flatRow;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// DELETE ----------------------------------------------------
	async function* runDelete(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db.hasDataListeners() && !hasNativeEventSupport(vtab);

		// Evaluate mutation context once per statement
		let contextRow: Row | undefined;
		if (contextEvaluators.length > 0) {
			contextRow = [];
			for (const evaluator of contextEvaluators) {
				const value = await evaluator(ctx) as SqlValue;
				contextRow.push(value);
			}
		}

		try {
			for await (const flatRow of rows) {
				const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);

				const keyValues: SqlValue[] = pkColumnIndicesInSchema.map(pkColIdx => {
					if (pkColIdx >= oldRow.length) {
						throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in DELETE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
					}
					return oldRow[pkColIdx];
				});

				// Build mutation statement if logging is enabled
				let mutationStatement: string | undefined;
				if (vtab.wantStatements) {
					mutationStatement = buildDeleteStatement(tableSchema, keyValues, contextRow);
				}

				const args: UpdateArgs = {
					operation: 'delete',
					values: undefined,
					oldKeyValues: keyValues,
					onConflict: ConflictResolution.ABORT,
					mutationStatement
				};

				const result = await vtab.update!(args);

				// Handle constraint violations (unlikely for DELETE, but be consistent)
				if (isConstraintViolation(result)) {
					throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
				}

				// Skip if row was not deleted (row not found returns ok with no row)
				if (!result.row) {
					continue;
				}

				// Track change (DELETE): record OLD primary key
				ctx.db._recordDelete(`${tableSchema.schemaName}.${tableSchema.name}`, keyValues);

				// Emit auto event for modules without native event support
				if (needsAutoEvents) {
					emitAutoDataEvent(ctx, tableSchema, 'delete', keyValues, [...oldRow]);
				}

				yield flatRow;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// Select the correct generator based on operation
	let run: InstructionRun;
	switch (plan.operation) {
		case 'insert': run = runInsert as InstructionRun; break;
		case 'update': run = runUpdate as InstructionRun; break;
		case 'delete': run = runDelete as InstructionRun; break;
		default:
			throw new QuereusError(`Unknown DML operation: ${plan.operation}`, StatusCode.INTERNAL);
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...contextEvaluatorInstructions, ...upsertEvaluatorInstructions],
		run,
		note: `execute${plan.operation}(${plan.table.tableSchema.name})`
	};
}
