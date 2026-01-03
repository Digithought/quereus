/**
 * Sync event types for reactive UI integration.
 *
 * These events allow applications to react to sync state changes,
 * remote data updates, and conflict resolution.
 */

import type { SqlValue } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import type { Change } from './protocol.js';

// ============================================================================
// Event Types
// ============================================================================

/**
 * Fired when remote changes are applied locally.
 */
export interface RemoteChangeEvent {
  /** Origin replica */
  readonly siteId: SiteId;
  /** Transaction ID */
  readonly transactionId: string;
  /** Changes that were applied */
  readonly changes: Change[];
  /** When changes were applied locally */
  readonly appliedAt: HLC;
}

/**
 * Fired when local changes are made.
 */
export interface LocalChangeEvent {
  /** Transaction ID */
  readonly transactionId: string;
  /** Changes made locally */
  readonly changes: Change[];
  /** True if not yet synced to any peer */
  readonly pendingSync: boolean;
}

/**
 * Fired when a conflict is resolved.
 */
export interface ConflictEvent {
  /** Table where conflict occurred */
  readonly table: string;
  /** Primary key of the row */
  readonly pk: SqlValue[];
  /** Column where conflict occurred */
  readonly column: string;
  /** Local value that was in conflict */
  readonly localValue: SqlValue;
  /** Remote value that was in conflict */
  readonly remoteValue: SqlValue;
  /** Which value won */
  readonly winner: 'local' | 'remote';
  /** HLC of the winning value */
  readonly winningHLC: HLC;
}

/**
 * Sync connection state.
 */
export type SyncState =
  | { readonly status: 'disconnected' }
  | { readonly status: 'connecting' }
  | { readonly status: 'syncing'; readonly progress: number }
  | { readonly status: 'synced'; readonly lastSyncHLC: HLC }
  | { readonly status: 'error'; readonly error: Error };

// ============================================================================
// Event Emitter Interface
// ============================================================================

/**
 * Unsubscribe function returned by event listeners.
 */
export type Unsubscribe = () => void;

/**
 * Sync event emitter for reactive UI integration.
 */
export interface SyncEventEmitter {
  /**
   * Subscribe to remote change events.
   * Fired when changes from another replica are applied locally.
   */
  onRemoteChange(listener: (event: RemoteChangeEvent) => void): Unsubscribe;

  /**
   * Subscribe to local change events.
   * Fired when local mutations occur.
   */
  onLocalChange(listener: (event: LocalChangeEvent) => void): Unsubscribe;

  /**
   * Subscribe to sync state changes.
   * Fired when connection state changes.
   */
  onSyncStateChange(listener: (state: SyncState) => void): Unsubscribe;

  /**
   * Subscribe to conflict resolution events.
   * Fired when a conflict is resolved via LWW.
   */
  onConflictResolved(listener: (event: ConflictEvent) => void): Unsubscribe;
}

// ============================================================================
// Event Emitter Implementation
// ============================================================================

/**
 * Default implementation of SyncEventEmitter.
 */
export class SyncEventEmitterImpl implements SyncEventEmitter {
  private remoteChangeListeners = new Set<(event: RemoteChangeEvent) => void>();
  private localChangeListeners = new Set<(event: LocalChangeEvent) => void>();
  private syncStateListeners = new Set<(state: SyncState) => void>();
  private conflictListeners = new Set<(event: ConflictEvent) => void>();

  onRemoteChange(listener: (event: RemoteChangeEvent) => void): Unsubscribe {
    this.remoteChangeListeners.add(listener);
    return () => this.remoteChangeListeners.delete(listener);
  }

  onLocalChange(listener: (event: LocalChangeEvent) => void): Unsubscribe {
    this.localChangeListeners.add(listener);
    return () => this.localChangeListeners.delete(listener);
  }

  onSyncStateChange(listener: (state: SyncState) => void): Unsubscribe {
    this.syncStateListeners.add(listener);
    return () => this.syncStateListeners.delete(listener);
  }

  onConflictResolved(listener: (event: ConflictEvent) => void): Unsubscribe {
    this.conflictListeners.add(listener);
    return () => this.conflictListeners.delete(listener);
  }

  // Internal emit methods

  emitRemoteChange(event: RemoteChangeEvent): void {
    for (const listener of this.remoteChangeListeners) {
      listener(event);
    }
  }

  emitLocalChange(event: LocalChangeEvent): void {
    for (const listener of this.localChangeListeners) {
      listener(event);
    }
  }

  emitSyncStateChange(state: SyncState): void {
    for (const listener of this.syncStateListeners) {
      listener(state);
    }
  }

  emitConflictResolved(event: ConflictEvent): void {
    for (const listener of this.conflictListeners) {
      listener(event);
    }
  }
}

