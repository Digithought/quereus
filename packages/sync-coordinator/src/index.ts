/**
 * sync-coordinator - Standalone coordinator backend for Quereus Sync.
 *
 * This package provides a production-ready sync server that can be deployed
 * independently or embedded in existing applications.
 *
 * @example
 * ```typescript
 * import { createCoordinatorServer, loadConfig } from 'sync-coordinator';
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

