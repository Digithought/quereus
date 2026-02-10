/**
 * Runtime-based expression evaluator for constant folding
 *
 * This module provides evaluation of constant expressions using the existing runtime
 * through a mini-scheduler, avoiding the need for a separate expression interpreter.
 */

import type { MaybePromise, OutputValue } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import { emitPlanNode } from '../../runtime/emitters.js';
import { EmissionContext } from '../../runtime/emission-context.js';
import { Scheduler } from '../../runtime/scheduler.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { createLogger } from '../../common/logger.js';
import { PlanNode } from '../nodes/plan-node.js';

const log = createLogger('optimizer:folding:eval');

/**
 * Create an expression evaluator that uses the runtime to evaluate constant expressions
 */
export function createRuntimeExpressionEvaluator(db: Database): (expr: PlanNode) => MaybePromise<OutputValue> {
	return function evaluateExpression(expr: PlanNode): MaybePromise<OutputValue> {
		log('Evaluating constant expression: %s', expr.nodeType);

		try {
			// Create temporary emission context
			const emissionCtx = new EmissionContext(db);

			// Emit the expression to an instruction
			const instruction = emitPlanNode(expr, emissionCtx);

			// Create a scheduler to execute the instruction
			const scheduler = new Scheduler(instruction);

			// Create minimal runtime context for evaluation
			// No row context is needed since we only evaluate constant expressions
			const runtimeCtx: RuntimeContext = {
				db,
				stmt: undefined,
				params: {}, // No parameters needed for constants
				context: new Map(), // No row context needed
				tableContexts: new Map(), // No table contexts needed for constants
				enableMetrics: false
			};

			// Execute and get the result
			const result = scheduler.run(runtimeCtx);

			// Ensure result is a valid OutputValue
			if (result === undefined) {
				throw new QuereusError('Expression evaluation returned undefined');
			}

			log('Expression evaluated to: %s', result);
			return result as MaybePromise<OutputValue>;

		} catch (error) {
			log('Failed to evaluate expression %s: %s', expr.nodeType, error);
			throw new QuereusError('Expression evaluation failed', StatusCode.ERROR, error instanceof Error ? error : undefined);
		}
	};
}
