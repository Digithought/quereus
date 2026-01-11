/**
 * Key builder utilities for constructing storage keys.
 *
 * Storage naming convention:
 *   {schema}.{table}              - Data store (row data)
 *   {schema}.{table}_idx_{name}   - Index store (secondary indexes)
 *   {schema}.{table}_stats        - Stats store (row count, etc.)
 *   __catalog__                   - Catalog store (DDL metadata)
 *
 * Within each store, keys are minimal:
 *   - Data store: just the encoded primary key
 *   - Index store: encoded index columns + encoded primary key
 *   - Stats store: single empty key (stats is the only value)
 *   - Catalog store: {schema}.{table} as the key
 */

import type { SqlValue } from '@quereus/quereus';
import { encodeCompositeKey, type EncodeOptions } from './encoding.js';

const encoder = new TextEncoder();

/**
 * Store name suffixes for different data types.
 */
export const STORE_SUFFIX = {
	INDEX: '_idx_',
	STATS: '_stats',
} as const;

/** Reserved catalog store name. */
export const CATALOG_STORE_NAME = '__catalog__';

/** Reserved stats store name. */
export const STATS_STORE_NAME = '__stats__';

/**
 * Build the store name for a table's data.
 * Format: {schema}.{table}
 */
export function buildDataStoreName(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}`.toLowerCase();
}

/**
 * Build the store name for a secondary index.
 * Format: {schema}.{table}_idx_{indexName}
 */
export function buildIndexStoreName(
	schemaName: string,
	tableName: string,
	indexName: string
): string {
	return `${schemaName}.${tableName}_idx_${indexName}`.toLowerCase();
}

/**
 * Build the store name for table statistics.
 * @deprecated Stats are now stored in the unified __stats__ store. Use buildStatsKey instead.
 * Format: {schema}.{table}_stats
 */
export function buildStatsStoreName(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}_stats`.toLowerCase();
}

/**
 * Build a stats key for use in the unified __stats__ store.
 * Format: {schema}.{table}
 */
export function buildStatsKey(schemaName: string, tableName: string): Uint8Array {
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/**
 * Build a data row key (just the encoded primary key).
 */
export function buildDataKey(pkValues: SqlValue[], options?: EncodeOptions): Uint8Array {
	return encodeCompositeKey(pkValues, options);
}

/**
 * Build a secondary index key.
 * Format: {encoded_index_cols}{encoded_pk}
 *
 * The index columns come first for range scans, followed by PK for uniqueness.
 */
export function buildIndexKey(
	indexValues: SqlValue[],
	pkValues: SqlValue[],
	options?: EncodeOptions
): Uint8Array {
	const indexEncoded = encodeCompositeKey(indexValues, options);
	const pkEncoded = encodeCompositeKey(pkValues, options);
	return concatBytes(indexEncoded, pkEncoded);
}

/**
 * Build a catalog key for DDL storage.
 * Format: {schema}.{table}
 */
export function buildCatalogKey(schemaName: string, tableName: string): Uint8Array {
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/**
 * Build range bounds for scanning all rows in a data store.
 * Since keys are just encoded PKs, we scan the entire store.
 */
export function buildFullScanBounds(): { gte: Uint8Array; lt: Uint8Array } {
	return {
		gte: new Uint8Array(0),
		lt: new Uint8Array([0xff]), // All valid encoded keys are < 0xff
	};
}

/**
 * Build range bounds for scanning an index with a prefix.
 */
export function buildIndexPrefixBounds(
	prefixValues: SqlValue[],
	options?: EncodeOptions
): { gte: Uint8Array; lt: Uint8Array } {
	if (prefixValues.length === 0) {
		return buildFullScanBounds();
	}

	const prefixEncoded = encodeCompositeKey(prefixValues, options);
	return {
		gte: prefixEncoded,
		lt: incrementLastByte(prefixEncoded),
	};
}

/**
 * Build range bounds for scanning catalog entries.
 * Optionally filter by schema prefix.
 */
export function buildCatalogScanBounds(schemaName?: string): { gte: Uint8Array; lt: Uint8Array } {
	if (schemaName) {
		const prefix = `${schemaName}.`.toLowerCase();
		return {
			gte: encoder.encode(prefix),
			lt: incrementLastByte(encoder.encode(prefix)),
		};
	}
	return {
		gte: new Uint8Array(0),
		lt: new Uint8Array([0xff]),
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

// ============================================================================
// Legacy exports for backwards compatibility during migration
// These will be removed after all consumers are updated.
// ============================================================================

/** @deprecated Use buildDataStoreName instead */
export const KEY_PREFIX = {
	DATA: encoder.encode('d:'),
	INDEX: encoder.encode('i:'),
	META: encoder.encode('m:'),
} as const;

/** @deprecated Use buildDataKey instead */
export function buildTablePrefix(
	_prefix: 'd' | 'i' | 'm',
	schemaName: string,
	tableName: string
): Uint8Array {
	return encoder.encode(`${schemaName}.${tableName}`.toLowerCase());
}

/** @deprecated Use buildFullScanBounds instead */
export function buildTableScanBounds(
	_schemaName: string,
	_tableName: string
): { gte: Uint8Array; lt: Uint8Array } {
	return buildFullScanBounds();
}

/** @deprecated Use buildIndexPrefixBounds instead */
export function buildIndexScanBounds(
	_schemaName: string,
	_tableName: string,
	_indexName: string,
	prefixValues?: SqlValue[],
	options?: EncodeOptions
): { gte: Uint8Array; lt: Uint8Array } {
	return buildIndexPrefixBounds(prefixValues || [], options);
}

/** @deprecated Use buildCatalogKey instead */
export function buildMetaKey(
	_metaType: 'ddl' | 'stats' | 'index',
	schemaName: string,
	objectName: string,
	_subName?: string
): Uint8Array {
	return buildCatalogKey(schemaName, objectName);
}

/** @deprecated Use buildCatalogScanBounds instead */
export function buildMetaScanBounds(
	_metaType: 'ddl' | 'stats' | 'index',
	schemaName?: string
): { gte: Uint8Array; lt: Uint8Array } {
	return buildCatalogScanBounds(schemaName);
}
