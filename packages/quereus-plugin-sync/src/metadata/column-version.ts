/**
 * Column version tracking for LWW conflict resolution.
 *
 * Each column of each row has an associated HLC timestamp.
 * When merging changes, the column with the higher HLC wins.
 */

import type { SqlValue } from '@quereus/quereus';
import type { KVStore, WriteBatch } from '@quereus/plugin-store';
import { type HLC, serializeHLC, deserializeHLC, compareHLC } from '../clock/hlc.js';
import { buildColumnVersionKey, buildColumnVersionScanBounds } from './keys.js';

/**
 * Column version record stored in the KV store.
 */
export interface ColumnVersion {
  hlc: HLC;
  value: SqlValue;
}

/**
 * Serialize a column version for storage.
 * Format: 26 bytes HLC + JSON value
 */
export function serializeColumnVersion(cv: ColumnVersion): Uint8Array {
  const hlcBytes = serializeHLC(cv.hlc);
  const valueJson = JSON.stringify(cv.value);
  const valueBytes = new TextEncoder().encode(valueJson);

  const result = new Uint8Array(hlcBytes.length + valueBytes.length);
  result.set(hlcBytes, 0);
  result.set(valueBytes, hlcBytes.length);
  return result;
}

/**
 * Deserialize a column version from storage.
 */
export function deserializeColumnVersion(buffer: Uint8Array): ColumnVersion {
  const hlc = deserializeHLC(buffer.slice(0, 26));
  const valueJson = new TextDecoder().decode(buffer.slice(26));
  const value = JSON.parse(valueJson) as SqlValue;
  return { hlc, value };
}

/**
 * Column version store operations.
 */
export class ColumnVersionStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Get the version of a specific column.
   */
  async getColumnVersion(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string
  ): Promise<ColumnVersion | undefined> {
    const key = buildColumnVersionKey(schemaName, tableName, pk, column);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializeColumnVersion(data);
  }

  /**
   * Set the version of a specific column.
   */
  async setColumnVersion(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string,
    version: ColumnVersion
  ): Promise<void> {
    const key = buildColumnVersionKey(schemaName, tableName, pk, column);
    await this.kv.put(key, serializeColumnVersion(version));
  }

  /**
   * Set column version in a batch.
   */
  setColumnVersionBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string,
    version: ColumnVersion
  ): void {
    const key = buildColumnVersionKey(schemaName, tableName, pk, column);
    batch.put(key, serializeColumnVersion(version));
  }

  /**
   * Get all column versions for a row.
   */
  async getRowVersions(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<Map<string, ColumnVersion>> {
    const bounds = buildColumnVersionScanBounds(schemaName, tableName, pk);
    const versions = new Map<string, ColumnVersion>();

    for await (const entry of this.kv.iterate(bounds)) {
      // Extract column name from key
      const keyStr = new TextDecoder().decode(entry.key);
      const lastColon = keyStr.lastIndexOf(':');
      const column = keyStr.slice(lastColon + 1);

      versions.set(column, deserializeColumnVersion(entry.value));
    }

    return versions;
  }

  /**
   * Delete all column versions for a row.
   */
  async deleteRowVersions(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<void> {
    const bounds = buildColumnVersionScanBounds(schemaName, tableName, pk);
    const batch = this.kv.batch();

    for await (const entry of this.kv.iterate(bounds)) {
      batch.delete(entry.key);
    }

    await batch.write();
  }

  /**
   * Check if a column write should be applied (LWW comparison).
   * Returns true if the incoming HLC is newer than the current version.
   */
  async shouldApplyWrite(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string,
    incomingHLC: HLC
  ): Promise<boolean> {
    const current = await this.getColumnVersion(schemaName, tableName, pk, column);
    if (!current) return true;
    return compareHLC(incomingHLC, current.hlc) > 0;
  }
}

