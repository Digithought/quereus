/**
 * Hybrid Logical Clock (HLC) implementation.
 *
 * HLC combines physical time with a logical counter to provide:
 * - Monotonically increasing timestamps
 * - Causality tracking across distributed nodes
 * - Bounded clock drift tolerance
 *
 * Ordering: (wallTime, counter, siteId) compared lexicographically
 */

import type { SiteId } from './site.js';

/**
 * Hybrid Logical Clock timestamp.
 */
export interface HLC {
  /** Physical wall time in milliseconds since epoch */
  readonly wallTime: bigint;
  /** Logical counter for events in the same millisecond (0-65535) */
  readonly counter: number;
  /** 16-byte UUID identifying the replica */
  readonly siteId: SiteId;
}

/**
 * Maximum counter value before forcing time advancement.
 */
const MAX_COUNTER = 0xFFFF;

/**
 * Maximum allowed clock drift in milliseconds (1 minute).
 * Rejects remote timestamps that are too far in the future.
 */
const MAX_DRIFT_MS = 60_000n;

/**
 * Compare two HLCs for ordering.
 * Returns negative if a < b, positive if a > b, zero if equal.
 */
export function compareHLC(a: HLC, b: HLC): number {
  // First compare wall time
  if (a.wallTime < b.wallTime) return -1;
  if (a.wallTime > b.wallTime) return 1;

  // Same wall time: compare counter
  if (a.counter < b.counter) return -1;
  if (a.counter > b.counter) return 1;

  // Same counter: compare site ID lexicographically
  return compareSiteIds(a.siteId, b.siteId);
}

/**
 * Compare two site IDs lexicographically.
 */
function compareSiteIds(a: SiteId, b: SiteId): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/**
 * Check if two HLCs are equal.
 */
export function hlcEquals(a: HLC, b: HLC): boolean {
  return compareHLC(a, b) === 0;
}

/**
 * Create a new HLC with the given values.
 */
export function createHLC(wallTime: bigint, counter: number, siteId: SiteId): HLC {
  return Object.freeze({ wallTime, counter, siteId });
}

/**
 * Serialize HLC to a Uint8Array for storage.
 * Format: 8 bytes wallTime (BE) + 2 bytes counter (BE) + 16 bytes siteId = 26 bytes
 */
export function serializeHLC(hlc: HLC): Uint8Array {
  const buffer = new Uint8Array(26);
  const view = new DataView(buffer.buffer);

  // Wall time as big-endian 64-bit
  view.setBigUint64(0, hlc.wallTime, false);

  // Counter as big-endian 16-bit
  view.setUint16(8, hlc.counter, false);

  // Site ID (16 bytes)
  buffer.set(hlc.siteId, 10);

  return buffer;
}

/**
 * Deserialize HLC from a Uint8Array.
 */
export function deserializeHLC(buffer: Uint8Array): HLC {
  if (buffer.length !== 26) {
    throw new Error(`Invalid HLC buffer length: ${buffer.length}, expected 26`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const wallTime = view.getBigUint64(0, false);
  const counter = view.getUint16(8, false);
  const siteId = new Uint8Array(buffer.slice(10, 26));

  return createHLC(wallTime, counter, siteId);
}

// ============================================================================
// JSON Serialization (for schema seeds and transport)
// ============================================================================

/**
 * JSON-serializable representation of an HLC.
 * Uses strings for bigint and base64url for binary data.
 */
export interface SerializedHLC {
  /** Wall time in milliseconds (string to preserve bigint precision) */
  wallTime: string;
  /** Logical counter (0-65535) */
  counter: number;
  /** Site ID as 22-character base64url string */
  siteId: string;
}

/**
 * Convert HLC to a JSON-serializable object.
 * Useful for schema seeds, HTTP transport, or debugging.
 */
export function hlcToJson(hlc: HLC): SerializedHLC {
  return {
    wallTime: hlc.wallTime.toString(),
    counter: hlc.counter,
    siteId: siteIdToBase64Local(hlc.siteId),
  };
}

/**
 * Parse HLC from a JSON-serializable object.
 */
export function hlcFromJson(json: SerializedHLC): HLC {
  return createHLC(
    BigInt(json.wallTime),
    json.counter,
    siteIdFromBase64Local(json.siteId)
  );
}

// Base64url alphabet (RFC 4648 Section 5)
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Convert site ID to base64url string (local helper to avoid circular import).
 */
function siteIdToBase64Local(siteId: SiteId): string {
  let result = '';
  for (let i = 0; i < siteId.length; i += 3) {
    const byte1 = siteId[i];
    const byte2 = i + 1 < siteId.length ? siteId[i + 1] : 0;
    const byte3 = i + 2 < siteId.length ? siteId[i + 2] : 0;
    const triplet = (byte1 << 16) | (byte2 << 8) | byte3;
    result += BASE64URL_CHARS[(triplet >>> 18) & 0x3f];
    result += BASE64URL_CHARS[(triplet >>> 12) & 0x3f];
    if (i + 1 < siteId.length) result += BASE64URL_CHARS[(triplet >>> 6) & 0x3f];
    if (i + 2 < siteId.length) result += BASE64URL_CHARS[triplet & 0x3f];
  }
  return result;
}

/**
 * Parse site ID from base64url string (local helper to avoid circular import).
 */
function siteIdFromBase64Local(base64: string): SiteId {
  if (base64.length !== 22) {
    throw new Error(`Invalid site ID base64 length: ${base64.length}, expected 22`);
  }
  // Build reverse lookup table
  const lookup: Record<string, number> = {};
  for (let i = 0; i < BASE64URL_CHARS.length; i++) {
    lookup[BASE64URL_CHARS[i]] = i;
  }
  const result = new Uint8Array(16);
  let writePos = 0;
  for (let i = 0; i < base64.length; i += 4) {
    const c1 = lookup[base64[i]] ?? 0;
    const c2 = lookup[base64[i + 1]] ?? 0;
    const c3 = i + 2 < base64.length ? lookup[base64[i + 2]] ?? 0 : 0;
    const c4 = i + 3 < base64.length ? lookup[base64[i + 3]] ?? 0 : 0;
    const triplet = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
    if (writePos < 16) result[writePos++] = (triplet >>> 16) & 0xff;
    if (writePos < 16) result[writePos++] = (triplet >>> 8) & 0xff;
    if (writePos < 16) result[writePos++] = triplet & 0xff;
  }
  return result;
}

/**
 * HLC Manager - maintains clock state for a single replica.
 */
export class HLCManager {
  private wallTime: bigint;
  private counter: number;
  private readonly siteId: SiteId;

  constructor(siteId: SiteId, initialState?: { wallTime: bigint; counter: number }) {
    this.siteId = siteId;
    this.wallTime = initialState?.wallTime ?? 0n;
    this.counter = initialState?.counter ?? 0;
  }

  /**
   * Get the current site ID.
   */
  getSiteId(): SiteId {
    return this.siteId;
  }

  /**
   * Get current clock state (for persistence).
   */
  getState(): { wallTime: bigint; counter: number } {
    return { wallTime: this.wallTime, counter: this.counter };
  }

  /**
   * Generate a new HLC for a local event.
   * Advances the clock and returns the new timestamp.
   */
  tick(): HLC {
    const now = BigInt(Date.now());

    if (now > this.wallTime) {
      // Physical time has advanced
      this.wallTime = now;
      this.counter = 0;
    } else {
      // Same or earlier physical time, increment counter
      this.counter++;
      if (this.counter > MAX_COUNTER) {
        // Counter overflow: force time advancement
        this.wallTime++;
        this.counter = 0;
      }
    }

    return createHLC(this.wallTime, this.counter, this.siteId);
  }

  /**
   * Update clock state upon receiving a remote HLC.
   * Ensures our clock is always >= received clock.
   * Returns a new HLC for the local receive event.
   */
  receive(remote: HLC): HLC {
    const now = BigInt(Date.now());

    // Check for excessive drift
    if (remote.wallTime > now + MAX_DRIFT_MS) {
      throw new Error(
        `Remote clock too far in future: ${remote.wallTime - now}ms ahead (max ${MAX_DRIFT_MS}ms)`
      );
    }

    // Merge: take max of local, remote, and now
    const maxWall = now > this.wallTime
      ? (now > remote.wallTime ? now : remote.wallTime)
      : (this.wallTime > remote.wallTime ? this.wallTime : remote.wallTime);

    if (maxWall === this.wallTime && maxWall === remote.wallTime) {
      // All three are equal: take max counter + 1
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (maxWall === this.wallTime) {
      // Local wins: increment local counter
      this.counter++;
    } else if (maxWall === remote.wallTime) {
      // Remote wins: take remote counter + 1
      this.wallTime = remote.wallTime;
      this.counter = remote.counter + 1;
    } else {
      // Physical time wins: reset counter
      this.wallTime = maxWall;
      this.counter = 0;
    }

    if (this.counter > MAX_COUNTER) {
      this.wallTime++;
      this.counter = 0;
    }

    return createHLC(this.wallTime, this.counter, this.siteId);
  }

  /**
   * Create an HLC at the current clock state without advancing.
   * Useful for read operations.
   */
  now(): HLC {
    return createHLC(this.wallTime, this.counter, this.siteId);
  }
}

