/**
 * Sync protocol types - transport-agnostic data structures.
 *
 * These types define the sync protocol without assuming any transport layer.
 * Applications can serialize these to JSON, MessagePack, protobuf, etc.
 * and send via WebSocket, HTTP, WebRTC, or any other transport.
 */

import type { Row, SqlValue } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';

// ============================================================================
// Change Types
// ============================================================================

/**
 * A single column modification within a row.
 */
export interface ColumnChange {
  readonly type: 'column';
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];      // Primary key values identifying the row
  readonly column: string;      // Column name
  readonly value: SqlValue;     // New value
  readonly hlc: HLC;            // When this change occurred
}

/**
 * A row deletion.
 */
export interface RowDeletion {
  readonly type: 'delete';
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];      // Primary key of deleted row
  readonly hlc: HLC;            // When deletion occurred
}

/**
 * Union type for all change kinds.
 */
export type Change = ColumnChange | RowDeletion;

// ============================================================================
// Schema Migration Types
// ============================================================================

/**
 * Types of schema migrations.
 */
export type SchemaMigrationType =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'add_index'
  | 'drop_index'
  | 'alter_column';

/**
 * A schema migration record.
 */
export interface SchemaMigration {
  readonly type: SchemaMigrationType;
  readonly schema: string;
  readonly table: string;
  readonly ddl: string;           // The DDL statement
  readonly hlc: HLC;              // When migration occurred
  readonly schemaVersion: number; // Monotonic per-table version
}

// ============================================================================
// Transaction-Grouped Changes
// ============================================================================

/**
 * A transaction's worth of changes.
 * All changes within a ChangeSet are applied atomically.
 */
export interface ChangeSet {
  /** Origin replica */
  readonly siteId: SiteId;
  /** Unique transaction identifier */
  readonly transactionId: string;
  /** Transaction commit time */
  readonly hlc: HLC;
  /** Data changes in this transaction */
  readonly changes: Change[];
  /** Schema migrations in this transaction */
  readonly schemaMigrations: SchemaMigration[];
}

// ============================================================================
// Sync API Types
// ============================================================================

/**
 * Result of applying changes from a peer.
 */
export interface ApplyResult {
  /** Changes successfully applied (winner was remote) */
  applied: number;
  /** Changes skipped (already present or local won) */
  skipped: number;
  /** Conflicts resolved via LWW */
  conflicts: number;
  /** Number of transactions processed */
  transactions: number;
}

/**
 * Column version entry for snapshot.
 */
export interface ColumnVersionEntry {
  readonly hlc: HLC;
  readonly value: SqlValue;
}

/**
 * Full snapshot of a table for initial sync or recovery.
 */
export interface TableSnapshot {
  readonly schema: string;
  readonly table: string;
  readonly rows: Row[];
  /** Column versions for each row, keyed by serialized PK + column name */
  readonly columnVersions: Map<string, ColumnVersionEntry>;
}

/**
 * Full database snapshot.
 */
export interface Snapshot {
  readonly siteId: SiteId;
  readonly hlc: HLC;
  readonly tables: TableSnapshot[];
  readonly schemaMigrations: SchemaMigration[];
}

// ============================================================================
// Streaming Snapshot
// ============================================================================

/**
 * Snapshot chunk types for streaming.
 */
export type SnapshotChunkType =
  | 'header'
  | 'table-start'
  | 'column-versions'
  | 'table-end'
  | 'schema-migration'
  | 'footer';

/**
 * Header chunk - sent first with metadata.
 */
export interface SnapshotHeaderChunk {
  readonly type: 'header';
  readonly siteId: SiteId;
  readonly hlc: HLC;
  readonly tableCount: number;
  readonly migrationCount: number;
  /** Unique identifier for this snapshot transfer. */
  readonly snapshotId: string;
}

/**
 * Table start chunk - marks beginning of a table's data.
 */
export interface SnapshotTableStartChunk {
  readonly type: 'table-start';
  readonly schema: string;
  readonly table: string;
  /** Estimated number of column version entries for this table. */
  readonly estimatedEntries: number;
}

/**
 * Column versions chunk - batch of column version entries.
 */
export interface SnapshotColumnVersionsChunk {
  readonly type: 'column-versions';
  readonly schema: string;
  readonly table: string;
  /** Column versions as [versionKey, hlc, value] tuples. */
  readonly entries: Array<[string, HLC, SqlValue]>;
}

/**
 * Table end chunk - marks end of a table's data.
 */
export interface SnapshotTableEndChunk {
  readonly type: 'table-end';
  readonly schema: string;
  readonly table: string;
  readonly entriesWritten: number;
}

/**
 * Schema migration chunk.
 */
export interface SnapshotSchemaMigrationChunk {
  readonly type: 'schema-migration';
  readonly migration: SchemaMigration;
}

/**
 * Footer chunk - sent last with checksum/stats.
 */
export interface SnapshotFooterChunk {
  readonly type: 'footer';
  readonly snapshotId: string;
  readonly totalTables: number;
  readonly totalEntries: number;
  readonly totalMigrations: number;
}

/**
 * Union of all snapshot chunk types.
 */
export type SnapshotChunk =
  | SnapshotHeaderChunk
  | SnapshotTableStartChunk
  | SnapshotColumnVersionsChunk
  | SnapshotTableEndChunk
  | SnapshotSchemaMigrationChunk
  | SnapshotFooterChunk;

/**
 * Progress info during snapshot streaming.
 */
export interface SnapshotProgress {
  readonly snapshotId: string;
  readonly tablesProcessed: number;
  readonly totalTables: number;
  readonly entriesProcessed: number;
  readonly totalEntries: number;
  readonly currentTable?: string;
}

// ============================================================================
// Apply-to-Store Callback Types
// ============================================================================

/**
 * Options for applying changes to the store.
 */
export interface ApplyToStoreOptions {
  /**
   * Mark resulting events as remote (from sync).
   * When true, the store should emit events with `remote: true`,
   * preventing the SyncManager from re-recording CRDT metadata.
   */
  readonly remote: boolean;
}

/**
 * A data change to apply to the store.
 */
export interface DataChangeToApply {
  readonly type: 'insert' | 'update' | 'delete';
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];
  /** Column values to apply. Keys are column names, values are column values. */
  readonly columns?: Record<string, SqlValue>;
}

/**
 * A schema change to apply to the store.
 */
export interface SchemaChangeToApply {
  readonly type: SchemaMigrationType;
  readonly schema: string;
  readonly table: string;
  /** The DDL statement to execute. */
  readonly ddl: string;
}

/**
 * Result of applying changes to the store.
 */
export interface ApplyToStoreResult {
  /** Number of data changes successfully applied. */
  dataChangesApplied: number;
  /** Number of schema changes successfully applied. */
  schemaChangesApplied: number;
  /** Errors encountered (empty if all succeeded). */
  errors: Array<{ change: DataChangeToApply | SchemaChangeToApply; error: Error }>;
}

/**
 * Callback interface for applying remote changes to the store.
 *
 * The SyncManager uses this callback to apply changes from remote replicas.
 * The implementation should:
 * 1. Execute the changes against the actual data store
 * 2. Emit events with `remote: true` when `options.remote` is true
 *
 * This allows the store plugin to handle the actual data manipulation
 * while the sync module handles CRDT metadata.
 */
export type ApplyToStoreCallback = (
  dataChanges: DataChangeToApply[],
  schemaChanges: SchemaChangeToApply[],
  options: ApplyToStoreOptions
) => Promise<ApplyToStoreResult>;

// ============================================================================
// Peer State Tracking
// ============================================================================

/**
 * Tracks sync state with a specific peer.
 */
export interface PeerSyncState {
  readonly peerSiteId: SiteId;
  /** Last HLC we've synced up to with this peer */
  readonly lastSyncHLC: HLC;
  /** When we last successfully synced */
  readonly lastSyncTime: number;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Sync module configuration.
 */
export interface SyncConfig {
  /**
   * Tombstone retention period in milliseconds.
   * After this period, delta sync may not be possible.
   * Default: 30 days (30 * 24 * 60 * 60 * 1000)
   */
  tombstoneTTL: number;

  /**
   * Whether deleted rows can be resurrected by later writes.
   * If false (default), a deletion prevents any column write with earlier HLC.
   * If true, an insert/update with later HLC can resurrect a deleted row.
   */
  allowResurrection: boolean;

  /**
   * Maximum number of changes to return in a single sync batch.
   * Default: 1000
   */
  batchSize: number;

  /**
   * Pre-configured site ID. If not provided, one will be generated.
   */
  siteId?: SiteId;
}

/**
 * Default sync configuration.
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  tombstoneTTL: 30 * 24 * 60 * 60 * 1000,  // 30 days
  allowResurrection: false,
  batchSize: 1000,
};

