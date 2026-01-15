/**
 * Database ID utilities for multi-tenant org-based storage.
 *
 * Database IDs use the format: <org_id>:<type>_<id>
 *
 * Types:
 * - a_<id>: Account database (per-user)
 * - s_<id>: Scenario database (design data)
 * - d_<id>: Dynamics database (time-series)
 *
 * Examples:
 * - org123:a_user456 → Account database for user456 in org123
 * - org123:s_abc789 → Scenario database abc789 in org123
 * - org123:d_def012 → Dynamics database def012 in org123
 */

/** Valid database types */
export type DatabaseType = 'account' | 'scenario' | 'dynamics';

/** Type prefixes in database IDs */
const TYPE_PREFIXES: Record<string, DatabaseType> = {
  'a': 'account',
  's': 'scenario',
  'd': 'dynamics',
};

/** Parsed database ID components */
export interface ParsedDatabaseId {
  /** Organization ID */
  orgId: string;
  /** Database type */
  type: DatabaseType;
  /** Database-specific ID (without type prefix) */
  id: string;
  /** Full database part (type_id) */
  dbPart: string;
}

/**
 * Parse a database ID into its components.
 *
 * @param databaseId - Database ID in format <org_id>:<type>_<id>
 * @returns Parsed components
 * @throws Error if format is invalid
 *
 * @example
 * parseDatabaseId('org123:s_abc789')
 * // → { orgId: 'org123', type: 'scenario', id: 'abc789', dbPart: 's_abc789' }
 */
export function parseDatabaseId(databaseId: string): ParsedDatabaseId {
  if (!databaseId || typeof databaseId !== 'string') {
    throw new Error('Database ID is required');
  }

  const colonIndex = databaseId.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid database ID format: missing colon. Expected <org_id>:<type>_<id>, got: ${databaseId}`);
  }

  const orgId = databaseId.slice(0, colonIndex);
  const dbPart = databaseId.slice(colonIndex + 1);

  if (!orgId) {
    throw new Error(`Invalid database ID: org_id cannot be empty`);
  }

  if (!dbPart) {
    throw new Error(`Invalid database ID: database part cannot be empty`);
  }

  // Parse type_id
  const underscoreIndex = dbPart.indexOf('_');
  if (underscoreIndex === -1) {
    throw new Error(`Invalid database ID format: missing underscore in database part. Expected <type>_<id>, got: ${dbPart}`);
  }

  const typePrefix = dbPart.slice(0, underscoreIndex);
  const id = dbPart.slice(underscoreIndex + 1);

  if (!id) {
    throw new Error(`Invalid database ID: id cannot be empty after type prefix`);
  }

  const type = TYPE_PREFIXES[typePrefix];
  if (!type) {
    throw new Error(`Invalid database type prefix: "${typePrefix}". Valid prefixes: a (account), s (scenario), d (dynamics)`);
  }

  return { orgId, type, id, dbPart };
}

/**
 * Get the storage path for a database ID.
 * Returns a path relative to the data directory.
 *
 * @param databaseId - Database ID in format <org_id>:<type>_<id>
 * @returns Storage path: <org_id>/<type>_<id>
 *
 * @example
 * getDatabaseStoragePath('org123:s_abc789')
 * // → 'org123/s_abc789'
 */
export function getDatabaseStoragePath(databaseId: string): string {
  const { orgId, dbPart } = parseDatabaseId(databaseId);
  return `${orgId}/${dbPart}`;
}

/**
 * Build a database ID from components.
 *
 * @param orgId - Organization ID
 * @param type - Database type
 * @param id - Database-specific ID
 * @returns Database ID in format <org_id>:<type>_<id>
 */
export function buildDatabaseId(orgId: string, type: DatabaseType, id: string): string {
  const prefix = Object.entries(TYPE_PREFIXES).find(([, t]) => t === type)?.[0];
  if (!prefix) {
    throw new Error(`Unknown database type: ${type}`);
  }
  return `${orgId}:${prefix}_${id}`;
}

/**
 * Validate a database ID without throwing.
 *
 * @param databaseId - Database ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidDatabaseId(databaseId: string): boolean {
  try {
    parseDatabaseId(databaseId);
    return true;
  } catch {
    return false;
  }
}

