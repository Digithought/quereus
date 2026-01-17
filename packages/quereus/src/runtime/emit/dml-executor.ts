import type { DmlExecutorNode } from '../../planner/nodes/dml-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun, OutputValue } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { getVTable, disconnectVTable } from '../utils.js';
import { ConflictResolution } from '../../common/constants.js';
import type { EmissionContext } from '../emission-context.js';
import { extractOldRowFromFlat, extractNewRowFromFlat } from '../../util/row-descriptor.js';
import { buildInsertStatement, buildUpdateStatement, buildDeleteStatement } from '../../util/mutation-statement.js';
import type { UpdateArgs, VirtualTable } from '../../vtab/table.js';
import type { TableSchema } from '../../schema/table.js';
import { hasNativeEventSupport } from '../../util/event-support.js';
import { sqlValuesEqual } from '../../util/comparison.js';

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

	// --- Operation-specific run generators ------------------------------------

	// INSERT ----------------------------------------------------
	async function* runInsert(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
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

				await vtab.update!(args);

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

				await vtab.update!(args);

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

				await vtab.update!(args);

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
		params: [sourceInstruction, ...contextEvaluatorInstructions],
		run,
		note: `execute${plan.operation}(${plan.table.tableSchema.name})`
	};
}
