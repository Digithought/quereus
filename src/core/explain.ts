import { IndexConstraintOp } from "../common/constants.js";
import type { Compiler } from "../compiler/compiler.js";
import type { PlannedJoinStep, PlannedScanStep, PlannedStep } from "../compiler/planner/types.js";
import type { IndexConstraint } from "../vtab/indexInfo.js";

/** Type definition for a single step in the query plan output */
export interface QueryPlanStep {
	// Core identification and structure
	id: number;                 // Sequential ID for the step, unique within the plan output
	parentId: number | null;    // ID of the parent step (e.g., a JOIN step for its inputs)
	subqueryLevel: number;      // Nesting level of the subquery (0 for main query)

	// Operation details
	op: string;                 // e.g., "SCAN", "JOIN", "SORT", "AGGREGATE", "PROJECT", "MATERIALIZE_CTE"
	detail: string;             // Specifics of the operation (e.g., table name for SCAN, join condition for JOIN)

	// Object being operated on
	objectName?: string;        // Name of the table, index, or CTE
	alias?: string;             // Alias used in the query

	// Planner estimates (from BestIndexPlan)
	estimatedCost?: number;
	estimatedRows?: bigint;

	// Index/Scan related info (from BestIndexPlan and IndexInfo)
	idxNum?: number;            // Virtual table's idxNum for the chosen plan
	idxStr?: string | null | undefined; // Corrected type to allow null from plan.idxStr
	orderByConsumed?: boolean;  // True if the scan satisfied an ORDER BY
	constraintsDesc?: string;   // Human-readable description of constraints passed to xBestIndex
	orderByDesc?: string;       // Human-readable description of ORDER BY terms passed to xBestIndex

	// Join specific
	joinType?: string;          // e.g., "LOOP", "HASH", "MERGE" (SQLite uses terms like "LEFT LOOP")

	// Other useful fields
	isCorrelated?: boolean;     // For subqueries or certain scans, indicates correlation
}

function getColumnNameForPlan(compiler: Compiler, cursorId: number, colIdx: number): string {
	const schema = compiler.tableSchemas.get(cursorId);
	return schema?.columns[colIdx]?.name ?? `Col${colIdx}`;
}

function formatConstraintForPlan(constraint: IndexConstraint, cursorId: number, compiler: Compiler): string {
	const colName = getColumnNameForPlan(compiler, cursorId, constraint.iColumn);
	const opStr = IndexConstraintOp[constraint.op] || `Op${constraint.op}`;
	return `${colName} ${opStr}${constraint.usable ? '' : ' (unusable)'}`;
}

function formatOrderByForPlan(orderBy: { iColumn: number; desc: boolean; }, cursorId: number, compiler: Compiler): string {
	const colName = getColumnNameForPlan(compiler, cursorId, orderBy.iColumn);
	return `${colName} ${orderBy.desc ? 'DESC' : 'ASC'}`;
}

function buildDetailStringForPlanStep(op: string, objectName?: string, alias?: string, idxStr?: string | null, extra?: string): string {
	let detail = op;
	if (objectName) detail += ` ${objectName}`;
	if (alias && alias.toLowerCase() !== objectName?.toLowerCase()) detail += ` AS ${alias}`;
	if (idxStr) detail += ` USING ${idxStr}`;
	if (extra) detail += ` (${extra})`;
	return detail;
}

export function transformPlannedStepsToQueryPlanSteps(
	nodes: ReadonlyArray<PlannedStep>,
	parentId: number | null,
	idCounterStart: number,
	currentSubqueryLevel: number,
	compiler: Compiler
): { steps: QueryPlanStep[], nextId: number } {
	const resultSteps: QueryPlanStep[] = [];
	let currentId = idCounterStart;

	for (const node of nodes) {
		const stepId = currentId++;
		const baseStep: QueryPlanStep = {
			id: stepId,
			parentId: parentId,
			subqueryLevel: currentSubqueryLevel,
			op: 'UNKNOWN',
			detail: '',
		};

		switch (node.type) {
			case 'Scan': {
				const scanNode = node as PlannedScanStep;
				const tableSchema = scanNode.relation.schema;
				baseStep.op = tableSchema.isView ? "VIEW SCAN" :
					tableSchema.subqueryAST ? "SUBQUERY SCAN" :
						tableSchema.name.startsWith('sqlite_sq_') ? "SUBQUERY SCAN" :
							(scanNode.plan.idxNum !== undefined && scanNode.plan.idxNum > 0 ? "INDEX SCAN" : "SCAN");
				baseStep.objectName = tableSchema.name;
				baseStep.alias = scanNode.relation.alias;

				const plan = scanNode.plan;
				baseStep.estimatedCost = plan.cost;
				baseStep.estimatedRows = plan.rows;
				baseStep.idxNum = plan.idxNum;
				baseStep.idxStr = plan.idxStr;
				baseStep.orderByConsumed = plan.orderByConsumed;

				const cursorId = [...scanNode.relation.contributingCursors][0];
				if (plan.constraints && plan.constraints.length > 0) {
					baseStep.constraintsDesc = plan.constraints.map(c => formatConstraintForPlan(c, cursorId, compiler)).join(', ');
				}
				if (plan.orderByConsumed && plan.aOrderBy && plan.aOrderBy.length > 0) {
					baseStep.orderByDesc = plan.aOrderBy.map(o => formatOrderByForPlan(o, cursorId, compiler)).join(', ');
				}

				const idxStrForDetail = plan.idxStr || (plan.idxNum && plan.idxNum > 0 ? `INDEX ${plan.idxNum}` : null);
				baseStep.detail = buildDetailStringForPlanStep(baseStep.op, baseStep.objectName, baseStep.alias, idxStrForDetail, baseStep.constraintsDesc);

				resultSteps.push(baseStep);
				break;
			}
			case 'Join': {
				const joinNode = node as PlannedJoinStep;
				baseStep.op = "JOIN";
				baseStep.joinType = joinNode.joinType;
				baseStep.estimatedCost = joinNode.outputRelation.estimatedCost;
				baseStep.estimatedRows = joinNode.outputRelation.estimatedRows;

				const outerName = joinNode.outerStep.type === 'Scan' ? ((joinNode.outerStep as PlannedScanStep).relation.alias || (joinNode.outerStep as PlannedScanStep).relation.schema.name) : 'subplan';
				const innerName = joinNode.innerStep.type === 'Scan' ? ((joinNode.innerStep as PlannedScanStep).relation.alias || (joinNode.innerStep as PlannedScanStep).relation.schema.name) : 'subplan';

				let conditionDetail = "";
				if (joinNode.condition) {
					// TODO: Serialize AST.Expression for joinNode.condition to a string if desired
					conditionDetail = "ON <condition>";
				}
				baseStep.detail = buildDetailStringForPlanStep(`JOIN (${joinNode.joinType})`, `${outerName} WITH ${innerName}`, undefined, undefined, conditionDetail);

				resultSteps.push(baseStep);

				const outerResult = transformPlannedStepsToQueryPlanSteps([joinNode.outerStep], stepId, currentId, currentSubqueryLevel, compiler);
				resultSteps.push(...outerResult.steps);
				currentId = outerResult.nextId;

				const innerResult = transformPlannedStepsToQueryPlanSteps([joinNode.innerStep], stepId, currentId, currentSubqueryLevel, compiler);
				resultSteps.push(...innerResult.steps);
				currentId = innerResult.nextId;
				break;
			}
			default: {
				const unknownNode = node as any;
				baseStep.op = unknownNode.type?.toUpperCase() || "UNKNOWN_STEP";
				baseStep.detail = `Unknown plan step type: ${unknownNode.type}`;
				resultSteps.push(baseStep);
				break;
			}
		}
	}
	return { steps: resultSteps, nextId: currentId };
}