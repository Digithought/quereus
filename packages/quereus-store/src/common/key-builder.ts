/**
 * Key builder utilities for constructing storage keys.
 * 
 * Key prefixes:
 *   d: - Data rows
 *   i: - Secondary indexes
 *   m: - Metadata (DDL, stats)
 */

import type { SqlValue } from '@quereus/quereus';
import { encodeCompositeKey, type EncodeOptions } from './encoding.js';

const encoder = new TextEncoder();

/** Key prefix bytes. */
export const KEY_PREFIX = {
  DATA: encoder.encode('d:'),
  INDEX: encoder.encode('i:'),
  META: encoder.encode('m:'),
} as const;

/** Separator between key components. */
const SEPARATOR = encoder.encode(':');

/**
 * Build a data row key.
 * Format: d:{schema}.{table}:{encoded_pk}
 */
export function buildDataKey(
  schemaName: string,
  tableName: string,
  pkValues: SqlValue[],
  options?: EncodeOptions
): Uint8Array {
  const tablePrefix = buildTablePrefix('d', schemaName, tableName);
  const pkEncoded = encodeCompositeKey(pkValues, options);
  
  return concatBytes(tablePrefix, SEPARATOR, pkEncoded);
}

/**
 * Build a secondary index key.
 * Format: i:{schema}.{table}.{indexName}:{encoded_index_cols}:{encoded_pk}
 */
export function buildIndexKey(
  schemaName: string,
  tableName: string,
  indexName: string,
  indexValues: SqlValue[],
  pkValues: SqlValue[],
  options?: EncodeOptions
): Uint8Array {
  const prefix = encoder.encode(`i:${schemaName}.${tableName}.${indexName}:`);
  const indexEncoded = encodeCompositeKey(indexValues, options);
  const pkEncoded = encodeCompositeKey(pkValues, options);
  
  return concatBytes(prefix, indexEncoded, SEPARATOR, pkEncoded);
}

/**
 * Build a metadata key.
 * Format: m:{type}:{schema}.{name}
 */
export function buildMetaKey(
  metaType: 'ddl' | 'stats' | 'index',
  schemaName: string,
  objectName: string,
  subName?: string
): Uint8Array {
  let key = `m:${metaType}:${schemaName}.${objectName}`;
  if (subName) {
    key += `#${subName}`;
  }
  return encoder.encode(key);
}

/**
 * Build a table prefix for range scans.
 * Format: {prefix}:{schema}.{table}
 */
export function buildTablePrefix(
  prefix: 'd' | 'i' | 'm',
  schemaName: string,
  tableName: string
): Uint8Array {
  return encoder.encode(`${prefix}:${schemaName}.${tableName}`);
}

/**
 * Build range bounds for scanning all rows of a table.
 */
export function buildTableScanBounds(
  schemaName: string,
  tableName: string
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `d:${schemaName}.${tableName}:`;
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * Build range bounds for scanning an index.
 */
export function buildIndexScanBounds(
  schemaName: string,
  tableName: string,
  indexName: string,
  prefixValues?: SqlValue[],
  options?: EncodeOptions
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `i:${schemaName}.${tableName}.${indexName}:`;
  const prefixBytes = encoder.encode(prefix);
  
  if (prefixValues && prefixValues.length > 0) {
    const valueBytes = encodeCompositeKey(prefixValues, options);
    const gte = concatBytes(prefixBytes, valueBytes);
    return {
      gte,
      lt: incrementLastByte(gte),
    };
  }
  
  return {
    gte: prefixBytes,
    lt: incrementLastByte(prefixBytes),
  };
}

/**
 * Build range bounds for scanning all metadata of a type.
 */
export function buildMetaScanBounds(
  metaType: 'ddl' | 'stats' | 'index',
  schemaName?: string
): { gte: Uint8Array; lt: Uint8Array } {
  let prefix = `m:${metaType}:`;
  if (schemaName) {
    prefix += `${schemaName}.`;
  }
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
  
  // Increment from the end, handling overflow
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i] < 0xff) {
      result[i]++;
      return result;
    }
    result[i] = 0;
  }
  
  // All bytes were 0xff, append 0x00
  const extended = new Uint8Array(result.length + 1);
  extended.set(result);
  return extended;
}

/**
 * Concatenate multiple byte arrays.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

