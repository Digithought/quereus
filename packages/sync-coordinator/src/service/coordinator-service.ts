/**
 * CoordinatorService - Main service layer for sync coordination.
 *
 * Wraps SyncManager with validation hooks and client session management.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { LevelDBStore, StoreEventEmitter } from '@quereus/plugin-store';
import {
  createSyncModule,
  type SyncManager,
  type HLC,
  type SiteId,
  type ChangeSet,
  type ApplyResult,
  type SnapshotChunk,
  siteIdFromBase64,
  siteIdEquals,
  siteIdToBase64,
  serializeHLC,
} from '@quereus/plugin-sync';
import { serviceLog, authLog } from '../common/logger.js';
import type { CoordinatorConfig } from '../config/types.js';
import {
  createCoordinatorMetrics,
  type CoordinatorMetrics,
} from '../metrics/index.js';
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
  /** Custom metrics (uses global registry if not provided) */
  metrics?: CoordinatorMetrics;
}

/**
 * Coordinator service that manages sync operations with hooks.
 */
export class CoordinatorService {
  private readonly config: CoordinatorConfig;
  private readonly hooks: CoordinatorHooks;
  private readonly metrics: CoordinatorMetrics;
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
    this.metrics = options.metrics || createCoordinatorMetrics();
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
      siteIdToBase64(syncManager.getSiteId()));
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
    this.metrics.registry.incCounter(this.metrics.authAttemptsTotal);

    try {
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
        return await this.hooks.onAuthenticate(context);
      }

      // Default: allow all, use provided siteId
      if (!context.siteId && context.siteIdRaw) {
        context.siteId = siteIdFromBase64(context.siteIdRaw);
      }
      if (!context.siteId) {
        throw new Error('Site ID required');
      }

      return { siteId: context.siteId };
    } catch (err) {
      this.metrics.registry.incCounter(this.metrics.authFailuresTotal);
      throw err;
    }
  }

  /**
   * Authorize an operation for a client.
   */
  async authorize(client: ClientIdentity, operation: SyncOperation): Promise<boolean> {
    if (this.hooks.onAuthorize) {
      const allowed = await this.hooks.onAuthorize(client, operation);
      if (!allowed) {
        authLog('Authorization denied for %s: %O',
          siteIdToBase64(client.siteId), operation);
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
      siteIdToBase64(client.siteId), sinceHLC);

    const endTimer = this.metrics.registry.startTimer(this.metrics.getChangesDuration);

    // Authorize
    const allowed = await this.authorize(client, { type: 'get_changes', sinceHLC });
    if (!allowed) {
      throw new Error('Not authorized');
    }

    const changes = await this.syncManager.getChangesSince(client.siteId, sinceHLC);
    endTimer();

    return changes;
  }

  /**
   * Apply changes from a client.
   */
  async applyChanges(
    client: ClientIdentity,
    changes: ChangeSet[]
  ): Promise<ApplyResult> {
    serviceLog('applyChanges from %s, count: %d',
      siteIdToBase64(client.siteId), changes.length);

    const endTimer = this.metrics.registry.startTimer(this.metrics.applyChangesDuration);
    this.metrics.registry.incCounter(this.metrics.changesReceivedTotal, {}, changes.length);
    this.metrics.registry.observeHistogram(this.metrics.changeBatchSize, changes.length);

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
          siteIdToBase64(client.siteId));
        this.metrics.registry.incCounter(this.metrics.changesRejectedTotal, {}, result.rejected.length);
      }
    }

    // Log changes before applying for debugging
    for (const cs of approvedChanges) {
      serviceLog('ChangeSet has %d changes, %d schemaMigrations',
        cs.changes.length, cs.schemaMigrations?.length ?? 0);
      for (const c of cs.changes) {
        if (c.type === 'column') {
          serviceLog('  Column: %s.%s.%s = %O', c.schema, c.table, c.column, c.value);
        } else if (c.type === 'delete') {
          serviceLog('  Delete: %s.%s pk=%O', c.schema, c.table, c.pk);
        }
      }
    }

    // Apply
    const result = await this.syncManager.applyChanges(approvedChanges);
    serviceLog('Apply result: applied=%d, skipped=%d, conflicts=%d',
      result.applied, result.skipped, result.conflicts);
    endTimer();

    this.metrics.registry.incCounter(this.metrics.changesAppliedTotal, {}, result.applied);

    // Post-apply hook
    if (this.hooks.onAfterApplyChanges) {
      this.hooks.onAfterApplyChanges(client, approvedChanges, result);
    }

    // Broadcast to other connected clients
    if (result.applied > 0) {
      serviceLog('Broadcasting %d changes to other clients', approvedChanges.length);
      this.broadcastChanges(client.siteId, approvedChanges);
    } else {
      serviceLog('No changes applied, not broadcasting');
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
      siteIdToBase64(client.siteId));

    this.metrics.registry.incCounter(this.metrics.snapshotRequestsTotal);

    // Authorize
    const allowed = await this.authorize(client, { type: 'get_snapshot' });
    if (!allowed) {
      throw new Error('Not authorized');
    }

    for await (const chunk of this.syncManager.getSnapshotStream(chunkSize)) {
      this.metrics.registry.incCounter(this.metrics.snapshotChunksTotal);
      yield chunk;
    }
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
    const siteIdKey = siteIdToBase64(identity.siteId);

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
    let connections = this.siteIdToConnections.get(siteIdKey);
    if (!connections) {
      connections = new Set();
      this.siteIdToConnections.set(siteIdKey, connections);
    }
    connections.add(connectionId);

    // Update metrics
    this.metrics.registry.incCounter(this.metrics.wsConnectionsTotal);
    this.metrics.registry.incGauge(this.metrics.wsConnectionsActive);

    serviceLog('Session registered: %s (site: %s)',
      connectionId.slice(0, 8), siteIdKey);

    return session;
  }

  /**
   * Unregister a WebSocket client session.
   */
  unregisterSession(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    const siteIdKey = siteIdToBase64(session.siteId);

    // Call disconnect hook
    if (this.hooks.onClientDisconnect) {
      this.hooks.onClientDisconnect(session.identity);
    }

    this.sessions.delete(connectionId);

    // Remove from siteId tracking
    const connections = this.siteIdToConnections.get(siteIdKey);
    if (connections) {
      connections.delete(connectionId);
      if (connections.size === 0) {
        this.siteIdToConnections.delete(siteIdKey);
      }
    }

    // Update metrics
    this.metrics.registry.decGauge(this.metrics.wsConnectionsActive);

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
    // Serialize changesets for JSON transport
    const serializedChangeSets = changes.map(cs => this.serializeChangeSet(cs));
    const message = JSON.stringify({
      type: 'push_changes',
      changeSets: serializedChangeSets,
    });

    let broadcastCount = 0;
    for (const session of this.sessions.values()) {
      // Don't send to the originator
      if (siteIdEquals(session.siteId, senderSiteId)) {
        continue;
      }

      if (session.socket.readyState === 1) { // WebSocket.OPEN
        session.socket.send(message);
        broadcastCount++;
      }
    }

    if (broadcastCount > 0) {
      this.metrics.registry.incCounter(
        this.metrics.changesBroadcastTotal,
        {},
        changes.length * broadcastCount
      );
    }
  }

  /**
   * Serialize a ChangeSet for JSON transport.
   */
  private serializeChangeSet(cs: ChangeSet): object {
    const hlcBytes = serializeHLC(cs.hlc);
    return {
      siteId: siteIdToBase64(cs.siteId),
      transactionId: cs.transactionId,
      hlc: Buffer.from(hlcBytes).toString('base64'),
      changes: cs.changes.map(c => {
        const chlcBytes = serializeHLC(c.hlc);
        return {
          ...c,
          hlc: Buffer.from(chlcBytes).toString('base64'),
        };
      }),
      schemaMigrations: cs.schemaMigrations.map(m => {
        const mhlcBytes = serializeHLC(m.hlc);
        return {
          ...m,
          hlc: Buffer.from(mhlcBytes).toString('base64'),
        };
      }),
    };
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
      siteId: siteIdToBase64(this.syncManager.getSiteId()),
      connectedClients: this.sessions.size,
      uptime: process.uptime(),
    };
  }

  /**
   * Get the metrics registry for this service.
   */
  getMetrics(): CoordinatorMetrics {
    return this.metrics;
  }
}

