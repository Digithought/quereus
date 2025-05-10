import type { Database } from '../core/database.js';
import type { Scope } from './scope.js';
import type { SchemaManager } from '../schema/manager.js';

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
}
