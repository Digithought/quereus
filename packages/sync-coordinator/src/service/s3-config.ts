/**
 * S3 configuration for durable batch storage.
 *
 * Supports both AWS S3 and S3-compatible services like MinIO.
 */

import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * S3 storage configuration.
 */
export interface S3StorageConfig {
  /** S3 bucket name for storing sync batches */
  bucket: string;

  /** AWS region (e.g., 'us-east-1') */
  region: string;

  /**
   * Optional endpoint URL for S3-compatible services (e.g., MinIO).
   * If not provided, uses AWS S3.
   *
   * @example 'http://localhost:9000' for local MinIO
   */
  endpoint?: string;

  /**
   * AWS credentials. If not provided, uses default credential chain.
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };

  /**
   * Force path-style URLs (required for MinIO and some S3-compatible services).
   * Default: false (uses virtual-hosted style for AWS S3)
   */
  forcePathStyle?: boolean;

  /**
   * Key prefix for all objects in the bucket.
   * Useful for organizing data or sharing a bucket across environments.
   *
   * @example 'sync-batches/' or 'dev/sync-batches/'
   */
  keyPrefix?: string;
}

/**
 * Create an S3 client from configuration.
 */
export function createS3Client(config: S3StorageConfig): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.region,
  };

  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint;
  }

  if (config.credentials) {
    clientConfig.credentials = config.credentials;
  }

  if (config.forcePathStyle) {
    clientConfig.forcePathStyle = true;
  }

  return new S3Client(clientConfig);
}

/**
 * Build the S3 key for a sync batch.
 *
 * Key format: <prefix><storagePath>/batches/<timestamp>_<batch_id>.json
 *
 * @param config - S3 storage configuration
 * @param storagePath - Storage path for the database (e.g., 'org123/s_abc123')
 * @param batchId - Unique batch identifier
 * @param timestamp - Batch timestamp (ISO format)
 */
export function buildBatchKey(
  config: S3StorageConfig,
  storagePath: string,
  batchId: string,
  timestamp: string
): string {
  const prefix = config.keyPrefix ?? '';
  // Use timestamp prefix for chronological ordering in S3 listings
  const timestampPrefix = timestamp.replace(/[:.]/g, '-');
  return `${prefix}${storagePath}/batches/${timestampPrefix}_${batchId}.json`;
}

/**
 * Build the S3 key for a database snapshot.
 *
 * Key format: <prefix><storagePath>/snapshots/<timestamp>_<snapshot_id>.json
 *
 * @param config - S3 storage configuration
 * @param storagePath - Storage path for the database (e.g., 'org123/s_abc123')
 * @param snapshotId - Unique snapshot identifier
 * @param timestamp - Snapshot timestamp (ISO format)
 */
export function buildSnapshotKey(
  config: S3StorageConfig,
  storagePath: string,
  snapshotId: string,
  timestamp: string
): string {
  const prefix = config.keyPrefix ?? '';
  const timestampPrefix = timestamp.replace(/[:.]/g, '-');
  return `${prefix}${storagePath}/snapshots/${timestampPrefix}_${snapshotId}.json`;
}

/**
 * Parse S3 configuration from environment variables.
 *
 * Environment variables:
 * - S3_BUCKET: Bucket name (required)
 * - S3_REGION: AWS region (default: 'us-east-1')
 * - S3_ENDPOINT: Custom endpoint for MinIO/compatible services
 * - S3_ACCESS_KEY_ID: Access key (optional, uses default chain if not set)
 * - S3_SECRET_ACCESS_KEY: Secret key (optional)
 * - S3_FORCE_PATH_STYLE: Set to 'true' for MinIO
 * - S3_KEY_PREFIX: Key prefix for all objects
 */
export function parseS3ConfigFromEnv(): S3StorageConfig | undefined {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    return undefined;
  }

  const config: S3StorageConfig = {
    bucket,
    region: process.env.S3_REGION ?? 'us-east-1',
  };

  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
  }

  if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    };
  }

  if (process.env.S3_FORCE_PATH_STYLE === 'true') {
    config.forcePathStyle = true;
  }

  if (process.env.S3_KEY_PREFIX) {
    config.keyPrefix = process.env.S3_KEY_PREFIX;
  }

  return config;
}

