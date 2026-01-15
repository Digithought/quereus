/**
 * sync-coordinator - Standalone coordinator backend for Quereus Sync.
 *
 * This package provides a production-ready sync server that can be deployed
 * independently or embedded in existing applications.
 *
 * @example
 * ```typescript
 * import { createCoordinatorServer, loadConfig } from '@quereus/sync-coordinator';
 *
 * const config = loadConfig({ overrides: { port: 8080 } });
 * const server = await createCoordinatorServer({ config });
 * await server.start();
 * ```
 */

// Configuration
export {
  type CoordinatorConfig,
  type PartialCoordinatorConfig,
  type CorsConfig,
  type AuthConfig,
  type SyncSettings,
  type LoggingConfig,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigFile,
  loadEnvConfig,
} from './config/index.js';

// Service layer
export {
  type ClientIdentity,
  type ClientSession,
  type AuthContext,
  type SyncOperation,
  type RejectedChange,
  type ValidationResult,
  type CoordinatorHooks,
  CoordinatorService,
  type CoordinatorServiceOptions,
  StoreManager,
  type StoreEntry,
  type StoreManagerConfig,
  type StoreManagerHooks,
  type StoreContext,
  // S3 Storage
  type S3StorageConfig,
  createS3Client,
  buildBatchKey,
  buildSnapshotKey,
  parseS3ConfigFromEnv,
  S3BatchStore,
  createS3BatchStore,
  type SyncBatch,
  S3SnapshotStore,
  createS3SnapshotStore,
  type SnapshotMetadata,
  type SnapshotScheduleConfig,
  // Cascade Delete
  CascadeDeleteService,
  type ArchiveRecord,
  type ArchiveStore,
  type RelatedDatabaseQuery,
  type CascadeDeleteServiceConfig,
  // Database IDs
  parseDatabaseId,
  getDatabaseStoragePath,
  buildDatabaseId,
  isValidDatabaseId,
  type ParsedDatabaseId,
  type DatabaseType,
} from './service/index.js';

// Server
export {
  createCoordinatorServer,
  type CoordinatorServer,
  type CoordinatorServerOptions,
  registerRoutes,
  registerWebSocket,
} from './server/index.js';

// Metrics
export {
  type CoordinatorMetrics,
  type CounterMetric,
  type GaugeMetric,
  type HistogramMetric,
  MetricsRegistry,
  globalRegistry,
  createCoordinatorMetrics,
} from './metrics/index.js';

// Common utilities
export { createLogger } from './common/index.js';

