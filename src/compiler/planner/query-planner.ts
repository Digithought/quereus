import type { Compiler } from '../compiler.js';
import type * as AST from '../../parser/ast.js';
import type { PlannedStep } from './types.js';
import { getStepPrimaryAlias, log } from './helpers.js';
import { QueryPlannerContext } from './context.js';

// Default value for estimated rows when schema lacks it - Moved to context.ts or types.ts if needed globally
// const DEFAULT_ESTIMATED_ROWS = BigInt(10_000);

// --- Main Planner Entry Point --- //

/**
 * Plans the execution strategy for a SELECT, UPDATE, or DELETE statement.
 *
 * @param compiler The compiler instance.
 * @param stmt The statement AST node.
 * @returns An ordered array of PlannedSteps representing the execution plan.
 */
export function planQueryExecution(
	compiler: Compiler,
	stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt
): PlannedStep[] {
	const context = new QueryPlannerContext(compiler, stmt);
	const plannedSteps = context.planExecution();

	// Log the final plan (basic)
	log("Final Planned Steps:");
	plannedSteps.forEach((step, index) => {
		if (step.type === 'Scan') {
			log(`  [${index}] SCAN ${step.relation.alias} (Cursor ${[...step.relation.contributingCursors][0]}) -> EstCost: ${step.plan.cost.toFixed(2)}, EstRows: ${step.plan.rows}`);
		} else if (step.type === 'Join') {
			// Use helper to get aliases safely
			const outerAlias = getStepPrimaryAlias(step.outerStep);
			const innerAlias = getStepPrimaryAlias(step.innerStep);
			log(`  [${index}] JOIN (${step.joinType}) ${outerAlias} <-> ${innerAlias} -> EstCost: ${step.outputRelation.estimatedCost.toFixed(2)}, EstRows: ${step.outputRelation.estimatedRows}`);
		}
	});

	return plannedSteps;
}
