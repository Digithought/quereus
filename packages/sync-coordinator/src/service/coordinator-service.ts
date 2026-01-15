/**
 * CoordinatorService - Main service layer for multi-tenant sync coordination.
 *
 * Manages multiple database stores with lazy loading and provides
 * sync operations with validation hooks and client session management.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  type HLC,
  type SiteId,
  type ChangeSet,
  type ApplyResult,
  type SnapshotChunk,
  siteIdFromBase64,
  siteIdEquals,
  siteIdToBase64,
  serializeHLC,
} from '@quereus/sync';
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
import { StoreManager, type StoreEntry, type StoreManagerHooks, type StoreContext } from './store-manager.js';
import { type S3StorageConfig, createS3Client } from './s3-config.js';
import { S3BatchStore } from './s3-batch-store.js';
import { S3SnapshotStore, type SnapshotScheduleConfig } from './s3-snapshot-store.js';
import { CascadeDeleteService, type ArchiveStore, type RelatedDatabaseQuery } from './cascade-delete.js';
import { parseDatabaseId } from './database-ids.js';

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
  /** Hooks for customizing store behavior (database ID handling, path resolution) */
  storeHooks?: StoreManagerHooks;
  /** S3 configuration for durable batch storage (optional) */
  s3Config?: S3StorageConfig;
  /** Snapshot schedule configuration (optional) */
  snapshotConfig?: Partial<SnapshotScheduleConfig>;
  /** Archive store for cascade delete (optional) */
  archiveStore?: ArchiveStore;
  /** Query interface for finding related databases (optional) */
  relatedDatabaseQuery?: RelatedDatabaseQuery;
}

/**
 * Multi-tenant coordinator service that manages sync operations with hooks.
 */
export class CoordinatorService {
  private readonly config: CoordinatorConfig;
  private readonly hooks: CoordinatorHooks;
  private readonly metrics: CoordinatorMetrics;
  private readonly storeManager: StoreManager;
  private readonly s3BatchStore?: S3BatchStore;
  private readonly s3SnapshotStore?: S3SnapshotStore;
  private readonly cascadeDeleteService?: CascadeDeleteService;

  /** Active WebSocket sessions by connection ID */
  private readonly sessions = new Map<string, ClientSession>();
  /** Connection IDs by database ID for broadcasting */
  private readonly databaseToConnections = new Map<string, Set<string>>();

  private initialized = false;

  constructor(options: CoordinatorServiceOptions) {
    this.config = options.config;
    this.hooks = options.hooks || {};
    this.metrics = options.metrics || createCoordinatorMetrics();
    this.storeManager = new StoreManager({
      dataDir: this.config.dataDir,
      maxOpenStores: 100,
      idleTimeoutMs: 5 * 60 * 1000,
      cleanupIntervalMs: 30 * 1000,
      syncConfig: {
        tombstoneTTL: this.config.sync.tombstoneTTL,
        batchSize: this.config.sync.batchSize,
      },
      hooks: options.storeHooks,
    });

    // Initialize S3 stores if configured
    if (options.s3Config) {
      const s3Client = createS3Client(options.s3Config);
      this.s3BatchStore = new S3BatchStore(s3Client, options.s3Config);
      this.s3SnapshotStore = new S3SnapshotStore(s3Client, options.s3Config, options.snapshotConfig);
      serviceLog('S3 batch storage enabled: bucket=%s', options.s3Config.bucket);
    }

    // Initialize cascade delete service if query interface is provided
    if (options.relatedDatabaseQuery) {
      this.cascadeDeleteService = new CascadeDeleteService(
        {
          dataDir: this.config.dataDir,
          archiveRetentionDays: 30,
        },
        this.storeManager,
        options.relatedDatabaseQuery,
        options.archiveStore
      );
    }
  }

  /**
   * Initialize the service.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    serviceLog('Initializing CoordinatorService (multi-tenant) with dataDir: %s', this.config.dataDir);
    this.storeManager.start();

    // Start snapshot store if configured
    if (this.s3SnapshotStore) {
      this.s3SnapshotStore.start();
      serviceLog('S3 snapshot store started');
    }

    this.initialized = true;

    serviceLog('CoordinatorService initialized, ready for multi-tenant connections');
  }

  /**
   * Shutdown the service.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    serviceLog('Shutting down CoordinatorService');

    // Stop snapshot store
    if (this.s3SnapshotStore) {
      this.s3SnapshotStore.stop();
    }

    // Shutdown cascade delete service
    if (this.cascadeDeleteService) {
      this.cascadeDeleteService.shutdown();
    }

    // Close all WebSocket connections
    for (const session of this.sessions.values()) {
      session.socket.close(1001, 'Server shutting down');
    }
    this.sessions.clear();
    this.databaseToConnections.clear();

    // Shutdown store manager
    await this.storeManager.shutdown();
    this.initialized = false;
  }

  /**
   * Build a StoreContext from auth information.
   */
  private buildStoreContext(authContext?: AuthContext, identity?: ClientIdentity): StoreContext {
    return {
      token: authContext?.token,
      userId: identity?.userId,
      metadata: identity?.metadata,
    };
  }

  /**
   * Get a store entry for a database, acquiring if needed.
   */
  private async getStore(databaseId: string, context?: StoreContext): Promise<StoreEntry> {
    return this.storeManager.acquire(databaseId, context);
  }

  /**
   * Release a store reference.
   */
  private releaseStore(databaseId: string): void {
    this.storeManager.release(databaseId);
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
   * Get the coordinator's site ID for a specific database.
   */
  async getSiteId(databaseId: string, client?: ClientIdentity): Promise<SiteId> {
    const context = client ? this.buildStoreContext(undefined, client) : undefined;
    const entry = await this.getStore(databaseId, context);
    try {
      return entry.syncManager.getSiteId();
    } finally {
      this.releaseStore(databaseId);
    }
  }

  /**
   * Get current HLC for a specific database.
   */
  async getCurrentHLC(databaseId: string, client?: ClientIdentity): Promise<HLC> {
    const context = client ? this.buildStoreContext(undefined, client) : undefined;
    const entry = await this.getStore(databaseId, context);
    try {
      return entry.syncManager.getCurrentHLC();
    } finally {
      this.releaseStore(databaseId);
    }
  }

  /**
   * Get changes since a given HLC for a client.
   */
  async getChangesSince(
    databaseId: string,
    client: ClientIdentity,
    sinceHLC?: HLC
  ): Promise<ChangeSet[]> {
    serviceLog('getChangesSince db=%s client=%s, sinceHLC: %O',
      databaseId, siteIdToBase64(client.siteId), sinceHLC);

    const endTimer = this.metrics.registry.startTimer(this.metrics.getChangesDuration);

    // Authorize
    const allowed = await this.authorize(client, { type: 'get_changes', sinceHLC });
    if (!allowed) {
      throw new Error('Not authorized');
    }

    const context = this.buildStoreContext(undefined, client);
    const entry = await this.getStore(databaseId, context);
    try {
      const changes = await entry.syncManager.getChangesSince(client.siteId, sinceHLC);
      endTimer();
      return changes;
    } finally {
      this.releaseStore(databaseId);
    }
  }

  /**
   * Apply changes from a client.
   */
  async applyChanges(
    databaseId: string,
    client: ClientIdentity,
    changes: ChangeSet[]
  ): Promise<ApplyResult> {
    serviceLog('applyChanges db=%s from %s, count: %d',
      databaseId, siteIdToBase64(client.siteId), changes.length);

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

    const context = this.buildStoreContext(undefined, client);
    const entry = await this.getStore(databaseId, context);
    try {
      // Apply
      const result = await entry.syncManager.applyChanges(approvedChanges);
      serviceLog('Apply result: applied=%d, skipped=%d, conflicts=%d',
        result.applied, result.skipped, result.conflicts);
      endTimer();

      this.metrics.registry.incCounter(this.metrics.changesAppliedTotal, {}, result.applied);

      // Post-apply hook
      if (this.hooks.onAfterApplyChanges) {
        this.hooks.onAfterApplyChanges(client, approvedChanges, result);
      }

      // Store batch to S3 for durability (non-blocking)
      if (this.s3BatchStore && result.applied > 0) {
        this.s3BatchStore.storeBatch(
          databaseId,
          siteIdToBase64(client.siteId),
          approvedChanges,
          { applied: result.applied, skipped: result.skipped, conflicts: result.conflicts }
        ).catch(err => {
          serviceLog('S3 batch storage failed (non-fatal): %s', err.message);
        });
      }

      // Record changes for snapshot scheduling
      if (this.s3SnapshotStore && result.applied > 0) {
        this.s3SnapshotStore.recordChanges(databaseId, result.applied);

        // Check if snapshot is needed (non-blocking)
        if (this.s3SnapshotStore.needsSnapshot(databaseId)) {
          this.s3SnapshotStore.createSnapshot(databaseId, entry.syncManager).catch(err => {
            serviceLog('Snapshot creation failed (non-fatal): %s', err.message);
          });
        }
      }

      // Broadcast to other connected clients on the same database
      if (result.applied > 0) {
        serviceLog('Broadcasting %d changes to other clients on db=%s', approvedChanges.length, databaseId);
        this.broadcastChanges(databaseId, client.siteId, approvedChanges);
      } else {
        serviceLog('No changes applied, not broadcasting');
      }

      return result;
    } finally {
      this.releaseStore(databaseId);
    }
  }

  /**
   * Stream a full snapshot.
   */
  async *getSnapshotStream(
    databaseId: string,
    client: ClientIdentity,
    chunkSize?: number
  ): AsyncIterable<SnapshotChunk> {
    serviceLog('getSnapshotStream db=%s for %s',
      databaseId, siteIdToBase64(client.siteId));

    this.metrics.registry.incCounter(this.metrics.snapshotRequestsTotal);

    // Authorize
    const allowed = await this.authorize(client, { type: 'get_snapshot' });
    if (!allowed) {
      throw new Error('Not authorized');
    }

    const context = this.buildStoreContext(undefined, client);
    const entry = await this.getStore(databaseId, context);
    try {
      for await (const chunk of entry.syncManager.getSnapshotStream(chunkSize)) {
        this.metrics.registry.incCounter(this.metrics.snapshotChunksTotal);
        yield chunk;
      }
    } finally {
      this.releaseStore(databaseId);
    }
  }

  /**
   * Check if delta sync is possible.
   */
  async canDeltaSync(databaseId: string, client: ClientIdentity, sinceHLC: HLC): Promise<boolean> {
    const context = this.buildStoreContext(undefined, client);
    const entry = await this.getStore(databaseId, context);
    try {
      return entry.syncManager.canDeltaSync(client.siteId, sinceHLC);
    } finally {
      this.releaseStore(databaseId);
    }
  }

  // ============================================================================
  // WebSocket Session Management
  // ============================================================================

  /**
   * Register a new WebSocket client session.
   * @param databaseId The database to connect to
   * @param socket The WebSocket connection
   * @param identity The authenticated client identity
   * @param authContext Optional auth context with raw token for store hooks
   */
  async registerSession(
    databaseId: string,
    socket: WebSocket,
    identity: ClientIdentity,
    authContext?: AuthContext
  ): Promise<ClientSession> {
    const connectionId = randomUUID();
    const storeContext = this.buildStoreContext(authContext, identity);

    // Validate database ID
    if (!this.storeManager.validateDatabaseId(databaseId, storeContext)) {
      throw new Error(`Invalid database ID: ${databaseId}`);
    }

    // Call connect hook
    if (this.hooks.onClientConnect) {
      const allowed = await this.hooks.onClientConnect(identity, socket);
      if (!allowed) {
        throw new Error('Connection rejected');
      }
    }

    // Acquire store to ensure it's open while session is active
    const entry = await this.getStore(databaseId, storeContext);

    // Register cascade delete listener for account databases
    if (this.cascadeDeleteService) {
      try {
        const { type } = parseDatabaseId(databaseId);
        if (type === 'account') {
          this.cascadeDeleteService.registerAccountListener(databaseId, entry.storeEvents);
        }
      } catch {
        // Ignore parse errors for legacy database IDs
      }
    }

    const session: ClientSession = {
      connectionId,
      databaseId,
      siteId: identity.siteId,
      identity,
      lastSyncHLC: undefined,
      connectedAt: Date.now(),
      socket,
    };

    this.sessions.set(connectionId, session);

    // Track by databaseId for broadcasting
    let connections = this.databaseToConnections.get(databaseId);
    if (!connections) {
      connections = new Set();
      this.databaseToConnections.set(databaseId, connections);
    }
    connections.add(connectionId);

    // Update metrics
    this.metrics.registry.incCounter(this.metrics.wsConnectionsTotal);
    this.metrics.registry.incGauge(this.metrics.wsConnectionsActive);

    serviceLog('Session registered: %s (db: %s)',
      connectionId.slice(0, 8), databaseId);

    return session;
  }

  /**
   * Unregister a WebSocket client session.
   */
  unregisterSession(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    const { databaseId } = session;

    // Call disconnect hook
    if (this.hooks.onClientDisconnect) {
      this.hooks.onClientDisconnect(session.identity);
    }

    this.sessions.delete(connectionId);

    // Remove from databaseId tracking
    const connections = this.databaseToConnections.get(databaseId);
    if (connections) {
      connections.delete(connectionId);
      if (connections.size === 0) {
        this.databaseToConnections.delete(databaseId);
      }
    }

    // Release the store reference
    this.releaseStore(databaseId);

    // Update metrics
    this.metrics.registry.decGauge(this.metrics.wsConnectionsActive);

    serviceLog('Session unregistered: %s (db: %s)', connectionId.slice(0, 8), databaseId);
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
   * Broadcast changes to all connected clients on the same database except the sender.
   */
  private broadcastChanges(databaseId: string, senderSiteId: SiteId, changes: ChangeSet[]): void {
    // Serialize changesets for JSON transport
    const serializedChangeSets = changes.map(cs => this.serializeChangeSet(cs));
    const message = JSON.stringify({
      type: 'push_changes',
      changeSets: serializedChangeSets,
    });

    // Only broadcast to clients on the same database
    const connections = this.databaseToConnections.get(databaseId);
    if (!connections) return;

    let broadcastCount = 0;
    for (const connectionId of connections) {
      const session = this.sessions.get(connectionId);
      if (!session) continue;

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
   * Check if a database ID is valid.
   */
  isValidDatabaseId(databaseId: string): boolean {
    return this.storeManager.validateDatabaseId(databaseId);
  }

  /**
   * Get server status and stats.
   */
  getStatus(): {
    openStores: number;
    connectedClients: number;
    uptime: number;
  } {
    return {
      openStores: this.storeManager.openCount,
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

  // ============================================================================
  // Snapshot and Archive Operations
  // ============================================================================

  /**
   * Manually trigger a snapshot for a database.
   */
  async createSnapshot(databaseId: string, client?: ClientIdentity): Promise<{ snapshotId: string } | null> {
    if (!this.s3SnapshotStore) {
      serviceLog('Snapshot store not configured');
      return null;
    }

    const context = client ? this.buildStoreContext(undefined, client) : undefined;
    const entry = await this.getStore(databaseId, context);
    try {
      const metadata = await this.s3SnapshotStore.forceSnapshot(databaseId, entry.syncManager);
      return { snapshotId: metadata.snapshotId };
    } finally {
      this.releaseStore(databaseId);
    }
  }

  /**
   * Get databases that need snapshots according to schedule.
   */
  getDatabasesNeedingSnapshot(): string[] {
    if (!this.s3SnapshotStore) return [];
    return this.s3SnapshotStore.getDatabasesNeedingSnapshot();
  }

  /**
   * Manually cascade delete a site and its related databases.
   */
  async cascadeDeleteSite(orgId: string, siteId: string, deletedBy: string | null): Promise<void> {
    if (!this.cascadeDeleteService) {
      throw new Error('Cascade delete service not configured');
    }
    await this.cascadeDeleteService.cascadeDeleteSite(orgId, siteId, deletedBy);
  }
}

