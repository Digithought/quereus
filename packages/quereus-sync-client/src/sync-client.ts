/**
 * SyncClient - WebSocket-based sync client for Quereus.
 *
 * Handles:
 * - WebSocket connection and handshake
 * - Message dispatch (changes, push_changes, apply_result, error, pong)
 * - Reconnection with exponential backoff
 * - Local change debouncing
 * - Delta sync tracking (lastSentHLC, pendingSentHLC)
 */

import {
  siteIdToBase64,
  siteIdFromBase64,
  compareHLC,
  type SyncManager,
  type SyncEventEmitter,
  type ChangeSet,
  type HLC,
  type SiteId,
} from '@quereus/sync';

import type {
  SyncClientOptions,
  SyncStatus,
  SyncEvent,
  SerializedChangeSet,
} from './types.js';

import {
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
} from './serialization.js';

// Default configuration values
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS = 50;

/**
 * WebSocket sync client for Quereus.
 *
 * Connects to a sync server and handles bidirectional synchronization
 * of changes with automatic reconnection and local change batching.
 */
export class SyncClient {
  private readonly syncManager: SyncManager;
  private readonly syncEvents: SyncEventEmitter;
  private readonly options: Required<Pick<SyncClientOptions,
    'autoReconnect' | 'reconnectDelayMs' | 'maxReconnectDelayMs' | 'localChangeDebounceMs'
  >> & SyncClientOptions;

  // WebSocket state
  private ws: WebSocket | null = null;
  private serverSiteId: SiteId | null = null;

  // Connection state
  private _status: SyncStatus = { status: 'disconnected' };
  private connectionUrl: string | null = null;
  private connectionDatabaseId: string | null = null;
  private connectionToken: string | undefined = undefined;

  // Reconnection state
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  // Delta sync tracking
  private lastSentHLC: HLC | null = null;
  private pendingSentHLC: HLC | null = null;

  // Local change debouncing
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLocalChangeCount = 0;

  // Local change listener cleanup
  private localChangeUnsubscribe: (() => void) | null = null;

  constructor(options: SyncClientOptions) {
    this.syncManager = options.syncManager;
    this.syncEvents = options.syncEvents;
    this.options = {
      ...options,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      localChangeDebounceMs: options.localChangeDebounceMs ?? DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS,
    };
  }

  /** Current connection status */
  get status(): SyncStatus {
    return this._status;
  }

  /** Whether the client is connected and synced */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Whether the client is fully synced */
  get isSynced(): boolean {
    return this._status.status === 'synced';
  }

  /**
   * Connect to a sync server.
   *
   * @param url - WebSocket URL of the sync server
   * @param databaseId - Database ID for multi-tenant routing
   * @param token - Optional authentication token
   * @returns Promise that resolves when connected (not yet synced)
   */
  async connect(url: string, databaseId: string, token?: string): Promise<void> {
    // Store connection params for reconnection
    this.connectionUrl = url;
    this.connectionDatabaseId = databaseId;
    this.connectionToken = token;
    this.intentionalDisconnect = false;

    // Clear any pending reconnect timer
    this.clearReconnectTimer();

    // Close existing connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setStatus({ status: 'connecting' });

    return new Promise((resolve, reject) => {
      try {
        const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.sendHandshake(databaseId, token);
          this.setStatus({ status: 'syncing', progress: 0 });
          this.emitSyncEvent('state-change', 'Connected to sync server, handshake sent');
          resolve();
        };

        this.ws.onclose = () => {
          this.setStatus({ status: 'disconnected' });
          this.emitSyncEvent('state-change', 'Disconnected from sync server');
          this.scheduleReconnect();
        };

        this.ws.onerror = () => {
          const error = new Error('WebSocket connection failed');
          this.setStatus({ status: 'error', message: error.message });
          this.emitSyncEvent('error', error.message);
          // Only reject on first attempt
          if (this.reconnectAttempts === 0) {
            reject(error);
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data).catch(err => {
            console.error('Error handling sync message:', err);
            this.emitSyncEvent('error', `Sync error: ${err instanceof Error ? err.message : 'Unknown'}`);
          });
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Connection failed';
        this.setStatus({ status: 'error', message: msg });
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the sync server.
   * Stops reconnection attempts.
   */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;

    // Clear timers
    this.clearReconnectTimer();
    this.clearDebounceTimer();

    // Remove local change listener
    if (this.localChangeUnsubscribe) {
      this.localChangeUnsubscribe();
      this.localChangeUnsubscribe = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.serverSiteId = null;
    this.lastSentHLC = null;
    this.pendingSentHLC = null;
    this.setStatus({ status: 'disconnected' });
    this.emitSyncEvent('state-change', 'Disconnected from sync server (manual)');
  }

  // ==========================================================================
  // Private: Message Handlers
  // ==========================================================================

  private async handleMessage(data: string): Promise<void> {
    const message = JSON.parse(data);

    switch (message.type) {
      case 'handshake_ack':
        await this.handleHandshakeAck(message);
        break;

      case 'changes':
      case 'push_changes':
        await this.handleChanges(message.changeSets || []);
        break;

      case 'apply_result':
        this.handleApplyResult(message);
        break;

      case 'error':
        this.emitSyncEvent('error', `Server error: ${message.message} (${message.code})`);
        this.options.onError?.(new Error(message.message));
        break;

      case 'pong':
        // Heartbeat response - no action needed
        break;

      case 'request_changes':
        // Server is requesting changes (for peer-to-peer relay)
        await this.handleRequestChanges(message);
        break;

      default:
        console.warn('Unknown sync message type:', message.type);
    }
  }

  private async handleHandshakeAck(message: { serverSiteId?: string; connectionId?: string }): Promise<void> {
    if (message.serverSiteId) {
      this.serverSiteId = siteIdFromBase64(message.serverSiteId);
    }

    this.emitSyncEvent(
      'state-change',
      `Authenticated with server (connection: ${message.connectionId?.slice(0, 8) ?? 'unknown'})`
    );

    // Request changes from server since our last sync with this peer
    await this.requestChangesFromServer();

    // Subscribe to local changes for pushing to server
    this.subscribeToLocalChanges();
  }

  private async handleChanges(serializedChangeSets: SerializedChangeSet[]): Promise<void> {
    const changeSets = serializedChangeSets.map(cs => deserializeChangeSet(cs));
    const result = await this.syncManager.applyChanges(changeSets);

    // Update peer sync state with the max HLC from received changes
    if (changeSets.length > 0 && this.serverSiteId) {
      let maxHLC: HLC | undefined;
      for (const cs of changeSets) {
        if (!maxHLC || compareHLC(cs.hlc, maxHLC) > 0) {
          maxHLC = cs.hlc;
        }
      }
      if (maxHLC) {
        await this.syncManager.updatePeerSyncState(this.serverSiteId, maxHLC);
      }
    }

    // Emit events
    if (result.applied > 0 || result.conflicts > 0 || result.skipped > 0) {
      const conflictText = result.conflicts > 0 ? ` (${result.conflicts} conflicts resolved)` : '';
      const skippedText = result.skipped > 0 ? `, ${result.skipped} skipped` : '';
      this.emitSyncEvent(
        'remote-change',
        `Applied ${result.applied} column changes${conflictText}${skippedText}`,
        { changeCount: result.applied, conflicts: result.conflicts, skipped: result.skipped }
      );
    }

    this.options.onRemoteChanges?.(result, changeSets);
    this.setStatus({ status: 'synced', lastSyncTime: Date.now() });
  }

  private handleApplyResult(message: { applied?: number }): void {
    // Update lastSentHLC to enable delta sync on next send
    if (this.pendingSentHLC) {
      this.lastSentHLC = this.pendingSentHLC;
      this.pendingSentHLC = null;
    }
    this.emitSyncEvent('info', `Server applied ${message.applied ?? 0} change(s)`);
  }

  private async handleRequestChanges(message: { siteId?: string; sinceHLC?: string }): Promise<void> {
    // Server is relaying a request for changes from another peer
    if (!message.siteId) return;

    const peerSiteId = siteIdFromBase64(message.siteId);
    const sinceHLC = message.sinceHLC ? deserializeHLCFromTransport(message.sinceHLC) : undefined;

    const changes = await this.syncManager.getChangesSince(peerSiteId, sinceHLC);
    if (changes.length > 0) {
      const serialized = changes.map(cs => serializeChangeSet(cs));
      this.send({
        type: 'apply_changes',
        changes: serialized,
      });
    }
  }

  // ==========================================================================
  // Private: Message Sending
  // ==========================================================================

  private sendHandshake(databaseId: string, token?: string): void {
    const siteId = this.syncManager.getSiteId();
    this.send({
      type: 'handshake',
      databaseId,
      siteId: siteIdToBase64(siteId),
      token,
    });
  }

  private async requestChangesFromServer(): Promise<void> {
    if (!this.serverSiteId) return;

    const lastSyncHLC = await this.syncManager.getPeerSyncState(this.serverSiteId);
    const msg: { type: string; sinceHLC?: string } = { type: 'get_changes' };

    if (lastSyncHLC) {
      msg.sinceHLC = serializeHLCForTransport(lastSyncHLC);
    }

    this.send(msg);
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }


  // ==========================================================================
  // Private: Local Change Handling
  // ==========================================================================

  private subscribeToLocalChanges(): void {
    // Unsubscribe from previous if any
    if (this.localChangeUnsubscribe) {
      this.localChangeUnsubscribe();
    }

    // Subscribe to local changes via SyncEventEmitter
    this.localChangeUnsubscribe = this.syncEvents.onLocalChange(() => {
      this.pendingLocalChangeCount++;
      this.debouncePushLocalChanges();
    });
  }

  private debouncePushLocalChanges(): void {
    this.clearDebounceTimer();

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.pushLocalChanges();
    }, this.options.localChangeDebounceMs);
  }

  private async pushLocalChanges(): Promise<void> {
    if (!this.isConnected) return;

    // Get changes since lastSentHLC (delta sync)
    const changes = await this.syncManager.getChangesSince(
      this.syncManager.getSiteId(),
      this.lastSentHLC ?? undefined
    );

    if (changes.length === 0) return;

    // Track the max HLC we're sending for delta sync
    let maxHLC: HLC | undefined;
    for (const cs of changes) {
      if (!maxHLC || compareHLC(cs.hlc, maxHLC) > 0) {
        maxHLC = cs.hlc;
      }
    }
    this.pendingSentHLC = maxHLC ?? null;

    // Serialize and send
    const serialized = changes.map(cs => serializeChangeSet(cs));

    this.emitSyncEvent('local-change', `Sending ${changes.length} change set(s) to server`, {
      changeCount: changes.length,
    });

    this.send({
      type: 'apply_changes',
      changes: serialized,
    });

    this.pendingLocalChangeCount = 0;
  }

  // ==========================================================================
  // Private: Reconnection
  // ==========================================================================

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || !this.connectionUrl || !this.options.autoReconnect) {
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to max
    const delay = Math.min(
      this.options.reconnectDelayMs * Math.pow(2, this.reconnectAttempts),
      this.options.maxReconnectDelayMs
    );

    this.reconnectAttempts++;

    this.emitSyncEvent(
      'state-change',
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.connectionUrl!, this.connectionDatabaseId!, this.connectionToken).catch(() => {
        // Error already handled in connect, reconnect will be scheduled by onclose
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ==========================================================================
  // Private: Status & Events
  // ==========================================================================

  private setStatus(status: SyncStatus): void {
    this._status = status;
    this.options.onStatusChange?.(status);
  }

  private emitSyncEvent(
    type: SyncEvent['type'],
    message: string,
    details?: SyncEvent['details']
  ): void {
    const event: SyncEvent = {
      type,
      timestamp: Date.now(),
      message,
      details,
    };
    this.options.onSyncEvent?.(event);
  }
}
