// Utility to convert a PlannedStep array into a stable, readable string format.
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
            line += `SCAN ${step.relation.alias} (Cursor ${cursor}) Cost=${step.plan.cost.toFixed(1)} Rows=${step.plan.rows} Idx=${step.plan.idxNum}`;
            if (step.orderByConsumed) {
                line += ` OrderConsumed`;
            }
        } else if (step.type === 'Join') {
            const outerAlias = getStepPrimaryAlias(step.outerStep);
            const innerAlias = getStepPrimaryAlias(step.innerStep);
            // Determine cursor IDs carefully, especially if steps are not Scans
            let outerCursorId = '?';
            if (step.outerStep.type === 'Scan') {
                outerCursorId = String([...step.outerStep.relation.contributingCursors][0]);
            } else if (step.outerStep.type === 'Join') {
                // For a join, the "cursor" is more abstract. We might use the first contributing cursor of its output relation.
                outerCursorId = String([...step.outerStep.outputRelation.contributingCursors][0]) + '*'; // Mark as derived
            }

            let innerCursorId = '?';
            if (step.innerStep.type === 'Scan') {
                innerCursorId = String([...step.innerStep.relation.contributingCursors][0]);
            } else if (step.innerStep.type === 'Join') {
                innerCursorId = String([...step.innerStep.outputRelation.contributingCursors][0]) + '*';
            }

            line += `JOIN (${step.joinType}) ${outerAlias}(C${outerCursorId}) <-> ${innerAlias}(C${innerCursorId}) Outer=${outerAlias} Cost=${step.outputRelation.estimatedCost.toFixed(1)} Rows=${step.outputRelation.estimatedRows}`;
            if (step.preservesOuterOrder === false) {
                line += ` OrderBroken`;
            }
        } else {
            line += `UNKNOWN STEP TYPE: ${(step as any).type}`;
        }
        lines.push(line);
    });

    return lines.join('\n');
}
