/**
 * CoordinatorService - Main service layer for sync coordination.
 *
 * Wraps SyncManager with validation hooks and client session management.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { LevelDBStore, StoreEventEmitter } from 'quereus-plugin-store';
import {
  createSyncModule,
  type SyncManager,
  type HLC,
  type SiteId,
  type ChangeSet,
  type ApplyResult,
  type SnapshotChunk,
  siteIdFromHex,
  siteIdEquals,
} from 'quereus-plugin-sync';
import { serviceLog, authLog } from '../common/logger.js';
import type { CoordinatorConfig } from '../config/types.js';
import type {
  ClientIdentity,
  ClientSession,
  AuthContext,
  SyncOperation,
  CoordinatorHooks,
} from './types.js';

/**
 * Options for creating a CoordinatorService.
 */
export interface CoordinatorServiceOptions {
  /** Full configuration */
  config: CoordinatorConfig;
  /** Custom hooks for validation/auth */
  hooks?: CoordinatorHooks;
}

/**
 * Coordinator service that manages sync operations with hooks.
 */
export class CoordinatorService {
  private readonly config: CoordinatorConfig;
  private readonly hooks: CoordinatorHooks;
  private syncManager!: SyncManager;
  private kvStore!: LevelDBStore;

  /** Active WebSocket sessions by connection ID */
  private readonly sessions = new Map<string, ClientSession>();
  /** Connection IDs by site ID for broadcasting */
  private readonly siteIdToConnections = new Map<string, Set<string>>();

  private initialized = false;

  constructor(options: CoordinatorServiceOptions) {
    this.config = options.config;
    this.hooks = options.hooks || {};
  }

  /**
   * Initialize the service (open store, create sync manager).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    serviceLog('Initializing CoordinatorService with dataDir: %s', this.config.dataDir);

    // Open LevelDB store
    this.kvStore = await LevelDBStore.open({
      path: this.config.dataDir,
      createIfMissing: true,
    });

    // Create sync module
    const storeEvents = new StoreEventEmitter();
    const { syncManager } = await createSyncModule(
      this.kvStore,
      storeEvents,
      {
        tombstoneTTL: this.config.sync.tombstoneTTL,
        batchSize: this.config.sync.batchSize,
      }
    );

    this.syncManager = syncManager;
    this.initialized = true;

    serviceLog('CoordinatorService initialized, siteId: %s',
      Buffer.from(syncManager.getSiteId()).toString('hex').slice(0, 16) + '...');
  }

  /**
   * Shutdown the service.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    serviceLog('Shutting down CoordinatorService');

    // Close all WebSocket connections
    for (const session of this.sessions.values()) {
      session.socket.close(1001, 'Server shutting down');
    }
    this.sessions.clear();
    this.siteIdToConnections.clear();

    // Close KV store
    await this.kvStore.close();
    this.initialized = false;
  }

  // ============================================================================
  // Authentication & Authorization
  // ============================================================================

  /**
   * Authenticate a request/connection.
   */
  async authenticate(context: AuthContext): Promise<ClientIdentity> {
    authLog('Authenticating request, siteId: %s', context.siteIdRaw?.slice(0, 16));

    // Token-whitelist mode
    if (this.config.auth.mode === 'token-whitelist') {
      if (!context.token) {
        throw new Error('Authentication required');
      }
      if (!this.config.auth.tokens?.includes(context.token)) {
        throw new Error('Invalid token');
      }
    }

    // Custom hook
    if (this.hooks.onAuthenticate) {
      return this.hooks.onAuthenticate(context);
    }

    // Default: allow all, use provided siteId
    if (!context.siteId && context.siteIdRaw) {
      context.siteId = siteIdFromHex(context.siteIdRaw);
    }
    if (!context.siteId) {
      throw new Error('Site ID required');
    }

    return { siteId: context.siteId };
  }

  /**
   * Authorize an operation for a client.
   */
  async authorize(client: ClientIdentity, operation: SyncOperation): Promise<boolean> {
    if (this.hooks.onAuthorize) {
      const allowed = await this.hooks.onAuthorize(client, operation);
      if (!allowed) {
        authLog('Authorization denied for %s: %O',
          Buffer.from(client.siteId).toString('hex').slice(0, 16), operation);
      }
      return allowed;
    }
    return true; // Default: allow all
  }

  // ============================================================================
  // Sync Operations
  // ============================================================================

  /**
   * Get this coordinator's site ID.
   */
  getSiteId(): SiteId {
    return this.syncManager.getSiteId();
  }

  /**
   * Get current HLC.
   */
  getCurrentHLC(): HLC {
    return this.syncManager.getCurrentHLC();
  }

  /**
   * Get changes since a given HLC for a client.
   */
  async getChangesSince(
    client: ClientIdentity,
    sinceHLC?: HLC
  ): Promise<ChangeSet[]> {
    serviceLog('getChangesSince for %s, sinceHLC: %O',
      Buffer.from(client.siteId).toString('hex').slice(0, 16), sinceHLC);

    // Authorize
    const allowed = await this.authorize(client, { type: 'get_changes', sinceHLC });
    if (!allowed) {
      throw new Error('Not authorized');
    }

    return this.syncManager.getChangesSince(client.siteId, sinceHLC);
  }

  /**
   * Apply changes from a client.
   */
  async applyChanges(
    client: ClientIdentity,
    changes: ChangeSet[]
  ): Promise<ApplyResult> {
    serviceLog('applyChanges from %s, count: %d',
      Buffer.from(client.siteId).toString('hex').slice(0, 16), changes.length);

    // Authorize
    const allowed = await this.authorize(client, {
      type: 'apply_changes',
      changeCount: changes.length
    });
    if (!allowed) {
      throw new Error('Not authorized');
    }

    // Validate changes
    let approvedChanges = changes;
    if (this.hooks.onBeforeApplyChanges) {
      const result = await this.hooks.onBeforeApplyChanges(client, changes);
      approvedChanges = result.approved;
      if (result.rejected.length > 0) {
        serviceLog('Rejected %d changes from %s',
          result.rejected.length,
          Buffer.from(client.siteId).toString('hex').slice(0, 16));
      }
    }

    // Apply
    const result = await this.syncManager.applyChanges(approvedChanges);

    // Post-apply hook
    if (this.hooks.onAfterApplyChanges) {
      this.hooks.onAfterApplyChanges(client, approvedChanges, result);
    }

    // Broadcast to other connected clients
    if (result.applied > 0) {
      this.broadcastChanges(client.siteId, approvedChanges);
    }

    return result;
  }

  /**
   * Stream a full snapshot.
   */
  async *getSnapshotStream(
    client: ClientIdentity,
    chunkSize?: number
  ): AsyncIterable<SnapshotChunk> {
    serviceLog('getSnapshotStream for %s',
      Buffer.from(client.siteId).toString('hex').slice(0, 16));

    // Authorize
    const allowed = await this.authorize(client, { type: 'get_snapshot' });
    if (!allowed) {
      throw new Error('Not authorized');
    }

    yield* this.syncManager.getSnapshotStream(chunkSize);
  }

  /**
   * Check if delta sync is possible.
   */
  async canDeltaSync(client: ClientIdentity, sinceHLC: HLC): Promise<boolean> {
    return this.syncManager.canDeltaSync(client.siteId, sinceHLC);
  }

  // ============================================================================
  // WebSocket Session Management
  // ============================================================================

  /**
   * Register a new WebSocket client session.
   */
  async registerSession(
    socket: WebSocket,
    identity: ClientIdentity
  ): Promise<ClientSession> {
    const connectionId = randomUUID();
    const siteIdHex = Buffer.from(identity.siteId).toString('hex');

    // Call connect hook
    if (this.hooks.onClientConnect) {
      const allowed = await this.hooks.onClientConnect(identity, socket);
      if (!allowed) {
        throw new Error('Connection rejected');
      }
    }

    const session: ClientSession = {
      connectionId,
      siteId: identity.siteId,
      identity,
      lastSyncHLC: undefined,
      connectedAt: Date.now(),
      socket,
    };

    this.sessions.set(connectionId, session);

    // Track by siteId for broadcasting
    let connections = this.siteIdToConnections.get(siteIdHex);
    if (!connections) {
      connections = new Set();
      this.siteIdToConnections.set(siteIdHex, connections);
    }
    connections.add(connectionId);

    serviceLog('Session registered: %s (site: %s)',
      connectionId.slice(0, 8), siteIdHex.slice(0, 16));

    return session;
  }

  /**
   * Unregister a WebSocket client session.
   */
  unregisterSession(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    const siteIdHex = Buffer.from(session.siteId).toString('hex');

    // Call disconnect hook
    if (this.hooks.onClientDisconnect) {
      this.hooks.onClientDisconnect(session.identity);
    }

    this.sessions.delete(connectionId);

    // Remove from siteId tracking
    const connections = this.siteIdToConnections.get(siteIdHex);
    if (connections) {
      connections.delete(connectionId);
      if (connections.size === 0) {
        this.siteIdToConnections.delete(siteIdHex);
      }
    }

    serviceLog('Session unregistered: %s', connectionId.slice(0, 8));
  }

  /**
   * Get a session by connection ID.
   */
  getSession(connectionId: string): ClientSession | undefined {
    return this.sessions.get(connectionId);
  }

  /**
   * Update the last sync HLC for a session.
   */
  updateSessionSyncState(connectionId: string, hlc: HLC): void {
    const session = this.sessions.get(connectionId);
    if (session) {
      session.lastSyncHLC = hlc;
    }
  }

  /**
   * Broadcast changes to all connected clients except the sender.
   */
  private broadcastChanges(senderSiteId: SiteId, changes: ChangeSet[]): void {
    const message = JSON.stringify({
      type: 'push_changes',
      changeSets: changes,
    });

    for (const session of this.sessions.values()) {
      // Don't send to the originator
      if (siteIdEquals(session.siteId, senderSiteId)) {
        continue;
      }

      if (session.socket.readyState === 1) { // WebSocket.OPEN
        session.socket.send(message);
      }
    }
  }

  /**
   * Get server status and stats.
   */
  getStatus(): {
    siteId: string;
    connectedClients: number;
    uptime: number;
  } {
    return {
      siteId: Buffer.from(this.syncManager.getSiteId()).toString('hex'),
      connectedClients: this.sessions.size,
      uptime: process.uptime(),
    };
  }
}

