/**
 * Service layer exports.
 */

export {
  type ClientIdentity,
  type ClientSession,
  type AuthContext,
  type SyncOperation,
  type RejectedChange,
  type ValidationResult,
  type CoordinatorHooks,
} from './types.js';

export {
  CoordinatorService,
  type CoordinatorServiceOptions,
} from './coordinator-service.js';

export {
  StoreManager,
  type StoreEntry,
  type StoreManagerConfig,
  type StoreManagerHooks,
  type StoreContext,
} from './store-manager.js';

export {
  parseDatabaseId,
  getDatabaseStoragePath,
  buildDatabaseId,
  isValidDatabaseId,
  type ParsedDatabaseId,
  type DatabaseType,
} from './database-ids.js';

export {
  type S3StorageConfig,
  createS3Client,
  buildBatchKey,
  buildSnapshotKey,
  parseS3ConfigFromEnv,
} from './s3-config.js';

export {
  S3BatchStore,
  createS3BatchStore,
  type SyncBatch,
} from './s3-batch-store.js';

export {
  S3SnapshotStore,
  createS3SnapshotStore,
  type SnapshotMetadata,
  type SnapshotScheduleConfig,
} from './s3-snapshot-store.js';

export {
  CascadeDeleteService,
  type ArchiveRecord,
  type ArchiveStore,
  type RelatedDatabaseQuery,
  type CascadeDeleteServiceConfig,
} from './cascade-delete.js';
