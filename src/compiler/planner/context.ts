import type * as AST from '../../parser/ast';
import type { Compiler, CursorPlanningResult } from '../compiler';
import { log, warnLog, errorLog } from './helpers';
import type { QueryRelation, JoinCandidateInfo, PlannedStep, PlannedScanStep, PlannedJoinStep } from './types';
import { planTableAccessHelper } from './helpers.js';
import { generateRelationId } from './utils';
import { expressionToString } from '../../util/ddl-stringify.js';

/** Helper to check if a plan's consumed order matches the statement's ORDER BY */
function checkOrderConsumed(stmtOrderBy: ReadonlyArray<AST.OrderByClause> | undefined, planOrderByConsumed: CursorPlanningResult['orderByConsumed'] | undefined): boolean {
	if (!stmtOrderBy || stmtOrderBy.length === 0) {
		return true; // No ORDER BY means the order is trivially consumed
	}
	// Check if planOrderByConsumed is an array and lengths match
	if (!Array.isArray(planOrderByConsumed) || planOrderByConsumed.length !== stmtOrderBy.length) {
		return false; // Plan doesn't consume order or length mismatch
	}
	for (let i = 0; i < stmtOrderBy.length; i++) {
		const stmtTerm = stmtOrderBy[i];
		const planTerm = planOrderByConsumed[i]; // planTerm is now correctly typed as an object
		if (!planTerm || !planTerm.expr) return false; // Defensive check
		// Compare expression strings
		if (expressionToString(stmtTerm.expr) !== expressionToString(planTerm.expr)) {
			return false;
		}
		// Compare direction
		const stmtDir = stmtTerm.direction?.toUpperCase() ?? 'ASC';
		const planDir = planTerm.direction?.toUpperCase() ?? 'ASC';
		if (stmtDir !== planDir) {
			return false;
		}
		// TODO: Compare NULLS FIRST/LAST if implemented
	}
	return true; // All terms match
}

/** Context object holding state during the planning of a single query. */
export class QueryPlannerContext {
	readonly compiler: Compiler;
	readonly stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt;

	/** Map Relation ID -> Relation */
	readonly relations = new Map<QueryRelation['id'], QueryRelation>();
	/** Potential joins derived from the AST */
	readonly availableJoins: JoinCandidateInfo[] = [];
	/** Map Alias/TableName -> Base Relation ID */
	private readonly sourceAliasToRelationId = new Map<string, QueryRelation['id']>();
	/** Map Relation ID -> Step that produces it */
	private readonly relationToProducerStep = new Map<QueryRelation['id'], PlannedStep>();

	constructor(compiler: Compiler, stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt) {
		this.compiler = compiler;
		this.stmt = stmt;
		this._initialize();
	}

	private _initialize(): void {
		log("Initializing QueryPlannerContext...");
		// Get the FROM sources based on statement type
		let fromSources: ReadonlyArray<AST.FromClause> | undefined;
		if (this.stmt.type === 'select') {
			fromSources = this.stmt.from;
		} else if (this.stmt.type === 'update' || this.stmt.type === 'delete') {
			// UPDATE/DELETE FROM is an extension, assume single table for now if no FROM
			// Or handle the specific AST structure for UPDATE FROM / DELETE FROM if supported
			// For simplicity, let's assume the target table IS the source if no explicit FROM
			// This needs alignment with how UPDATE/DELETE FROM are parsed/handled.
			// const targetTableName = this.stmt.table.name;
			// const targetAlias = targetTableName.toLowerCase();
			// fromSources = [ { type: 'table', table: { type: 'identifier', name: targetTableName }, alias: targetAlias } ];
			warnLog(`Query planning for UPDATE/DELETE FROM clauses is not fully implemented.`);
			// If UPDATE/DELETE have a similar .from property in your AST, use that:
			// fromSources = (this.stmt as any).from; // Example if structure exists
		}

		if (!fromSources) {
			log("No FROM sources found for planning.");
			return; // Exit initialization if no sources
		}

		// 1. Pre-process FROM for subqueries/functions (TODO: Integrate properly)
		//    This should ensure their cursors/schemas exist in compiler state.
		//    Existing logic in compileSelectStatement handles this currently.
		warnLog("QueryPlannerContext relying on pre-processing in compileSelectStatement for subqueries/functions.");

		// 2. Populate Base Relations
		for (const [alias, cursorIdx] of this.compiler.tableAliases.entries()) {
			const tableSchema = this.compiler.tableSchemas.get(cursorIdx);
			if (!tableSchema) {
				errorLog(`Internal error: Schema not found for cursor ${cursorIdx} (alias: ${alias}) during planning.`);
				continue;
			}

			// Plan initial access for this base table
			// Use existing planning info if available (might have been done earlier)
			let baseAccessPlan = this.compiler.cursorPlanningInfo.get(cursorIdx);
			if (!baseAccessPlan) {
				warnLog(`Planning base access for ${alias} (cursor ${cursorIdx}) within QueryPlannerContext.`);
				this.compiler.planTableAccess(cursorIdx, tableSchema, this.stmt, new Set());
				baseAccessPlan = this.compiler.cursorPlanningInfo.get(cursorIdx);
			}

			if (!baseAccessPlan) {
				errorLog(`Failed to get base access plan for cursor ${cursorIdx} (alias: ${alias}).`);
				continue; // Skip if planning failed
			}

			// Create unique ID (using cursor index for base tables)
			const relationId = generateRelationId(new Set([cursorIdx]));
			const relation: QueryRelation = {
				id: relationId,
				alias: alias, // Already lowercase from tableAliases map
				contributingCursors: new Set([cursorIdx]),
				estimatedRows: baseAccessPlan.rows,
				estimatedCost: baseAccessPlan.cost,
				baseAccessPlan: Object.freeze(baseAccessPlan), // Freeze for safety
				schema: Object.freeze(tableSchema), // Freeze for safety
			};

			this.relations.set(relationId, relation);
			this.sourceAliasToRelationId.set(alias, relationId);
			log(`Created base relation: ${relationId} (Alias: ${alias}, EstRows: ${relation.estimatedRows}, EstCost: ${relation.estimatedCost.toFixed(2)})`);
		}

		// 3. Extract Join Conditions from AST
		this._extractJoinConditions(fromSources);
		log(`Extracted ${this.availableJoins.length} potential join conditions.`);
	}

	/** Recursively extracts JoinCandidateInfo from the FROM clause AST. */
	private _extractJoinConditions(sources: ReadonlyArray<AST.FromClause>): void {

		const getRelationIdForSource = (source: AST.FromClause): QueryRelation['id'] | null => {
			if (source.type === 'table') {
				const alias = (source.alias || source.table.name).toLowerCase();
				return this.sourceAliasToRelationId.get(alias) ?? null;
			} else if (source.type === 'subquerySource' || source.type === 'functionSource') {
				const alias = source.alias?.toLowerCase();
				return alias ? this.sourceAliasToRelationId.get(alias) ?? null : null;
			} else if (source.type === 'join') {
				// The ID of a join is the ID of the relation produced by its *right* side (in AST order)
				// because we process left-to-right.
				// This assumes the relation map is populated progressively.
				return getRelationIdForSource(source.right);
			}
			return null;
		};

		const processSource = (source: AST.FromClause): void => {
			if (source.type === 'join') {
				// Recursively process children first to ensure their relations exist
				processSource(source.left);
				processSource(source.right);

				const leftId = getRelationIdForSource(source.left);
				const rightId = getRelationIdForSource(source.right);

				if (!leftId || !rightId) {
					warnLog(`Could not find relation IDs for join operands near line ${source.loc?.start.line}. Skipping join candidate.`);
					return;
				}

				// Simple selectivity heuristic
				let selectivity = 0.1; // Default guess for equality-like joins


				// Determine the effective join type, trusting the parser output matches the AST definition
				let effectiveJoinType = source.joinType as 'inner' | 'left' | 'right' | 'full' | 'cross';

				if (effectiveJoinType === 'cross' || (!source.condition && !source.columns)) {
					selectivity = 1.0;
					// Ensure type is marked as cross if no condition/using is present (and not already an outer join)
					if (effectiveJoinType !== 'left' && effectiveJoinType !== 'right' && effectiveJoinType !== 'full') {
						effectiveJoinType = 'cross';
					}
				} // TODO: Refine based on condition analysis (equality vs range etc.)

				const joinInfo: JoinCandidateInfo = {
					leftRelationId: leftId,
					rightRelationId: rightId,
					joinType: effectiveJoinType,
					condition: source.condition ? Object.freeze(source.condition) : null,
					columns: source.columns ? Object.freeze(source.columns) : null,
					estimatedSelectivity: selectivity,
					astNode: Object.freeze(source),
				};
				this.availableJoins.push(joinInfo);
			} else if (source.type === 'table' || source.type === 'subquerySource' || source.type === 'functionSource') {
				// Base sources are handled in the initial population loop
			}
		};

		// Process top-level sources (handles comma joins / multiple sources)
		let previousSourceId: string | null = null;
		for (const source of sources) {
			processSource(source); // Process potential nested joins within this source first
			const currentSourceId = getRelationIdForSource(source);

			if (previousSourceId && currentSourceId) {
				// Found an implicit CROSS JOIN between top-level FROM sources
				const crossJoinInfo: JoinCandidateInfo = {
					leftRelationId: previousSourceId,
					rightRelationId: currentSourceId,
					joinType: 'cross',
					condition: null,
					columns: null,
					estimatedSelectivity: 1.0,
					astNode: null, // No specific AST node for implicit join
				};
				this.availableJoins.push(crossJoinInfo);
			}
			previousSourceId = currentSourceId; // Update for the next iteration
		}
	}

	/** Finds the step that produced the relation with the given ID */
	private findStepProducingRelation(relationId: string): PlannedStep {
		const step = this.relationToProducerStep.get(relationId);
		if (!step) {
			throw new Error(`Internal planner error: Cannot find step producing relation ${relationId}`);
		}
		return step;
	}

	/**
	 * The main entry point to plan the query execution.
	 * Selects the optimal join order and produces a list of PlannedSteps.
	 */
	planExecution(): PlannedStep[] {
		log("Executing planExecution()...");

		const plannedSteps: PlannedStep[] = [];
		const availableRelations = new Map(this.relations);
		const currentJoins = [...this.availableJoins];

		// Determine the ORDER BY clause safely
		const orderByClause = this.stmt.type === 'select' ? this.stmt.orderBy : undefined;

		// Initialize with Scan steps for all base relations
		for (const [relationId, relation] of availableRelations.entries()) {
			if (relation.baseAccessPlan) {
				const scanStep: PlannedScanStep = {
					type: 'Scan',
					relation: Object.freeze(relation),
					plan: Object.freeze(relation.baseAccessPlan),
					// Pass the potentially undefined orderByClause
					orderByConsumed: checkOrderConsumed(orderByClause, relation.baseAccessPlan.orderByConsumed)
				};
				plannedSteps.push(scanStep);
				this.relationToProducerStep.set(relationId, scanStep);
			}
		}

		let iteration = 0;
		const MAX_ITERATIONS = availableRelations.size + 1; // Safety break

		while (availableRelations.size > 1 && iteration++ < MAX_ITERATIONS) {
			log(`Planning iteration ${iteration}. Available relations: ${[...availableRelations.keys()].join(', ')}`);
			let bestJoinInfo: JoinCandidateInfo | null = null;
			let bestCost: number = Infinity;
			let bestResultRelation: QueryRelation | null = null;
			let bestJoinStepDetails: Omit<PlannedJoinStep, 'type'> | null = null;

			let candidateFound = false;
			for (const joinInfo of currentJoins) {
				if (availableRelations.has(joinInfo.leftRelationId) && availableRelations.has(joinInfo.rightRelationId)) {
					candidateFound = true;
					const leftRel = availableRelations.get(joinInfo.leftRelationId)!;
					const rightRel = availableRelations.get(joinInfo.rightRelationId)!;

					const costResult = this._costJoinCandidate(joinInfo, leftRel, rightRel);

					if (costResult && costResult.cost < bestCost) {
						bestCost = costResult.cost;
						bestJoinInfo = joinInfo;
						bestResultRelation = costResult.resultRelation;
						bestJoinStepDetails = costResult.stepDetails;
					}
				}
			}

			if (!bestJoinInfo || !bestResultRelation || !bestJoinStepDetails) {
				if (candidateFound) {
					errorLog("Found join candidates, but failed to determine best cost. Aborting planning loop.");
				} else {
					warnLog("No more applicable join candidates found.");
				}
				break; // Exit loop
			}

			log(`Selected best join: ${bestJoinInfo.leftRelationId} ${bestJoinInfo.joinType} ${bestJoinInfo.rightRelationId} (Cost: ${bestCost.toFixed(2)})`);

			// Create and add the PlannedJoinStep - DO NOT freeze the step itself
			const joinStep: PlannedJoinStep = {
				type: 'Join',
				...bestJoinStepDetails, // Spread the details (which might have some frozen parts)
				// Ensure the input steps referenced are the mutable ones already in plannedSteps or retrieved from relationToProducerStep
				leftInputStep: this.findStepProducingRelation(bestJoinInfo.leftRelationId),
				rightInputStep: this.findStepProducingRelation(bestJoinInfo.rightRelationId),
				// Correctly get the relation ID based on the step type
				outerStep: this.findStepProducingRelation(
					bestJoinStepDetails.outerStep.type === 'Scan' ? bestJoinStepDetails.outerStep.relation.id : bestJoinStepDetails.outerStep.outputRelation.id
				),
				innerStep: this.findStepProducingRelation(
					bestJoinStepDetails.innerStep.type === 'Scan' ? bestJoinStepDetails.innerStep.relation.id : bestJoinStepDetails.innerStep.outputRelation.id
				),
				// outputRelation and innerLoopPlan remain frozen from stepDetails
				preservesOuterOrder: true // NLJ always preserves outer order
			};
			plannedSteps.push(joinStep);
			this.relationToProducerStep.set(bestResultRelation.id, joinStep);

			// Update available relations
			availableRelations.delete(bestJoinInfo.leftRelationId);
			availableRelations.delete(bestJoinInfo.rightRelationId);
			availableRelations.set(bestResultRelation.id, bestResultRelation);

			// Update currentJoins (remove the used one, potentially update others referencing consumed relations)
			const indexToRemove = currentJoins.indexOf(bestJoinInfo);
			if (indexToRemove > -1) {
				currentJoins.splice(indexToRemove, 1);
			}
			// TODO: Update other joins in currentJoins that referenced the consumed relations.
			// This requires replacing left/right IDs, which might get complex. For a simple greedy
			// approach, skipping this update might be acceptable initially, but less robust.
		}

		if (availableRelations.size > 1) {
			warnLog(`Planning loop finished with ${availableRelations.size} relations remaining. Query might be disconnected.`);
		}
		if (iteration >= MAX_ITERATIONS) {
			errorLog(`Planning loop exceeded max iterations (${MAX_ITERATIONS}).`);
		}

		return plannedSteps;
	}

	/** Estimates the cost of a potential join and returns details if feasible */
	private _costJoinCandidate(
		joinInfo: JoinCandidateInfo,
		leftRel: QueryRelation,
		rightRel: QueryRelation
	): { cost: number, resultRelation: QueryRelation, stepDetails: Omit<PlannedJoinStep, 'type'> } | null {

		log(`Costing join: ${leftRel.id} ${joinInfo.joinType} ${rightRel.id}`);

		// --- 1. Estimate Result Cardinality --- //
		// Clamp selectivity to avoid negative or >1 values
		const selectivity = Math.max(0, Math.min(1, joinInfo.estimatedSelectivity));
		let estimatedResultRows = BigInt(Math.round(Number(leftRel.estimatedRows) * Number(rightRel.estimatedRows) * selectivity));
		if (estimatedResultRows < 1n) estimatedResultRows = 1n; // Avoid 0 rows estimate if selectivity is very low

		// --- 2. Cost Nested Loop: Left Outer, Right Inner --- //
		let costLeftOuter = Infinity;
		let innerPlanRight: CursorPlanningResult | null = null;
		// Simplification: Plan access only for the *first* cursor of the inner relation.
		// This needs improvement for joins involving already-joined relations.
		const innerCursorRight = [...rightRel.contributingCursors][0];
		if (innerCursorRight !== undefined) {
			const innerSchemaRight = this.compiler.tableSchemas.get(innerCursorRight);
			if (innerSchemaRight) {
				// Plan access for the inner side, considering outer cursors and the join condition
				this.compiler.planTableAccess(innerCursorRight, innerSchemaRight, this.stmt, leftRel.contributingCursors);
				innerPlanRight = this.compiler.cursorPlanningInfo.get(innerCursorRight)!;
				costLeftOuter = leftRel.estimatedCost + Number(leftRel.estimatedRows) * innerPlanRight.cost;
				log(` -> Cost LeftOuter: ${leftRel.estimatedCost.toFixed(2)} + ${leftRel.estimatedRows} * ${innerPlanRight.cost.toFixed(2)} = ${costLeftOuter.toFixed(2)}`);
			}
		}

		// --- 3. Cost Nested Loop: Right Outer, Left Inner --- //
		let costRightOuter = Infinity;
		let innerPlanLeft: CursorPlanningResult | null = null;
		const innerCursorLeft = [...leftRel.contributingCursors][0];
		if (innerCursorLeft !== undefined) {
			const innerSchemaLeft = this.compiler.tableSchemas.get(innerCursorLeft);
			if (innerSchemaLeft) {
				this.compiler.planTableAccess(innerCursorLeft, innerSchemaLeft, this.stmt, rightRel.contributingCursors);
				innerPlanLeft = this.compiler.cursorPlanningInfo.get(innerCursorLeft)!;
				costRightOuter = rightRel.estimatedCost + Number(rightRel.estimatedRows) * innerPlanLeft.cost;
				log(` -> Cost RightOuter: ${rightRel.estimatedCost.toFixed(2)} + ${rightRel.estimatedRows} * ${innerPlanLeft.cost.toFixed(2)} = ${costRightOuter.toFixed(2)}`);
			}
		}

		// --- 4. Determine Best Order and Final Cost --- //
		let bestCost: number;
		let chosenOuterRel: QueryRelation;
		let chosenInnerRel: QueryRelation;
		let chosenInnerPlan: CursorPlanningResult;

		if (costLeftOuter <= costRightOuter) {
			if (!innerPlanRight) return null; // Cannot proceed if inner plan failed
			bestCost = costLeftOuter;
			chosenOuterRel = leftRel;
			chosenInnerRel = rightRel;
			chosenInnerPlan = innerPlanRight;
			log(` -> Chosen: Left Outer (Cost: ${bestCost.toFixed(2)})`);
		} else {
			if (!innerPlanLeft) return null; // Cannot proceed if inner plan failed
			bestCost = costRightOuter;
			chosenOuterRel = rightRel;
			chosenInnerRel = leftRel;
			chosenInnerPlan = innerPlanLeft;
			log(` -> Chosen: Right Outer (Cost: ${bestCost.toFixed(2)})`);
		}

		// --- 5. Construct Result Relation and Step Details --- //
		const combinedCursors = new Set([...chosenOuterRel.contributingCursors, ...chosenInnerRel.contributingCursors]);
		const resultRelationId = generateRelationId(combinedCursors);

		// TODO: Define the schema for the result relation.
		// For now, reuse the outer relation's schema as a placeholder.
		// A proper implementation needs to combine columns from both inputs.
		const resultSchema = chosenOuterRel.schema;
		warnLog(`Result schema for join ${resultRelationId} is using outer schema as placeholder.`);

		const resultRelation: QueryRelation = {
			id: resultRelationId,
			alias: `join_${chosenOuterRel.alias}_${chosenInnerRel.alias}`, // Generate an internal alias
			contributingCursors: combinedCursors,
			estimatedRows: estimatedResultRows,
			estimatedCost: bestCost,
			baseAccessPlan: null, // Not a base scan
			schema: resultSchema,
		};

		const stepDetails: Omit<PlannedJoinStep, 'type'> = {
			outputRelation: Object.freeze(resultRelation),
			joinType: joinInfo.joinType,
			leftInputStep: this.findStepProducingRelation(leftRel.id),
			rightInputStep: this.findStepProducingRelation(rightRel.id),
			condition: joinInfo.condition, // TODO: Handle USING columns by converting to condition
			outerStep: this.findStepProducingRelation(chosenOuterRel.id),
			innerStep: this.findStepProducingRelation(chosenInnerRel.id),
			innerLoopPlan: Object.freeze(chosenInnerPlan),
			preservesOuterOrder: true, // Explicitly add here as well for clarity in costing result
		};

		return { cost: bestCost, resultRelation, stepDetails };
	}
}
