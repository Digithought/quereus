import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import type { IndexConstraint } from '../../vtab/indexInfo.js';
import type { CursorPlanningResult } from '../structs.js';

/** Result type for constraint extraction */
export interface ConstraintExtractionResult {
	constraints: IndexConstraint[];
	constraintExpressions: Map<number, AST.Expression>;
	handledNodes: Set<AST.Expression>;
}

/** Represents a data source (base table or intermediate result) during query planning. */
export interface QueryRelation {
	/** Unique identifier for this relation within the plan. Can be complex for joins. */
	readonly id: string;
	/** User-facing alias (or table name if no alias). Lowercase. */
	readonly alias: string;
	/** The set of base table cursor indices contributing to this relation. */
	readonly contributingCursors: ReadonlySet<number>;
	/** Estimated number of rows produced by this relation. */
	estimatedRows: bigint;
	/** Estimated computational cost to produce all rows of this relation. */
	estimatedCost: number;
	/** The plan chosen by planTableAccessHelper if this is a base table scan. */
	readonly baseAccessPlan: Readonly<CursorPlanningResult> | null;
	/** Schema describing the columns available from this relation. */
	readonly schema: Readonly<TableSchema>; // Could be base schema or derived for joins

	/** Optional reference back to the AST node that defined this relation (table, subquery, function). */
	readonly sourceAstNode?: Readonly<AST.FromClause>;
}

/** Represents a potential join operation identified from the AST. */
export interface JoinCandidateInfo {
	readonly leftRelationId: QueryRelation['id'];
	readonly rightRelationId: QueryRelation['id'];
	readonly joinType: AST.JoinClause['joinType'] | 'cross'; // Explicitly add 'cross' for implicit joins

	/** The original ON condition expression, if present. */
	readonly condition: Readonly<AST.Expression> | null;
	/** The original USING columns, if present. */
	readonly columns: ReadonlyArray<string> | null;
	/** Heuristic estimate (0.0 to 1.0) of the join condition's filtering effect. */
	estimatedSelectivity: number;
	/** Reference to the original AST node for context. */
	readonly astNode: Readonly<AST.JoinClause> | null; // Null for implicit cross joins
}

/** Represents a chosen step in the final execution plan. */
export type PlannedStep = PlannedScanStep |
	PlannedJoinStep;
// Future: PlannedSubqueryStep, PlannedFunctionStep, PlannedFilterStep etc.
export interface PlannedScanStep {
	readonly type: 'Scan';
	readonly relation: Readonly<QueryRelation>;
	readonly plan: Readonly<CursorPlanningResult>; // Re-iterating plan for clarity

	/** Target VDBE address for the start of this step's loop (e.g., VFilter) */
	loopStartAddr?: number;
	/** Target VDBE address for jumps when the scan/filter ends */
	eofAddr?: number;
	orderByConsumed: boolean;
}

export interface PlannedJoinStep {
	readonly type: 'Join';
	readonly outputRelation: Readonly<QueryRelation>;
	readonly joinType: AST.JoinClause['joinType'] | 'cross';
	/** Reference to the step producing the left input */
	readonly leftInputStep: Readonly<PlannedStep>;
	/** Reference to the step producing the right input */
	readonly rightInputStep: Readonly<PlannedStep>;
	/** The combined ON/USING condition expression. */
	readonly condition: Readonly<AST.Expression> | null;

	// --- Details determined during planning --- //
	/** Which input step provides the outer loop relation. */
	readonly outerStep: Readonly<PlannedStep>;
	/** Which input step provides the inner loop relation. */
	readonly innerStep: PlannedStep;
	/** The access plan for the inner loop (result of planTableAccess with join condition). */
	readonly innerLoopPlan: Readonly<CursorPlanningResult>;

	// --- VDBE State --- //
	/** Target VDBE address for the start of the inner loop */
	loopStartAddr?: number;
	/** Target VDBE address for jumps when the inner loop ends */
	eofAddr?: number;
	/** Target VDBE address for jumps when the join condition fails */
	joinFailAddr?: number;
	/** Register holding match flag for LEFT JOINs */
	matchReg?: number;
	preservesOuterOrder: boolean;
	/** Predicates from the join condition handled by pushed-down estimates */
	handledPredicates?: ReadonlyArray<AST.Expression>;
}
