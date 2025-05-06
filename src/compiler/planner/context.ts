import type * as AST from '../../parser/ast.js';
import type { Compiler, CursorPlanningResult } from '../compiler.js';
import { log, warnLog, errorLog, expressionReferencesOnlyAllowedCursors, estimateSubqueryCost } from './helpers.js';
import type { QueryRelation, JoinCandidateInfo, PlannedStep, PlannedScanStep, PlannedJoinStep } from './types.js';
import { generateRelationId } from './utils.js';
import { expressionToString } from '../../util/ddl-stringify.js';
import type { TableSchema } from '../../schema/table.js';

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
	readonly outerCursors: ReadonlySet<number>;

	/** Map Relation ID -> Relation */
	readonly relations = new Map<QueryRelation['id'], QueryRelation>();
	/** Potential joins derived from the AST */
	readonly availableJoins: JoinCandidateInfo[] = [];
	/** Map Alias/TableName -> Base Relation ID */
	private readonly sourceAliasToRelationId = new Map<string, QueryRelation['id']>();
	/** Map Relation ID -> Step that produces it */
	private readonly relationToProducerStep = new Map<QueryRelation['id'], PlannedStep>();

	constructor(compiler: Compiler, stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt, outerCursors: ReadonlySet<number> = new Set()) {
		this.compiler = compiler;
		this.stmt = stmt;
		this.outerCursors = outerCursors;
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
			// This part remains simplified as per previous logic
			warnLog(`Query planning for UPDATE/DELETE FROM clauses is not fully implemented.`);
		}

		if (!fromSources || fromSources.length === 0) {
			log("No FROM sources found for planning.");
			// If it's an UPDATE/DELETE without FROM, we might need to add the target table implicitly
			// This needs careful handling based on how UPDATE/DELETE are parsed.
			// For now, return if no explicit sources.
			return;
		}

		// 1. Populate Relations from AST Sources
		// This replaces the loop over compiler.tableAliases
		const processedAliases = new Set<string>(); // Track aliases processed to avoid duplicates

		const processSourceRecursive = (source: AST.FromClause): void => {
			if (source.type === 'join') {
				// Process children first to ensure their relations exist before processing the join itself later
				processSourceRecursive(source.left);
				processSourceRecursive(source.right);
				return; // Join conditions handled later in _extractJoinConditions
			}

			let alias: string | undefined;
			let cursorIdx: number | undefined;
			let tableSchema: Readonly<TableSchema> | undefined;
			let baseAccessPlan: Readonly<CursorPlanningResult> | null = null;
			let relationId: string;
			const sourceAstNode = Object.freeze(source); // Freeze the AST node reference

			if (source.type === 'table') {
				alias = (source.alias || source.table.name).toLowerCase();
				// Find cursor index associated with this alias/table (pre-populated by compileFromCoreHelper)
				cursorIdx = this.compiler.tableAliases.get(alias);
			} else if (source.type === 'subquerySource' || source.type === 'functionSource') {
				alias = source.alias?.toLowerCase();
				if (!alias) {
					errorLog(`Subquery or function source requires an alias near line ${source.loc?.start.line}.`);
					return; // Cannot proceed without an alias
				}
				cursorIdx = this.compiler.tableAliases.get(alias);
			} else {
				// Provide the actual type for logging
				const sourceType = (source as any).type;
				warnLog(`Unhandled FROM source type during relation creation: ${sourceType}`);
				return;
			}

			if (!alias || cursorIdx === undefined) {
				// This might happen if compileFromCoreHelper failed or AST is malformed
				errorLog(`Could not find pre-compiled cursor for source near line ${source.loc?.start.line}. Alias: ${alias}`);
				return;
			}

			if (processedAliases.has(alias)) {
				log(`Alias '${alias}' already processed, skipping duplicate relation creation.`);
				return; // Avoid creating duplicate relations for the same source/alias
			}

			tableSchema = this.compiler.tableSchemas.get(cursorIdx);
			if (!tableSchema) {
				errorLog(`Internal error: Schema not found for cursor ${cursorIdx} (alias: ${alias}) during planning.`);
				return;
			}

			relationId = generateRelationId(new Set([cursorIdx])); // Base relation ID uses cursor

			// Define estimates here, potentially updated by initial plan
			let estimatedRows: bigint = BigInt(1000000); // Default large estimate
			let estimatedCost: number = 1e10; // Default high cost

			if (source.type === 'table') {
				// Plan initial access for base tables only
				const existingPlan = this.compiler.cursorPlanningInfo.get(cursorIdx);
				if (existingPlan) {
					baseAccessPlan = Object.freeze(existingPlan);
				} else {
					warnLog(`Planning base access for ${alias} (cursor ${cursorIdx}) within QueryPlannerContext.`);
					this.compiler.planTableAccess(cursorIdx, tableSchema, this.stmt, this.outerCursors);
					const plan = this.compiler.cursorPlanningInfo.get(cursorIdx);
					if (plan) {
						baseAccessPlan = Object.freeze(plan);
					} else {
						errorLog(`Failed to get base access plan for cursor ${cursorIdx} (alias: ${alias}).`);
						// Keep defaults, but log error
					}
				}
				// Only update estimates if baseAccessPlan was successfully obtained
				if (baseAccessPlan) {
					estimatedRows = baseAccessPlan.rows;
					estimatedCost = baseAccessPlan.cost;
				}
			} else {
				// For Subqueries/Functions, try to get initial plan info if available
				const initialPlan = this.compiler.cursorPlanningInfo.get(cursorIdx);
				if (initialPlan) {
					log(`Found initial plan for non-table source ${alias} (cursor ${cursorIdx})`);
					// Store it in baseAccessPlan for use in costing later
					baseAccessPlan = Object.freeze(initialPlan);
					estimatedRows = initialPlan.rows;
					estimatedCost = initialPlan.cost;
				} else {
					log(`Using default cost/row estimates for non-table source: ${alias}`);
					// baseAccessPlan remains null, use high defaults assigned earlier
				}
			}

			const relation: QueryRelation = {
				id: relationId,
				alias: alias,
				contributingCursors: new Set([cursorIdx]), // Initially just the source's cursor
				estimatedRows: estimatedRows, // Use the final determined value
				estimatedCost: estimatedCost, // Use the final determined value
				baseAccessPlan: baseAccessPlan,
				schema: Object.freeze(tableSchema),
				sourceAstNode: sourceAstNode, // Link back to the AST node
			};

			this.relations.set(relationId, relation);
			this.sourceAliasToRelationId.set(alias, relationId);
			processedAliases.add(alias); // Mark alias as processed
			log(`Created relation: ${relationId} (Type: ${source.type}, Alias: ${alias}, EstRows: ${relation.estimatedRows}, EstCost: ${relation.estimatedCost.toFixed(2)}, BasePlan: ${!!baseAccessPlan})`);
		};

		// Process all top-level sources recursively to populate the relations map
		fromSources.forEach(processSourceRecursive);

		// 2. Extract Join Conditions from AST
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
					// Directly use the value from the plan returned by xBestIndex
					orderByConsumed: relation.baseAccessPlan.orderByConsumed
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

	/**
	 * Estimates the cost and row count for accessing a single relation, potentially recursively.
	 * @param relation The relation to estimate.
	 * @param outerCursors Cursors available from the outer context (used for correlated subqueries).
	 * @param predicate Optional predicate pushed down from the outer query.
	 * @returns Estimated cost and rows.
	 */
	private _estimateRelationCost(
		relation: QueryRelation,
		outerCursors: ReadonlySet<number>,
		predicate?: AST.Expression
	): { cost: number, rows: bigint, handledPredicate: AST.Expression | null } {
		// TODO: Add caching

		let currentCost: number = relation.estimatedCost;
		let currentRows: bigint = relation.estimatedRows;
		let handledPredicate: AST.Expression | null = null;

		const initialPlan = relation.baseAccessPlan; // Use the potentially stored initial plan
		if (initialPlan) {
			currentCost = initialPlan.cost;
			currentRows = initialPlan.rows;
		}

		if (relation.sourceAstNode?.type === 'table') {
			// TODO: Handle predicate pushdown for base tables (needs replanning?)
			if (predicate && expressionReferencesOnlyAllowedCursors(this.compiler, predicate, relation.contributingCursors)) {
				warnLog(`Predicate pushdown for base table ${relation.alias} requested but not fully implemented for costing.`);
				// Heuristic: Apply cost/row reduction if predicate likely selective
				// This is a guess!
				if (predicate.type === 'binary' && ['=', '==', '<', '<=', '>', '>='].includes(predicate.operator.toUpperCase())){
					currentCost *= 0.2;
					currentRows = BigInt(Math.max(1, Math.round(Number(currentRows) * 0.1)));
					handledPredicate = predicate; // Tentatively mark as handled
					log(`Applied heuristic cost reduction for pushed predicate on table ${relation.alias}`);
				}
			}
		} else if (relation.sourceAstNode?.type === 'subquerySource') {
			const subqueryNode = relation.sourceAstNode as AST.SubquerySource;
			let subquerySelect = subqueryNode.subquery;
			let subqueryRequiresRecursiveCost = false;

			if (predicate) {
				if (expressionReferencesOnlyAllowedCursors(this.compiler, predicate, relation.contributingCursors)) {
					log(`Predicate pushdown eligible for subquery ${relation.alias}.`);
					const newWhere: AST.Expression = subquerySelect.where
						? { type: 'binary', operator: 'AND', left: predicate, right: subquerySelect.where }
						: predicate;
					subquerySelect = { ...subquerySelect, where: newWhere };
					handledPredicate = predicate; // Mark as handled
					subqueryRequiresRecursiveCost = true;
				} else {
					log(`Predicate cannot be fully pushed down into subquery ${relation.alias}`);
				}
			}

			// --- Call Subquery Cost Estimator --- //
			// Pass the potentially modified subquerySelect
			// The helper currently uses heuristics, but this is where recursive planning would go.
			const estimatedSubquery = estimateSubqueryCost(this.compiler, subquerySelect, outerCursors);
			currentCost = estimatedSubquery.cost;
			currentRows = estimatedSubquery.rows;
			log(`Subquery ${relation.alias} estimated cost: ${currentCost.toFixed(2)}, rows: ${currentRows}`);
			// ------------------------------------ //

		} else if (relation.sourceAstNode?.type === 'functionSource') {
			log(`Estimating cost for TVF relation: ${relation.alias}`);
			// Return initial estimates, pushdown not handled for TVFs yet.
		}

		// Return final calculated/estimated cost, rows, and potentially handled predicate
		return { cost: currentCost, rows: currentRows, handledPredicate: handledPredicate };
	}

	/** Estimates the cost of a potential join and returns details if feasible */
	private _costJoinCandidate(
		joinInfo: JoinCandidateInfo,
		leftRel: QueryRelation,
		rightRel: QueryRelation
	): { cost: number, resultRelation: QueryRelation, stepDetails: Omit<PlannedJoinStep, 'type'> } | null {

		log(`Costing join: ${leftRel.id} ${joinInfo.joinType} ${rightRel.id}`);

		// --- Get potentially recursive cost estimates for operands --- //
		// Pass the join condition as a potential predicate to push down
		// Collect handled predicates
		const handledPredicates: AST.Expression[] = [];
		const leftCostResult = this._estimateRelationCost(leftRel, this.outerCursors, joinInfo.condition ?? undefined);
		if (leftCostResult.handledPredicate) handledPredicates.push(leftCostResult.handledPredicate);
		const rightCostResult = this._estimateRelationCost(rightRel, this.outerCursors, joinInfo.condition ?? undefined);
		if (rightCostResult.handledPredicate) handledPredicates.push(rightCostResult.handledPredicate);

		// --- 1. Estimate Result Cardinality --- //
		const selectivity = Math.max(0, Math.min(1, joinInfo.estimatedSelectivity));
		let estimatedResultRows = BigInt(Math.round(Number(leftCostResult.rows) * Number(rightCostResult.rows) * selectivity));
		if (estimatedResultRows < 1n) estimatedResultRows = 1n;

		// --- 2. Cost Nested Loop: Left Outer, Right Inner --- //
		let costLeftOuter = Infinity;
		let innerPlanRight: CursorPlanningResult | null = null;
		const innerCursorRight = [...rightRel.contributingCursors][0];
		if (innerCursorRight !== undefined) {
			const innerSchemaRight = this.compiler.tableSchemas.get(innerCursorRight);
			if (innerSchemaRight) {
				this.compiler.planTableAccess(
					innerCursorRight,
					innerSchemaRight,
					this.stmt,
					new Set([...this.outerCursors, ...leftRel.contributingCursors]),
					joinInfo.condition ?? undefined
				);
				innerPlanRight = this.compiler.cursorPlanningInfo.get(innerCursorRight)!;
				if (innerPlanRight) {
					costLeftOuter = leftCostResult.cost + Number(leftCostResult.rows) * innerPlanRight.cost;
					log(` -> Cost LeftOuter: ${leftCostResult.cost.toFixed(2)} + ${leftCostResult.rows} * ${innerPlanRight.cost.toFixed(2)} = ${costLeftOuter.toFixed(2)}`);
				} else {
					errorLog(`Failed to get inner plan for right side (cursor ${innerCursorRight}) in LeftOuter scenario.`);
				}
			}
		}

		// --- 3. Cost Nested Loop: Right Outer, Left Inner --- //
		let costRightOuter = Infinity;
		let innerPlanLeft: CursorPlanningResult | null = null;
		const innerCursorLeft = [...leftRel.contributingCursors][0];
		if (innerCursorLeft !== undefined) {
			const innerSchemaLeft = this.compiler.tableSchemas.get(innerCursorLeft);
			if (innerSchemaLeft) {
				this.compiler.planTableAccess(
					innerCursorLeft,
					innerSchemaLeft,
					this.stmt,
					new Set([...this.outerCursors, ...rightRel.contributingCursors]),
					joinInfo.condition ?? undefined
				);
				innerPlanLeft = this.compiler.cursorPlanningInfo.get(innerCursorLeft)!;
				if (innerPlanLeft) {
					costRightOuter = rightCostResult.cost + Number(rightCostResult.rows) * innerPlanLeft.cost;
					log(` -> Cost RightOuter: ${rightCostResult.cost.toFixed(2)} + ${rightCostResult.rows} * ${innerPlanLeft.cost.toFixed(2)} = ${costRightOuter.toFixed(2)}`);
				} else {
					errorLog(`Failed to get inner plan for left side (cursor ${innerCursorLeft}) in RightOuter scenario.`);
				}
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
			if (!innerPlanLeft) return null;
			bestCost = costRightOuter;
			chosenOuterRel = rightRel;
			chosenInnerRel = leftRel;
			chosenInnerPlan = innerPlanLeft;
			log(` -> Chosen: Right Outer (Cost: ${bestCost.toFixed(2)})`);
		}

		// --- 5. Construct Result Relation and Step Details --- //
		const combinedCursors = new Set([...chosenOuterRel.contributingCursors, ...chosenInnerRel.contributingCursors]);
		const resultRelationId = generateRelationId(combinedCursors);
		const resultSchema = chosenOuterRel.schema; // Placeholder schema
		warnLog(`Result schema for join ${resultRelationId} is using outer schema as placeholder.`);

		const resultRelation: QueryRelation = {
			id: resultRelationId,
			alias: `join_${chosenOuterRel.alias}_${chosenInnerRel.alias}`,
			contributingCursors: combinedCursors,
			estimatedRows: estimatedResultRows,
			estimatedCost: bestCost,
			baseAccessPlan: null,
			schema: resultSchema,
			// sourceAstNode is null for derived join relations
		};

		const stepDetails: Omit<PlannedJoinStep, 'type'> = {
			outputRelation: Object.freeze(resultRelation),
			joinType: joinInfo.joinType,
			leftInputStep: this.findStepProducingRelation(leftRel.id),
			rightInputStep: this.findStepProducingRelation(rightRel.id),
			condition: joinInfo.condition,
			outerStep: this.findStepProducingRelation(chosenOuterRel.id),
			innerStep: this.findStepProducingRelation(chosenInnerRel.id),
			innerLoopPlan: Object.freeze(chosenInnerPlan),
			preservesOuterOrder: true,
			handledPredicates: Object.freeze(handledPredicates) // <-- Store handled predicates
		};

		return { cost: bestCost, resultRelation, stepDetails };
	}
}
