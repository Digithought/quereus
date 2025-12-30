/**
 * Service layer types - hooks, sessions, and operations.
 */

import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import type {
  SiteId,
  HLC,
  ChangeSet,
  ApplyResult,
} from '@quereus/plugin-sync';

// ============================================================================
// Client Identity & Sessions
// ============================================================================

/**
 * Authenticated client identity.
 * Extend this interface for custom auth data.
 */
export interface ClientIdentity {
  /** Client's site ID for sync */
  siteId: SiteId;
  /** Optional user ID from authentication */
  userId?: string;
  /** Optional additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Active WebSocket client session.
 */
export interface ClientSession {
  /** Unique connection identifier */
  connectionId: string;
  /** Client's replica site ID */
  siteId: SiteId;
  /** Authenticated identity */
  identity: ClientIdentity;
  /** Last HLC client synced to */
  lastSyncHLC: HLC | undefined;
  /** Connection timestamp */
  connectedAt: number;
  /** The WebSocket connection */
  socket: WebSocket;
}

// ============================================================================
// Authentication & Authorization
// ============================================================================

/**
 * Context provided to authentication hook.
 */
export interface AuthContext {
  /** Authorization header value */
  token?: string;
  /** Client-provided site ID */
  siteId?: SiteId;
  /** Raw site ID string from header */
  siteIdRaw?: string;
  /** Original HTTP request (if available) */
  request?: FastifyRequest;
  /** WebSocket connection (if WebSocket auth) */
  socket?: WebSocket;
}

/**
 * Sync operations that can be authorized.
 */
export type SyncOperation =
  | { type: 'get_changes'; sinceHLC?: HLC }
  | { type: 'apply_changes'; changeCount: number }
  | { type: 'get_snapshot' }
  | { type: 'resume_snapshot' };

// ============================================================================
// Change Validation
// ============================================================================

/**
 * A change that was rejected during validation.
 */
export interface RejectedChange {
  /** The rejected change */
  change: ChangeSet;
  /** Reason for rejection */
  reason: string;
  /** Error code for programmatic handling */
  code?: string;
}

/**
 * Result of change validation.
 */
export interface ValidationResult {
  /** Changes approved for application */
  approved: ChangeSet[];
  /** Changes that were rejected */
  rejected: RejectedChange[];
}

// ============================================================================
// Hook Definitions
// ============================================================================

/**
 * Coordinator service hooks for customization.
 * All hooks are optional; defaults allow all operations.
 */
export interface CoordinatorHooks {
  /**
   * Authenticate an incoming request/connection.
   * Called before any sync operation.
   *
   * @param context - Auth context with token and request info
   * @returns Client identity on success
   * @throws Error to reject authentication
   */
  onAuthenticate?(context: AuthContext): Promise<ClientIdentity>;

  /**
   * Authorize a specific operation for a client.
   * Called after authentication, before executing the operation.
   *
   * @param client - Authenticated client identity
   * @param operation - The operation being requested
   * @returns true to allow, false to deny
   */
  onAuthorize?(client: ClientIdentity, operation: SyncOperation): Promise<boolean>;

  /**
   * Validate changes before applying them.
   * Can modify, filter, or reject changes.
   *
   * @param client - Authenticated client identity
   * @param changes - Changes to validate
   * @returns Approved and rejected changes
   */
  onBeforeApplyChanges?(
    client: ClientIdentity,
    changes: ChangeSet[]
  ): Promise<ValidationResult>;

  /**
   * Called after changes are successfully applied.
   * Useful for logging, metrics, or triggering side effects.
   *
   * @param client - Authenticated client identity
   * @param changes - Changes that were applied
   * @param result - Result of the apply operation
   */
  onAfterApplyChanges?(
    client: ClientIdentity,
    changes: ChangeSet[],
    result: ApplyResult
  ): void;

  /**
   * Called when a WebSocket client connects.
   * Return false to reject the connection.
   *
   * @param client - Authenticated client identity
   * @param socket - The WebSocket connection
   * @returns true to accept, false to reject
   */
  onClientConnect?(client: ClientIdentity, socket: WebSocket): Promise<boolean>;

  /**
   * Called when a WebSocket client disconnects.
   *
   * @param client - Client identity of disconnected client
   */
  onClientDisconnect?(client: ClientIdentity): void;
}

