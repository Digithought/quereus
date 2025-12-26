/**
 * Site ID management - unique identifier for each replica.
 *
 * Site IDs are 16-byte UUIDs that uniquely identify a replica in the
 * distributed system. They are used for:
 * - Breaking ties in HLC comparison
 * - Tracking which changes came from which replica
 * - Peer-to-peer sync state tracking
 */

/**
 * 16-byte unique identifier for a replica.
 */
export type SiteId = Uint8Array;

/**
 * Generate a new random site ID (UUID v4).
 */
export function generateSiteId(): SiteId {
  const id = new Uint8Array(16);

  // Use crypto.getRandomValues if available (browser and Node 19+)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(id);
  } else {
    // Fallback for older Node.js
    for (let i = 0; i < 16; i++) {
      id[i] = Math.floor(Math.random() * 256);
    }
  }

  // Set version to 4 (random UUID)
  id[6] = (id[6] & 0x0f) | 0x40;
  // Set variant to RFC 4122
  id[8] = (id[8] & 0x3f) | 0x80;

  return id;
}

/**
 * Convert site ID to hex string for display.
 */
export function siteIdToHex(siteId: SiteId): string {
  return Array.from(siteId)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parse site ID from hex string.
 */
export function siteIdFromHex(hex: string): SiteId {
  if (hex.length !== 32) {
    throw new Error(`Invalid site ID hex length: ${hex.length}, expected 32`);
  }

  const id = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    id[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return id;
}

/**
 * Format site ID as UUID string (8-4-4-4-12 format).
 */
export function siteIdToUUID(siteId: SiteId): string {
  const hex = siteIdToHex(siteId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Parse site ID from UUID string.
 */
export function siteIdFromUUID(uuid: string): SiteId {
  const hex = uuid.replace(/-/g, '');
  return siteIdFromHex(hex);
}

/**
 * Compare two site IDs for equality.
 */
export function siteIdEquals(a: SiteId, b: SiteId): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Storage key for site identity.
 */
export const SITE_ID_KEY = 'si:';

/**
 * Site identity record stored in the KV store.
 */
export interface SiteIdentity {
  siteId: SiteId;
  createdAt: number;  // Timestamp when this replica was first initialized
}

/**
 * Serialize site identity for storage.
 */
export function serializeSiteIdentity(identity: SiteIdentity): Uint8Array {
  const buffer = new Uint8Array(24);  // 16 bytes siteId + 8 bytes timestamp
  buffer.set(identity.siteId, 0);

  const view = new DataView(buffer.buffer);
  view.setBigUint64(16, BigInt(identity.createdAt), false);

  return buffer;
}

/**
 * Deserialize site identity from storage.
 */
export function deserializeSiteIdentity(buffer: Uint8Array): SiteIdentity {
  if (buffer.length !== 24) {
    throw new Error(`Invalid site identity buffer length: ${buffer.length}, expected 24`);
  }

  const siteId = new Uint8Array(buffer.slice(0, 16));
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const createdAt = Number(view.getBigUint64(16, false));

  return { siteId, createdAt };
}

