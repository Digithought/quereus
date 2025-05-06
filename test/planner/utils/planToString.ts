// Placeholder for planToString utility
import type { PlannedStep } from '../../../src/compiler/planner/types.js';
import { getStepPrimaryAlias } from '../../../src/compiler/planner/helpers.js';

/**
 * Converts a PlannedStep array into a stable, readable string format for snapshots.
 */
export function planToString(steps: PlannedStep[]): string {
    if (!steps || steps.length === 0) {
        return "EMPTY PLAN";
    }

    const lines: string[] = [];
    steps.forEach((step, index) => {
        let line = `[${index}] `;
        if (step.type === 'Scan') {
            const cursor = [...step.relation.contributingCursors][0];
            line += `SCAN ${step.relation.alias} (Cursor ${cursor}) Cost=${step.plan.cost.toFixed(1)} Rows=${step.plan.rows} Idx=${step.plan.idxNum}`; // Simplified
            if (step.orderByConsumed) {
                line += ` OrderConsumed`;
            }
        } else if (step.type === 'Join') {
            const outerAlias = getStepPrimaryAlias(step.outerStep);
            const innerAlias = getStepPrimaryAlias(step.innerStep);
            const outerCursor = step.outerStep.type === 'Scan' ? [...step.outerStep.relation.contributingCursors][0] : '?';
            const innerCursor = step.innerStep.type === 'Scan' ? [...step.innerStep.relation.contributingCursors][0] : '?'; // This might be complex if inner is join
            line += `JOIN (${step.joinType}) ${outerAlias}(C${outerCursor}) <-> ${innerAlias}(C${innerCursor}) Outer=${outerAlias} Cost=${step.outputRelation.estimatedCost.toFixed(1)} Rows=${step.outputRelation.estimatedRows}`;
            // TODO: Add innerLoopPlan details?
        } else {
            line += `UNKNOWN STEP TYPE: ${(step as any).type}`;
        }
        lines.push(line);
    });

    return lines.join('\n');
}
