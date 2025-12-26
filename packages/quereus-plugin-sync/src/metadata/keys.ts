/**
 * Key builders for CRDT metadata storage.
 *
 * Key prefixes (sync-specific):
 *   cv: - Column versions (HLC per column per row)
 *   tb: - Tombstones (deleted row markers)
 *   tx: - Transaction records
 *   ps: - Peer sync state
 *   sm: - Schema migrations
 *   si: - Site identity
 *   hc: - HLC clock state
 */

import type { SqlValue } from '@quereus/quereus';
import type { SiteId } from '../clock/site.js';

const encoder = new TextEncoder();

/** Key prefix bytes for sync metadata. */
export const SYNC_KEY_PREFIX = {
  COLUMN_VERSION: encoder.encode('cv:'),
  TOMBSTONE: encoder.encode('tb:'),
  TRANSACTION: encoder.encode('tx:'),
  PEER_STATE: encoder.encode('ps:'),
  SCHEMA_MIGRATION: encoder.encode('sm:'),
  SITE_IDENTITY: encoder.encode('si:'),
  HLC_STATE: encoder.encode('hc:'),
} as const;

/** Separator between key components. */
const SEPARATOR = ':';

/**
 * Encode a primary key as a string for use in metadata keys.
 * Uses JSON for simplicity and determinism.
 */
export function encodePK(pk: SqlValue[]): string {
  return JSON.stringify(pk);
}

/**
 * Decode a primary key from its string representation.
 */
export function decodePK(encoded: string): SqlValue[] {
  return JSON.parse(encoded) as SqlValue[];
}

/**
 * Build a column version key.
 * Format: cv:{schema}.{table}:{pk_json}:{column}
 */
export function buildColumnVersionKey(
  schemaName: string,
  tableName: string,
  pk: SqlValue[],
  column: string
): Uint8Array {
  const key = `cv:${schemaName}.${tableName}${SEPARATOR}${encodePK(pk)}${SEPARATOR}${column}`;
  return encoder.encode(key);
}

/**
 * Build a tombstone key.
 * Format: tb:{schema}.{table}:{pk_json}
 */
export function buildTombstoneKey(
  schemaName: string,
  tableName: string,
  pk: SqlValue[]
): Uint8Array {
  const key = `tb:${schemaName}.${tableName}${SEPARATOR}${encodePK(pk)}`;
  return encoder.encode(key);
}

/**
 * Build a transaction record key.
 * Format: tx:{transactionId}
 */
export function buildTransactionKey(transactionId: string): Uint8Array {
  return encoder.encode(`tx:${transactionId}`);
}

/**
 * Build a peer sync state key.
 * Format: ps:{siteId_hex}
 */
export function buildPeerStateKey(siteId: SiteId): Uint8Array {
  const hex = Array.from(siteId).map(b => b.toString(16).padStart(2, '0')).join('');
  return encoder.encode(`ps:${hex}`);
}

/**
 * Build a schema migration key.
 * Format: sm:{schema}.{table}:{version}
 */
export function buildSchemaMigrationKey(
  schemaName: string,
  tableName: string,
  version: number
): Uint8Array {
  return encoder.encode(`sm:${schemaName}.${tableName}${SEPARATOR}${version.toString().padStart(10, '0')}`);
}

/**
 * Build scan bounds for all column versions of a row.
 * Returns keys to scan cv:{schema}.{table}:{pk_json}:*
 */
export function buildColumnVersionScanBounds(
  schemaName: string,
  tableName: string,
  pk: SqlValue[]
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `cv:${schemaName}.${tableName}${SEPARATOR}${encodePK(pk)}${SEPARATOR}`;
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * Build scan bounds for all tombstones in a table.
 */
export function buildTombstoneScanBounds(
  schemaName: string,
  tableName: string
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `tb:${schemaName}.${tableName}${SEPARATOR}`;
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * Build scan bounds for all schema migrations of a table.
 */
export function buildSchemaMigrationScanBounds(
  schemaName: string,
  tableName: string
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `sm:${schemaName}.${tableName}${SEPARATOR}`;
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * Increment the last byte of a key to create an exclusive upper bound.
 */
function incrementLastByte(key: Uint8Array): Uint8Array {
  const result = new Uint8Array(key.length);
  result.set(key);
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i] < 255) {
      result[i]++;
      break;
    }
    result[i] = 0;
  }
  return result;
}

