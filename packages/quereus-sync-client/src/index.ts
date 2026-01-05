/**
 * @quereus/sync-client - WebSocket sync client for Quereus
 *
 * This package provides a WebSocket-based sync client that connects to a
 * sync server and handles bidirectional synchronization of changes.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Local change batching with debouncing
 * - Delta sync tracking (only send/receive changes since last sync)
 * - Event callbacks for status changes, remote changes, and errors
 *
 * @example
 * ```typescript
 * import { SyncClient } from '@quereus/sync-client';
 *
 * const client = new SyncClient({
 *   syncManager,
 *   onStatusChange: (status) => console.log('Status:', status),
 *   onRemoteChanges: (result) => console.log('Applied:', result.applied),
 * });
 *
 * await client.connect('ws://localhost:8080/sync', 'a1-s1');
 * ```
 *
 * @packageDocumentation
 */

export { SyncClient } from './sync-client.js';
export {
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
} from './serialization.js';
export type {
  SyncStatus,
  SyncEvent,
  SyncEventType,
  SyncClientOptions,
  SerializedChangeSet,
  SerializedChange,
  SerializedSchemaMigration,
  // Protocol message types (for server implementations)
  ClientMessage,
  ServerMessage,
  HandshakeMessage,
  HandshakeAckMessage,
  GetChangesMessage,
  ChangesMessage,
  PushChangesMessage,
  ApplyChangesMessage,
  ApplyResultMessage,
  GetSnapshotMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
} from './types.js';

