/**
 * S3 Batch Store - Durable storage for sync batches.
 *
 * Uploads sync batches to S3 after each debounced sync operation,
 * providing durability and enabling disaster recovery.
 */

import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { serviceLog } from '../common/logger.js';
import {
  type S3StorageConfig,
  buildBatchKey,
} from './s3-config.js';
import { parseDatabaseId } from './database-ids.js';

/**
 * A sync batch to be stored in S3.
 */
export interface SyncBatch {
  /** Unique batch identifier */
  batchId: string;

  /** Database ID this batch belongs to */
  databaseId: string;

  /** Timestamp when batch was created */
  timestamp: string;

  /** Client ID that originated the changes */
  clientId: string;

  /** The sync changes in this batch */
  changes: unknown[];

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * S3 Batch Store for durable sync batch storage.
 */
export class S3BatchStore {
  private readonly client: S3Client;
  private readonly config: S3StorageConfig;

  constructor(client: S3Client, config: S3StorageConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * Store a sync batch in S3.
   *
   * @param databaseId - Database ID in format <org_id>:<type>_<id>
   * @param clientId - Client that originated the changes
   * @param changes - The sync changes to store
   * @param metadata - Optional metadata to include
   * @returns The stored batch with its ID and timestamp
   */
  async storeBatch(
    databaseId: string,
    clientId: string,
    changes: unknown[],
    metadata?: Record<string, unknown>
  ): Promise<SyncBatch> {
    const batchId = randomUUID();
    const timestamp = new Date().toISOString();

    // Parse database ID to get org and db parts
    const { orgId, dbPart } = parseDatabaseId(databaseId);

    const batch: SyncBatch = {
      batchId,
      databaseId,
      timestamp,
      clientId,
      changes,
      metadata,
    };

    const key = buildBatchKey(this.config, orgId, dbPart, batchId, timestamp);
    const body = JSON.stringify(batch);

    serviceLog('Storing sync batch to S3: %s (%d changes)', key, changes.length);

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        Metadata: {
          'x-batch-id': batchId,
          'x-database-id': databaseId,
          'x-client-id': clientId,
          'x-change-count': String(changes.length),
        },
      }));

      serviceLog('Sync batch stored successfully: %s', batchId);
      return batch;
    } catch (error) {
      serviceLog('Failed to store sync batch: %s - %s', batchId, error);
      throw error;
    }
  }

  /**
   * Store multiple batches in parallel.
   */
  async storeBatches(
    batches: Array<{
      databaseId: string;
      clientId: string;
      changes: unknown[];
      metadata?: Record<string, unknown>;
    }>
  ): Promise<SyncBatch[]> {
    return Promise.all(
      batches.map(b => this.storeBatch(b.databaseId, b.clientId, b.changes, b.metadata))
    );
  }
}

/**
 * Create an S3 batch store from configuration.
 */
export function createS3BatchStore(
  client: S3Client,
  config: S3StorageConfig
): S3BatchStore {
  return new S3BatchStore(client, config);
}

