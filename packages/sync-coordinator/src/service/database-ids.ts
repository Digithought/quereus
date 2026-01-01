/**
 * Database ID utilities for multi-tenant sync
 *
 * Database ID format: {accountId}-{dbType}{dbNum}
 * - accountId: Short system-assigned ID (e.g., 'a1', 'b7', 'z42')
 * - dbType: 's' for scenario, 'd' for dynamics, 'a' for account
 * - dbNum: Short numeric ID scoped under account (e.g., '1', '42')
 *
 * Examples:
 * - 'a1-s1' = account a1's scenario 1
 * - 'a1-d1' = account a1's dynamics 1 (same site as s1)
 * - 'a1-acc' = account a1's account database
 * - 'b7-s42' = account b7's scenario 42
 */

// Base62 alphabet for short IDs (lowercase first for nicer URLs)
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Parse a database ID into its components.
 */
export interface ParsedDatabaseId {
  accountId: string;
  dbType: 'scenario' | 'dynamics' | 'account';
  dbNum?: number; // undefined for account database
}

/**
 * Parse a database ID string.
 * @throws if the format is invalid
 */
export function parseDatabaseId(databaseId: string): ParsedDatabaseId {
  const parts = databaseId.split('-');
  if (parts.length !== 2) {
    throw new Error(`Invalid database ID format: ${databaseId}`);
  }

  const [accountId, dbPart] = parts;

  if (!accountId || accountId.length === 0) {
    throw new Error(`Invalid account ID in database ID: ${databaseId}`);
  }

  // Account database: "acc"
  if (dbPart === 'acc') {
    return { accountId, dbType: 'account' };
  }

  // Scenario or dynamics: "s1", "d42", etc.
  const typeChar = dbPart[0];
  const numStr = dbPart.slice(1);

  if (typeChar !== 's' && typeChar !== 'd') {
    throw new Error(`Invalid database type in database ID: ${databaseId}`);
  }

  const dbNum = parseInt(numStr, 10);
  if (isNaN(dbNum) || dbNum < 1) {
    throw new Error(`Invalid database number in database ID: ${databaseId}`);
  }

  return {
    accountId,
    dbType: typeChar === 's' ? 'scenario' : 'dynamics',
    dbNum,
  };
}

/**
 * Format a database ID from components.
 */
export function formatDatabaseId(
  accountId: string,
  dbType: 'scenario' | 'dynamics' | 'account',
  dbNum?: number
): string {
  if (dbType === 'account') {
    return `${accountId}-acc`;
  }
  if (dbNum === undefined) {
    throw new Error(`dbNum required for ${dbType} database`);
  }
  const typeChar = dbType === 'scenario' ? 's' : 'd';
  return `${accountId}-${typeChar}${dbNum}`;
}

/**
 * Encode a number as a short base62 string.
 * e.g., 0 -> 'a', 61 -> '9', 62 -> 'ba'
 */
export function numberToBase62(num: number): string {
  if (num < 0) throw new Error('Number must be non-negative');
  if (num === 0) return BASE62[0];

  let result = '';
  while (num > 0) {
    result = BASE62[num % 62] + result;
    num = Math.floor(num / 62);
  }
  return result;
}

/**
 * Decode a base62 string to a number.
 */
export function base62ToNumber(str: string): number {
  let num = 0;
  for (const char of str) {
    const idx = BASE62.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base62 character: ${char}`);
    num = num * 62 + idx;
  }
  return num;
}

/**
 * Generate a short account ID.
 * Format: single letter prefix + base62 number
 * e.g., 'a1', 'a42', 'b1', 'z999'
 *
 * The counter should be stored and incremented by the coordinator.
 */
export function generateAccountId(counter: number): string {
  // Use lowercase letter prefix (a-z) based on counter / 1000
  // This gives us 26,000 accounts per letter, expandable
  const prefixIdx = Math.floor(counter / 1000) % 26;
  const prefix = String.fromCharCode(97 + prefixIdx); // 'a' = 97
  const suffix = counter % 1000;
  return `${prefix}${suffix + 1}`; // +1 to make it 1-based
}

/**
 * Get storage path for a database.
 * Returns the directory path relative to the data root.
 */
export function getDatabaseStoragePath(databaseId: string): string {
  const parsed = parseDatabaseId(databaseId);
  // Store under account ID directory
  return `${parsed.accountId}/${databaseId}`;
}

/**
 * Validate a database ID format.
 */
export function isValidDatabaseId(databaseId: string): boolean {
  try {
    parseDatabaseId(databaseId);
    return true;
  } catch {
    return false;
  }
}

