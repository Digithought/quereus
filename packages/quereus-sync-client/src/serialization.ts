/**
 * Serialization helpers for ChangeSet transport over JSON.
 *
 * - SiteIds use base64url encoding (via siteIdToBase64/siteIdFromBase64)
 * - HLCs use standard base64 encoding (via btoa/atob in browser, Buffer in Node)
 */

import {
  serializeHLC,
  deserializeHLC,
  siteIdToBase64,
  siteIdFromBase64,
  type ChangeSet,
  type Change,
  type SchemaMigration,
  type HLC,
} from '@quereus/plugin-sync';
import type { SerializedChangeSet } from './types.js';

// ============================================================================
// Base64 helpers (work in both browser and Node.js)
// ============================================================================

/**
 * Encode bytes to base64 string.
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Browser: use btoa
  if (typeof btoa === 'function') {
    return btoa(String.fromCharCode(...bytes));
  }
  // Node.js: use Buffer
  return Buffer.from(bytes).toString('base64');
}

/**
 * Decode base64 string to bytes.
 */
function base64ToBytes(str: string): Uint8Array {
  // Browser: use atob
  if (typeof atob === 'function') {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  }
  // Node.js: use Buffer
  return new Uint8Array(Buffer.from(str, 'base64'));
}

// ============================================================================
// ChangeSet Serialization
// ============================================================================

/**
 * Serialize a ChangeSet for JSON transport.
 *
 * @param cs - The ChangeSet to serialize
 * @returns A JSON-serializable object
 */
export function serializeChangeSet(cs: ChangeSet): SerializedChangeSet {
  return {
    siteId: siteIdToBase64(cs.siteId),
    transactionId: cs.transactionId,
    hlc: bytesToBase64(serializeHLC(cs.hlc)),
    changes: cs.changes.map(c => ({
      ...c,
      hlc: bytesToBase64(serializeHLC(c.hlc)),
    })),
    schemaMigrations: cs.schemaMigrations.map(m => ({
      ...m,
      hlc: bytesToBase64(serializeHLC(m.hlc)),
    })),
  };
}

/**
 * Deserialize a ChangeSet from JSON transport format.
 *
 * @param obj - The serialized ChangeSet object
 * @returns The deserialized ChangeSet
 */
export function deserializeChangeSet(obj: SerializedChangeSet): ChangeSet {
  return {
    siteId: siteIdFromBase64(obj.siteId),
    transactionId: obj.transactionId,
    hlc: deserializeHLC(base64ToBytes(obj.hlc)),
    changes: obj.changes.map(c => ({
      ...c,
      hlc: deserializeHLC(base64ToBytes(c.hlc)),
    })) as Change[],
    schemaMigrations: obj.schemaMigrations.map(m => ({
      ...m,
      hlc: deserializeHLC(base64ToBytes(m.hlc)),
    })) as SchemaMigration[],
  };
}

/**
 * Serialize an HLC for transport (base64 encoding).
 *
 * @param hlc - The HLC to serialize
 * @returns Base64-encoded string
 */
export function serializeHLCForTransport(hlc: HLC): string {
  return bytesToBase64(serializeHLC(hlc));
}

/**
 * Deserialize an HLC from transport format.
 *
 * @param str - Base64-encoded HLC string
 * @returns The deserialized HLC
 */
export function deserializeHLCFromTransport(str: string): HLC {
  return deserializeHLC(base64ToBytes(str));
}

