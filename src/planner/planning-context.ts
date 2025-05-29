import type { SqlParameters } from '../common/types.js';
import type { Database } from '../core/database.js';
import type { SchemaManager } from '../schema/manager.js';
import type { Scope } from './scopes/scope.js';
import type { ScalarPlanNode } from './nodes/plan-node.js';

/**
 * Debug options for query planning and execution.
 */
export interface DebugOptions {
  /** Enable runtime instruction tracing (logs inputs/outputs) */
  traceInstructions?: boolean;
  /** Enable detailed plan tree output */
  showPlan?: boolean;
  /** Enable instruction program output */
  showProgram?: boolean;
  /** Custom debug context for additional logging */
  debugContext?: Record<string, any>;
}

/**
 * Provides contextual information necessary during the query planning phase.
 * This object is passed to various planning functions to give them access to
 * the database schema, current symbol resolution scope, and other relevant details.
 */
export interface PlanningContext {
  /**
   * The Database instance, providing access to the schema manager, function registry, etc.
   */
  readonly db: Database;

  /**
   * The SchemaManager instance, for direct access if needed (also available via db.schemaManager).
   */
  readonly schemaManager: SchemaManager; // Redundant if db is present, but can be convenient

  /**
   * The current Scope for symbol resolution (columns, parameters, CTEs).
   * Planning functions for nested structures (like subqueries) will typically create a new Scope
   * with the current scope as its parent and pass that down in a new PlanningContext.
   */
  readonly scope: Scope;

	/**
	 * The current parameters for the statement, as discovered by references.
	 */
	readonly parameters: SqlParameters;

  /**
   * Debug options controlling tracing and diagnostics output.
   */
  readonly debug?: DebugOptions;

  /**
   * Aggregates from the SELECT list (used when building HAVING expressions).
   * This allows buildExpression to recognize when an aggregate function in HAVING
   * refers to an already-computed aggregate from SELECT.
   */
  readonly aggregates?: Array<{
    expression: ScalarPlanNode;
    alias: string;
    columnIndex: number;
  }>;
}
