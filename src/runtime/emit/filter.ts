import type { FilterNode } from '../../planner/nodes/filter.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { ScalarPlanNode } from '../../planner/nodes/plan-node.js';
import { PlanNodeType } from '../../planner/nodes/plan-node-type.js';
import type { LiteralNode, BinaryOpNode } from '../../planner/nodes/scalar.js';
import type { ColumnReferenceNode, ParameterReferenceNode } from '../../planner/nodes/reference.js';
import { emitParameterReference } from './parameter.js';
import { emitBinaryOp } from './binary.js';

export function emitFilter(plan: FilterNode): Instruction {
	const sourceInstruction = emitPlanNode(plan.source);

	async function* run(ctx: RuntimeContext, sourceRows: AsyncIterable<Row>): AsyncIterable<Row> {
		for await (const sourceRow of sourceRows) {
			// Set up context for this row - the source relation should be available for column references
			ctx.context.set(plan.source, () => sourceRow);

			try {
				// Evaluate the predicate expression in the context of this row
				const predicateResult = await evaluateScalarExpression(plan.predicate, ctx);

				// Only yield the row if the predicate is truthy
				if (isTruthy(predicateResult)) {
					yield sourceRow;
				}
			} finally {
				// Clean up context for this row
				ctx.context.delete(plan.source);
			}
		}
	}

	return { params: [sourceInstruction], run: run as any };
}

/**
 * Evaluates a scalar expression in the current runtime context.
 * This handles row-dependent expressions by recursively evaluating based on node type.
 */
async function evaluateScalarExpression(node: ScalarPlanNode, ctx: RuntimeContext): Promise<SqlValue> {
	switch (node.nodeType) {
		case PlanNodeType.Literal:
			return (node as LiteralNode).expression.value;

		case PlanNodeType.ColumnReference:
			const colRef = node as ColumnReferenceNode;
			const rowGetter = ctx.context.get(colRef.relationalNode);
			if (!rowGetter) {
				throw new QuereusError(
					`No row context found for column ${colRef.expression.name}`,
					StatusCode.INTERNAL
				);
			}
			const row = rowGetter();
			if (!Array.isArray(row)) {
				throw new QuereusError(
					`Expected row array for column ${colRef.expression.name}, got ${typeof row}`,
					StatusCode.INTERNAL
				);
			}
			return row[colRef.columnIndex] ?? null;

		case PlanNodeType.ParameterReference:
			const paramRef = node as ParameterReferenceNode;
			const paramInstruction = emitParameterReference(paramRef);
			const paramResult = paramInstruction.run(ctx);
			// Handle the case where run() might return a Promise or other types
			if (typeof paramResult === 'object' && paramResult !== null && 'then' in paramResult) {
				return await paramResult;
			}
			return paramResult as SqlValue;

		case PlanNodeType.BinaryOp:
			const binOp = node as BinaryOpNode;
			const left = await evaluateScalarExpression(binOp.left, ctx);
			const right = await evaluateScalarExpression(binOp.right, ctx);
			const binInstruction = emitBinaryOp(binOp);
			const binResult = binInstruction.run(ctx, left, right);
			// Handle the case where run() might return a Promise or other types
			if (typeof binResult === 'object' && binResult !== null && 'then' in binResult) {
				return await binResult;
			}
			return binResult as SqlValue;

		default:
			throw new QuereusError(
				`Unsupported scalar expression type in filter: ${node.nodeType}`,
				StatusCode.UNSUPPORTED
			);
	}
}

/**
 * Determines if a SqlValue is truthy for filter purposes.
 * In SQL semantics:
 * - NULL is falsy
 * - 0 (number) is falsy
 * - Empty string is falsy
 * - false (boolean) is falsy
 * - Everything else is truthy
 */
function isTruthy(value: SqlValue): boolean {
	return (typeof value === 'string') ? value.length > 0 : !!value;
}
