/**
 * Configuration module exports.
 */

export {
  type CoordinatorConfig,
  type PartialCoordinatorConfig,
  type CorsConfig,
  type AuthConfig,
  type SyncSettings,
  type LoggingConfig,
  DEFAULT_CONFIG,
} from './types.js';

export {
  loadConfig,
  loadConfigFile,
  loadEnvConfig,
} from './loader.js';

