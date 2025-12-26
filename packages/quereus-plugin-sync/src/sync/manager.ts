/**
 * SyncManager - main API for sync operations.
 *
 * This interface defines the transport-agnostic sync API.
 * Applications implement their own transport layer and call these methods.
 */

import type { HLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import type { ApplyResult, ChangeSet, Snapshot } from './protocol.js';

/**
 * Main sync manager interface.
 *
 * This is the primary API for sync operations. Applications use this to:
 * - Get changes to send to peers
 * - Apply changes received from peers
 * - Manage sync state
 */
export interface SyncManager {
  /**
   * Get this replica's site ID.
   */
  getSiteId(): SiteId;

  /**
   * Get current HLC for state comparison.
   */
  getCurrentHLC(): HLC;

  /**
   * Get all changes since a peer's last known state.
   *
   * @param peerSiteId - The peer requesting changes
   * @param sinceHLC - The peer's last known HLC (omit for full sync)
   * @returns Array of change sets to send to the peer
   */
  getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /**
   * Apply changes received from a peer.
   *
   * Changes are applied atomically per transaction.
   * Conflicts are resolved using column-level LWW.
   *
   * @param changes - Change sets received from a peer
   * @returns Statistics about what was applied
   */
  applyChanges(changes: ChangeSet[]): Promise<ApplyResult>;

  /**
   * Check if delta sync is possible with a peer.
   *
   * Returns false if:
   * - Tombstone TTL has expired for relevant data
   * - Peer's last sync is too old
   * - Full snapshot is required
   *
   * @param peerSiteId - The peer to check
   * @param sinceHLC - The peer's last known HLC
   */
  canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean>;

  /**
   * Get a full snapshot for initial sync or TTL expiration recovery.
   *
   * This includes all current data and schema state.
   */
  getSnapshot(): Promise<Snapshot>;

  /**
   * Apply a full snapshot (replaces all local data).
   *
   * Used for initial sync or when delta sync is not possible.
   *
   * @param snapshot - Full snapshot from a peer
   */
  applySnapshot(snapshot: Snapshot): Promise<void>;

  /**
   * Update the last sync state for a peer.
   *
   * Called after successfully syncing with a peer.
   *
   * @param peerSiteId - The peer we synced with
   * @param hlc - The HLC we synced up to
   */
  updatePeerSyncState(peerSiteId: SiteId, hlc: HLC): Promise<void>;

  /**
   * Get the last sync state for a peer.
   *
   * @param peerSiteId - The peer to check
   * @returns The last HLC we synced to, or undefined if never synced
   */
  getPeerSyncState(peerSiteId: SiteId): Promise<HLC | undefined>;

  /**
   * Prune expired tombstones.
   *
   * Should be called periodically to clean up old tombstones.
   * Returns the number of tombstones pruned.
   */
  pruneTombstones(): Promise<number>;
}

