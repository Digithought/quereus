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
} from './store-manager.js';

export {
  isValidDatabaseId,
  parseDatabaseId,
  formatDatabaseId,
} from './database-ids.js';

