/**
 * S3 Snapshot Store - Full database snapshots for faster restore.
 *
 * Stores periodic full snapshots to S3 at:
 *   <prefix><storage_path>/snapshots/<timestamp>_<snapshot_id>.json.gz
 *
 * Snapshots are triggered by:
 * - Time interval (e.g., every 5 minutes)
 * - Change volume threshold (e.g., every 1000 changes)
 */

import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { serviceLog } from '../common/logger.js';
import { type S3StorageConfig, buildSnapshotKey } from './s3-config.js';
import type { SyncManager, SnapshotChunk, SnapshotColumnVersionsChunk } from '@quereus/sync';

/**
 * Snapshot metadata stored alongside the snapshot.
 */
export interface SnapshotMetadata {
  /** Unique snapshot identifier */
  snapshotId: string;

  /** Database ID this snapshot belongs to */
  databaseId: string;

  /** Timestamp when snapshot was created */
  timestamp: string;

  /** Total number of rows in the snapshot */
  totalRows: number;

  /** Total number of tables in the snapshot */
  totalTables: number;

  /** Compressed size in bytes */
  compressedSizeBytes: number;

  /** HLC timestamp of latest change in snapshot */
  hlcTimestamp?: string;
}

/**
 * Configuration for periodic snapshots.
 */
export interface SnapshotScheduleConfig {
  /** Interval in milliseconds between snapshots (default: 5 minutes) */
  intervalMs: number;

  /** Change count threshold to trigger snapshot (default: 1000) */
  changeThreshold: number;

  /** Maximum number of snapshots to retain per database (default: 5) */
  maxRetained: number;
}

const DEFAULT_SCHEDULE_CONFIG: SnapshotScheduleConfig = {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  changeThreshold: 1000,
  maxRetained: 5,
};

/**
 * Tracker for pending snapshot operations.
 */
interface DatabaseSnapshotState {
  lastSnapshotAt: number;
  changesSinceSnapshot: number;
  snapshotInProgress: boolean;
}

/**
 * Function to resolve a database ID to a storage path for S3 keys.
 */
export type StoragePathResolver = (databaseId: string) => string;

/**
 * Default storage path resolver - sanitizes databaseId for use as S3 path.
 */
function defaultStoragePathResolver(databaseId: string): string {
  return databaseId.replace(/:/g, '/').replace(/[^a-zA-Z0-9/_-]/g, '_');
}

/**
 * S3 Snapshot Store for full database snapshots.
 */
export class S3SnapshotStore {
  private readonly client: S3Client;
  private readonly config: S3StorageConfig;
  private readonly scheduleConfig: SnapshotScheduleConfig;
  private readonly resolveStoragePath: StoragePathResolver;
  private readonly databaseStates = new Map<string, DatabaseSnapshotState>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    client: S3Client,
    config: S3StorageConfig,
    scheduleConfig: Partial<SnapshotScheduleConfig> = {},
    resolveStoragePath?: StoragePathResolver
  ) {
    this.client = client;
    this.config = config;
    this.scheduleConfig = { ...DEFAULT_SCHEDULE_CONFIG, ...scheduleConfig };
    this.resolveStoragePath = resolveStoragePath ?? defaultStoragePathResolver;
  }

  /**
   * Start periodic snapshot checks.
   */
  start(): void {
    if (this.checkTimer) return;
    // Check every 30 seconds for databases needing snapshots
    this.checkTimer = setInterval(() => this.checkScheduledSnapshots(), 30_000);
    serviceLog('S3SnapshotStore started with interval=%dms, threshold=%d',
      this.scheduleConfig.intervalMs, this.scheduleConfig.changeThreshold);
  }

  /**
   * Stop periodic snapshot checks.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Record that changes have been applied to a database.
   */
  recordChanges(databaseId: string, changeCount: number): void {
    let state = this.databaseStates.get(databaseId);
    if (!state) {
      state = {
        lastSnapshotAt: 0,
        changesSinceSnapshot: 0,
        snapshotInProgress: false,
      };
      this.databaseStates.set(databaseId, state);
    }
    state.changesSinceSnapshot += changeCount;
  }

  /**
   * Check if a database needs a snapshot based on time or change volume.
   */
  needsSnapshot(databaseId: string): boolean {
    const state = this.databaseStates.get(databaseId);
    if (!state || state.snapshotInProgress) return false;

    const now = Date.now();
    const timeSinceSnapshot = now - state.lastSnapshotAt;

    // Check time interval
    if (timeSinceSnapshot >= this.scheduleConfig.intervalMs) {
      return true;
    }

    // Check change threshold
    if (state.changesSinceSnapshot >= this.scheduleConfig.changeThreshold) {
      return true;
    }

    return false;
  }

  /**
   * Check all tracked databases for scheduled snapshots.
   */
  private checkScheduledSnapshots(): void {
    for (const databaseId of this.databaseStates.keys()) {
      if (this.needsSnapshot(databaseId)) {
        serviceLog('Scheduled snapshot triggered for: %s', databaseId);
        // Note: actual snapshot creation requires the SyncManager,
        // which should be called by the coordinator
      }
    }
  }

  /**
   * Create and store a full snapshot for a database.
   */
  async createSnapshot(
    databaseId: string,
    syncManager: SyncManager
  ): Promise<SnapshotMetadata> {
    const state = this.databaseStates.get(databaseId) ?? {
      lastSnapshotAt: 0,
      changesSinceSnapshot: 0,
      snapshotInProgress: false,
    };
    this.databaseStates.set(databaseId, state);

    if (state.snapshotInProgress) {
      throw new Error(`Snapshot already in progress for ${databaseId}`);
    }

    state.snapshotInProgress = true;
    const snapshotId = randomUUID();
    const timestamp = new Date().toISOString();

    try {
      const storagePath = this.resolveStoragePath(databaseId);
      const key = buildSnapshotKey(this.config, storagePath, snapshotId, timestamp);

      // Stream snapshot chunks through gzip compression
      let totalEntries = 0;
      let totalTables = 0;
      const chunks: SnapshotChunk[] = [];

      for await (const chunk of syncManager.getSnapshotStream()) {
        chunks.push(chunk);
        if (this.isColumnVersionsChunk(chunk)) {
          totalEntries += chunk.entries?.length ?? 0;
        } else if (chunk.type === 'table-start') {
          totalTables++;
        }
      }

      // Serialize and compress
      const jsonData = JSON.stringify({ snapshotId, databaseId, timestamp, chunks });
      const compressed = await this.compressData(jsonData);

      // Upload to S3
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: compressed,
        ContentType: 'application/gzip',
        ContentEncoding: 'gzip',
        Metadata: {
          'x-snapshot-id': snapshotId,
          'x-database-id': databaseId,
          'x-entry-count': String(totalEntries),
          'x-table-count': String(totalTables),
        },
      }));

      const metadata: SnapshotMetadata = {
        snapshotId,
        databaseId,
        timestamp,
        totalRows: totalEntries, // Using entries count as "rows"
        totalTables,
        compressedSizeBytes: compressed.length,
      };

      serviceLog('Snapshot created: %s (%d entries, %d tables, %d bytes)',
        snapshotId, totalEntries, totalTables, compressed.length);

      // Update state
      state.lastSnapshotAt = Date.now();
      state.changesSinceSnapshot = 0;

      return metadata;
    } finally {
      state.snapshotInProgress = false;
    }
  }

  /**
   * Type guard to check if a chunk is a column-versions chunk.
   */
  private isColumnVersionsChunk(chunk: SnapshotChunk): chunk is SnapshotColumnVersionsChunk {
    return chunk.type === 'column-versions';
  }

  /**
   * Check if a snapshot exists for a database.
   */
  async hasSnapshot(databaseId: string): Promise<boolean> {
    const storagePath = this.resolveStoragePath(databaseId);
    // Check for latest snapshot pattern
    const prefix = this.config.keyPrefix ?? '';
    void `${prefix}${storagePath}/snapshots/`; // Key pattern for listing
    // Would need list operation to check, simplified for now
    return false;
  }

  /**
   * Compress data using gzip.
   */
  private async compressData(data: string): Promise<Buffer> {
    const gzip = createGzip();
    const buffers: Buffer[] = [];

    gzip.on('data', (chunk) => buffers.push(chunk));

    return new Promise((resolve, reject) => {
      gzip.on('end', () => resolve(Buffer.concat(buffers)));
      gzip.on('error', reject);
      gzip.end(Buffer.from(data, 'utf-8'));
    });
  }

  /**
   * Get databases that need snapshots (for external scheduling).
   */
  getDatabasesNeedingSnapshot(): string[] {
    const result: string[] = [];
    for (const databaseId of this.databaseStates.keys()) {
      if (this.needsSnapshot(databaseId)) {
        result.push(databaseId);
      }
    }
    return result;
  }

  /**
   * Force a snapshot for a database (ignoring schedule).
   */
  async forceSnapshot(databaseId: string, syncManager: SyncManager): Promise<SnapshotMetadata> {
    return this.createSnapshot(databaseId, syncManager);
  }

  /**
   * Get snapshot state for a database.
   */
  getState(databaseId: string): DatabaseSnapshotState | undefined {
    return this.databaseStates.get(databaseId);
  }
}

/**
 * Create an S3 snapshot store from configuration.
 */
export function createS3SnapshotStore(
  client: S3Client,
  config: S3StorageConfig,
  scheduleConfig?: Partial<SnapshotScheduleConfig>,
  resolveStoragePath?: StoragePathResolver
): S3SnapshotStore {
  return new S3SnapshotStore(client, config, scheduleConfig, resolveStoragePath);
}

