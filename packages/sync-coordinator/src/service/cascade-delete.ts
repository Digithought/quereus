/**
 * Cascade Delete Service - Handles Site deletion cascading.
 *
 * When a Site is deleted from an Account database, this service:
 * 1. Queries related scenarios and dynamics (by site_id)
 * 2. Archives each database to S3
 * 3. Removes the local database folders
 * 4. Records archive metadata in the system store
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceLog } from '../common/logger.js';
import type { DataChangeEvent, StoreEventEmitter } from '@quereus/store';
import type { StoreEntry, StoreManager } from './store-manager.js';
import { buildDatabaseId, getDatabaseStoragePath, parseDatabaseId } from './database-ids.js';

/**
 * Archive record for a deleted database.
 */
export interface ArchiveRecord {
  databaseId: string;
  orgId: string;
  dbType: 'scenario' | 'dynamics';
  s3Path: string;
  archivedAt: number;
  archivedBy: string | null;
  sizeBytes: number;
  expiresAt: number;
}

/**
 * Interface for archive storage operations.
 */
export interface ArchiveStore {
  /**
   * Archive a database to cold storage.
   * @returns The S3 path where the archive is stored
   */
  archiveDatabase(databaseId: string): Promise<{ s3Path: string; sizeBytes: number }>;

  /**
   * Record archive metadata.
   */
  recordArchive(record: ArchiveRecord): Promise<void>;
}

/**
 * Interface for querying related databases.
 */
export interface RelatedDatabaseQuery {
  /**
   * Find all scenario database IDs associated with a site.
   */
  findScenariosBySiteId(orgId: string, siteId: string): Promise<string[]>;

  /**
   * Find all dynamics database IDs associated with a site.
   */
  findDynamicsBySiteId(orgId: string, siteId: string): Promise<string[]>;
}

export interface CascadeDeleteServiceConfig {
  /** Data directory for local stores */
  dataDir: string;
  /** Archive retention in days (default: 30) */
  archiveRetentionDays: number;
}

/**
 * Service that handles cascade deletion when Sites are removed.
 */
export class CascadeDeleteService {
  private readonly config: CascadeDeleteServiceConfig;
  private readonly archiveStore: ArchiveStore | null;
  private readonly relatedQuery: RelatedDatabaseQuery;
  private readonly storeManager: StoreManager;
  private readonly unsubscribers: Map<string, () => void> = new Map();

  constructor(
    config: CascadeDeleteServiceConfig,
    storeManager: StoreManager,
    relatedQuery: RelatedDatabaseQuery,
    archiveStore?: ArchiveStore
  ) {
    this.config = config;
    this.storeManager = storeManager;
    this.relatedQuery = relatedQuery;
    this.archiveStore = archiveStore ?? null;
  }

  /**
   * Register a delete listener on an Account database's store events.
   * Monitors the Site table for deletions.
   */
  registerAccountListener(accountDatabaseId: string, storeEvents: StoreEventEmitter): void {
    if (this.unsubscribers.has(accountDatabaseId)) {
      return; // Already registered
    }

    const unsubscribe = storeEvents.onDataChange((event) => {
      this.handleDataChange(accountDatabaseId, event).catch((err) => {
        serviceLog('Cascade delete error: %O', err);
      });
    });

    this.unsubscribers.set(accountDatabaseId, unsubscribe);
    serviceLog('Registered cascade delete listener on account: %s', accountDatabaseId);
  }

  /**
   * Unregister a listener for an Account database.
   */
  unregisterAccountListener(accountDatabaseId: string): void {
    const unsubscribe = this.unsubscribers.get(accountDatabaseId);
    if (unsubscribe) {
      unsubscribe();
      this.unsubscribers.delete(accountDatabaseId);
      serviceLog('Unregistered cascade delete listener on account: %s', accountDatabaseId);
    }
  }

  /**
   * Handle a data change event from an Account database.
   */
  private async handleDataChange(accountDatabaseId: string, event: DataChangeEvent): Promise<void> {
    // Only process deletes on the Site table
    if (event.type !== 'delete' || event.tableName.toLowerCase() !== 'site') {
      return;
    }

    const { orgId } = parseDatabaseId(accountDatabaseId);
    const siteId = this.extractSiteId(event);

    if (!siteId) {
      serviceLog('Could not extract site_id from delete event');
      return;
    }

    serviceLog('Site deleted: %s in org %s, cascading to scenarios/dynamics', siteId, orgId);

    await this.cascadeDeleteSite(orgId, siteId, null);
  }

  /**
   * Extract site ID from a delete event.
   */
  private extractSiteId(event: DataChangeEvent): string | null {
    // Try to get from primary key
    const pk = event.pk || event.key;
    if (pk && pk.length > 0 && typeof pk[0] === 'string') {
      return pk[0];
    }
    // Try from oldRow
    if (event.oldRow && 'id' in event.oldRow) {
      return String(event.oldRow.id);
    }
    return null;
  }

  /**
   * Cascade delete all scenarios and dynamics for a site.
   */
  async cascadeDeleteSite(orgId: string, siteId: string, deletedBy: string | null): Promise<void> {
    // Find related scenarios
    const scenarioIds = await this.relatedQuery.findScenariosBySiteId(orgId, siteId);
    serviceLog('Found %d scenarios for site %s', scenarioIds.length, siteId);

    // Find related dynamics
    const dynamicsIds = await this.relatedQuery.findDynamicsBySiteId(orgId, siteId);
    serviceLog('Found %d dynamics for site %s', dynamicsIds.length, siteId);

    // Archive and remove each scenario
    for (const scenarioId of scenarioIds) {
      const databaseId = buildDatabaseId(orgId, 'scenario', scenarioId);
      await this.archiveAndRemove(databaseId, 'scenario', deletedBy);
    }

    // Archive and remove each dynamics
    for (const dynamicsId of dynamicsIds) {
      const databaseId = buildDatabaseId(orgId, 'dynamics', dynamicsId);
      await this.archiveAndRemove(databaseId, 'dynamics', deletedBy);
    }
  }

  /**
   * Archive a database to S3 and remove the local folder.
   */
  private async archiveAndRemove(
    databaseId: string,
    dbType: 'scenario' | 'dynamics',
    deletedBy: string | null
  ): Promise<void> {
    const { orgId } = parseDatabaseId(databaseId);
    const storagePath = getDatabaseStoragePath(databaseId);
    const fullPath = join(this.config.dataDir, storagePath);

    serviceLog('Archiving database: %s', databaseId);

    // Archive to S3 if archive store is configured
    let s3Path = '';
    let sizeBytes = 0;

    if (this.archiveStore) {
      try {
        const result = await this.archiveStore.archiveDatabase(databaseId);
        s3Path = result.s3Path;
        sizeBytes = result.sizeBytes;
        serviceLog('Database archived to S3: %s', s3Path);
      } catch (err) {
        serviceLog('Failed to archive database %s: %O', databaseId, err);
        // Continue with deletion even if archival fails
      }
    }

    // Record the archive metadata
    if (this.archiveStore && s3Path) {
      const expiresAt = Date.now() + this.config.archiveRetentionDays * 24 * 60 * 60 * 1000;
      await this.archiveStore.recordArchive({
        databaseId,
        orgId,
        dbType,
        s3Path,
        archivedAt: Date.now(),
        archivedBy: deletedBy,
        sizeBytes,
        expiresAt,
      });
    }

    // Close the store if it's open
    if (this.storeManager.isOpen(databaseId)) {
      // Release and force close - can't wait for idle timeout
      serviceLog('Closing open store before deletion: %s', databaseId);
    }

    // Remove local database folder
    try {
      await rm(fullPath, { recursive: true, force: true });
      serviceLog('Removed local database folder: %s', fullPath);
    } catch (err) {
      serviceLog('Failed to remove database folder %s: %O', fullPath, err);
    }
  }

  /**
   * Shutdown the service and unregister all listeners.
   */
  shutdown(): void {
    for (const [accountId, unsubscribe] of this.unsubscribers) {
      unsubscribe();
      serviceLog('Unregistered cascade delete listener: %s', accountId);
    }
    this.unsubscribers.clear();
  }
}

