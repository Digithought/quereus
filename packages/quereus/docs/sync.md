# Sync Module - Multi-Master CRDT Replication

This document describes the architecture for `quereus-plugin-sync`, a fully automatic multi-master CRDT replication system for Quereus. It enables offline-first applications where multiple replicas can independently modify data and converge to a consistent state.

## Design Goals

- **Fully Automatic**: All tables in the store are automatically CRDT-enabled. No opt-in required.
- **Automatic Schema Evolution**: Schema changes are tracked and synchronized without special handling.
- **Transport Agnostic**: Exposes sync data structures and APIs without assuming any transport layer.
- **Backend Agnostic**: Works with both LevelDB (Node.js) and IndexedDB (browser) via the store plugin.
- **Reactive**: Exposes hooks for UI reactivity when data changes from local or remote sources.
- **Transaction-Aware**: Changes are grouped by transaction for atomic sync operations.

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         Application Layer                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────────┐ │
│  │   Quereus   │  │ Sync Hooks  │  │     Transport (user-provided)       │ │
│  │  Database   │  │ (reactive)  │  │  WebSocket / HTTP / WebRTC / etc.   │ │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────┬───────────────────┘ │
│         │                │                           │                      │
├─────────┼────────────────┼───────────────────────────┼──────────────────────┤
│         ▼                ▼                           ▼                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      quereus-plugin-sync                              │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │  │
│  │  │    HLC     │  │  Metadata  │  │   Sync     │  │    Schema      │  │  │
│  │  │   Clock    │  │   Store    │  │  Protocol  │  │   Tracker      │  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘  │  │
│  │                                                                       │  │
│  │  ┌────────────────────────────────────────────────────────────────┐  │  │
│  │  │                    SyncModule (wrapper)                         │  │  │
│  │  │  Intercepts mutations → Records CRDT metadata → Delegates       │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
├────────────────────────────────────┼────────────────────────────────────────┤
│                                    ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      quereus-plugin-store                             │  │
│  │  ┌─────────────────────────┐  ┌─────────────────────────┐            │  │
│  │  │   LevelDB (Node.js)     │  │   IndexedDB (Browser)   │            │  │
│  │  │   Data + CRDT Metadata  │  │   Data + CRDT Metadata  │            │  │
│  │  └─────────────────────────┘  └─────────────────────────┘            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Hybrid Logical Clock (HLC)

The sync module uses a Hybrid Logical Clock to establish causal ordering of events across distributed replicas. HLC combines:

- **Physical Time**: Wall clock time in milliseconds for rough ordering
- **Logical Counter**: Disambiguates events within the same millisecond
- **Site ID**: 16-byte UUID identifying each replica

```typescript
interface HLC {
  wallTime: bigint;      // Physical time (ms since epoch)
  counter: number;       // Logical counter (0-65535)
  siteId: Uint8Array;    // 16-byte replica UUID
}
```

HLC ordering: `(wallTime, counter, siteId)` compared lexicographically. This ensures:
- Events with higher wall time are considered newer
- Events at the same wall time are ordered by counter
- Ties are broken deterministically by site ID

### Conflict Resolution: Column-Level Last-Write-Wins (LWW)

Each column of each row is tracked independently. When the same column is modified on multiple replicas, the write with the highest HLC wins.

```
Replica A: UPDATE users SET name = 'Alice' WHERE id = 1  @ HLC(1000, 1, A)
Replica B: UPDATE users SET email = 'b@x.com' WHERE id = 1  @ HLC(1000, 2, B)

After merge: Row has name='Alice' (from A) AND email='b@x.com' (from B)
```

This is more fine-grained than row-level LWW, preserving more user intent.

> **Future Work**: The architecture supports extending to other CRDT types (counters, sets, RGA for text) by tracking different metadata per column type.

### Tombstones and Deletions

Deletions are recorded as "tombstones" with an HLC timestamp. Tombstones prevent deleted rows from being resurrected by older writes that arrive later.

**Resurrection Policy** (configurable):
- **Default: Delete Wins** - A deletion with HLC(T1) prevents any column write with HLC < T1
- **Optional: Resurrection Allowed** - An insert/update with HLC > T1 can resurrect a deleted row

**Tombstone TTL**: Tombstones are retained for a configurable duration (default: 30 days). Sync attempts after TTL expiration should fall back to full snapshot transfer.

### Transaction-Based Change Grouping

Changes are grouped by transaction. When syncing:
- All changes within a transaction are sent as a unit
- Applying changes is atomic per transaction
- This preserves referential integrity across related writes

## Storage Layout

CRDT metadata is stored alongside data in the same KV store using distinct key prefixes:

| Prefix | Purpose | Format |
|--------|---------|--------|
| `cv:{schema}.{table}:{pk}:{col}` | Column version | `{hlc, value}` |
| `tb:{schema}.{table}:{pk}` | Tombstone | `{hlc}` |
| `tx:{txId}` | Transaction record | `{changes[], hlc, committed}` |
| `ps:{siteId}` | Peer sync state | `{lastSyncHlc}` |
| `sm:{schema}.{table}:{version}` | Schema migration | `{ddl, hlc}` |
| `si:` | Site identity | `{siteId, createdAt}` |
| `hc:` | HLC state | `{wallTime, counter}` |

This co-location ensures:
- Atomic updates of data and metadata within transactions
- Single storage backend for both LevelDB and IndexedDB
- No additional database connections needed

## Sync Protocol

### Data Structures

```typescript
/** Identifies a specific replica in the network */
type SiteId = Uint8Array;  // 16-byte UUID

/** A transaction's worth of changes */
interface ChangeSet {
  siteId: SiteId;                    // Origin replica
  transactionId: string;             // Unique transaction ID
  hlc: HLC;                          // Transaction commit time
  changes: Change[];                 // Column-level changes
  schemaMigrations: SchemaMigration[]; // Schema changes in this tx
}

/** A single column modification */
interface ColumnChange {
  type: 'column';
  schema: string;
  table: string;
  pk: SqlValue[];                    // Primary key values
  column: string;
  value: SqlValue;
  hlc: HLC;
}

/** A row deletion */
interface RowDeletion {
  type: 'delete';
  schema: string;
  table: string;
  pk: SqlValue[];
  hlc: HLC;
}

type Change = ColumnChange | RowDeletion;

/** A schema modification */
interface SchemaMigration {
  type: 'create_table' | 'drop_table' | 'add_column' | 'drop_column' | 'add_index' | 'drop_index';
  schema: string;
  table: string;
  ddl: string;                       // The DDL statement
  hlc: HLC;
  schemaVersion: number;             // Monotonic per-table version
}
```

### Sync API

```typescript
interface SyncManager {
  /** Get this replica's site ID */
  getSiteId(): SiteId;

  /** Get current HLC for state comparison */
  getCurrentHLC(): HLC;

  /**
   * Get all changes since a peer's last known state.
   * For initial sync, omit sinceHLC to get full snapshot.
   */
  getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /**
   * Apply changes received from a peer.
   * Returns statistics about what was applied.
   */
  applyChanges(changes: ChangeSet[]): Promise<ApplyResult>;

  /**
   * Check if delta sync is possible or if snapshot is required.
   * Returns false if tombstone TTL has expired for relevant data.
   */
  canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean>;

  /**
   * Get a full snapshot for initial sync or TTL expiration recovery.
   */
  getSnapshot(): Promise<Snapshot>;

  /**
   * Apply a full snapshot (replaces all local data).
   */
  applySnapshot(snapshot: Snapshot): Promise<void>;
}

interface ApplyResult {
  applied: number;      // Changes successfully applied
  skipped: number;      // Changes already present (no-op due to LWW)
  conflicts: number;    // Conflicts resolved (remote won or lost)
  transactions: number; // Number of transactions processed
}

interface Snapshot {
  siteId: SiteId;
  hlc: HLC;
  tables: TableSnapshot[];
  schema: SchemaMigration[];
}

interface TableSnapshot {
  schema: string;
  table: string;
  rows: Row[];
  columnVersions: Map<string, HLC>;  // Per-column HLC for each row
}

// ============================================================================
// Streaming Snapshot API (for large datasets)
// ============================================================================

interface SyncManager {
  // ... existing methods ...

  /**
   * Stream a snapshot as chunks for memory-efficient transfer.
   * Use this instead of getSnapshot() for large databases.
   */
  getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk>;

  /**
   * Apply a streamed snapshot with progress tracking.
   * Supports resumption via checkpoint tracking.
   */
  applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void>;

  /**
   * Get a resumable checkpoint for an in-progress snapshot.
   */
  getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined>;

  /**
   * Resume a snapshot transfer from a checkpoint.
   */
  resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk>;
}

/** Snapshot chunk types for streaming */
type SnapshotChunk =
  | SnapshotHeaderChunk      // Sent first with metadata
  | SnapshotTableStartChunk  // Marks beginning of a table
  | SnapshotColumnVersionsChunk  // Batch of column versions
  | SnapshotTableEndChunk    // Marks end of a table
  | SnapshotSchemaMigrationChunk  // Schema migration
  | SnapshotFooterChunk;     // Sent last with stats

/** Progress info during snapshot streaming */
interface SnapshotProgress {
  snapshotId: string;
  tablesProcessed: number;
  totalTables: number;
  entriesProcessed: number;
  totalEntries: number;
  currentTable?: string;
}

/** Checkpoint for resumable snapshot transfers */
interface SnapshotCheckpoint {
  snapshotId: string;
  siteId: SiteId;
  hlc: HLC;
  lastTableIndex: number;
  lastEntryIndex: number;
  completedTables: string[];
  entriesProcessed: number;
  createdAt: number;
}
```

### Sync Flow (Master to Many-Masters)

For the primary use case of a master server syncing to many frontend replicas:

```
┌─────────────┐                              ┌─────────────┐
│   Master    │                              │  Frontend   │
│   Server    │                              │  Replica    │
└──────┬──────┘                              └──────┬──────┘
       │                                            │
       │  1. Frontend connects, sends:              │
       │     { mySiteId, lastSyncHLC }              │
       │◄───────────────────────────────────────────│
       │                                            │
       │  2. Master checks canDeltaSync()           │
       │     If false: send full snapshot           │
       │     If true: getChangesSince()             │
       │                                            │
       │  3. Master sends ChangeSet[]               │
       │────────────────────────────────────────────►
       │                                            │
       │  4. Frontend applies changes               │
       │     applyChanges(changeSets)               │
       │                                            │
       │  5. Frontend sends its local changes       │
       │     (changes made while offline)           │
       │◄───────────────────────────────────────────│
       │                                            │
       │  6. Master applies frontend changes        │
       │     Conflicts resolved via LWW             │
       │                                            │
       │  7. If conflicts, master re-sends winners  │
       │────────────────────────────────────────────►
       │                                            │
```

## Reactive Hooks

The sync module exposes reactive hooks for UI integration:

```typescript
interface SyncEventEmitter {
  /** Fired when remote changes are applied locally */
  onRemoteChange(listener: (event: RemoteChangeEvent) => void): () => void;

  /** Fired when local changes are ready to sync */
  onLocalChange(listener: (event: LocalChangeEvent) => void): () => void;

  /** Fired when sync state changes (connected, syncing, error) */
  onSyncStateChange(listener: (state: SyncState) => void): () => void;

  /** Fired when a conflict is resolved */
  onConflictResolved(listener: (event: ConflictEvent) => void): () => void;
}

interface RemoteChangeEvent {
  siteId: SiteId;                    // Origin replica
  transactionId: string;
  changes: Change[];
  appliedAt: HLC;
}

interface LocalChangeEvent {
  transactionId: string;
  changes: Change[];
  pendingSync: boolean;              // True if not yet synced to master
}

interface ConflictEvent {
  table: string;
  pk: SqlValue[];
  column: string;
  localValue: SqlValue;
  remoteValue: SqlValue;
  winner: 'local' | 'remote';
  winningHLC: HLC;
}

type SyncState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'syncing'; progress: number }
  | { status: 'synced'; lastSyncHLC: HLC }
  | { status: 'error'; error: Error };
```

### Integration with Store Events

The sync module subscribes to the store's `StoreEventEmitter` to capture all mutations:

```typescript
// Sync module listens to store events
storeEventEmitter.onDataChange((event) => {
  // Record CRDT metadata for this change
  syncModule.recordChange(event);

  // Emit for UI reactivity
  syncEventEmitter.emitLocalChange({
    transactionId: currentTxId,
    changes: [eventToChange(event)],
    pendingSync: true,
  });
});
```

## Schema Synchronization

Schema changes are tracked as first-class sync operations:

### Schema Version Tracking

Each table maintains a monotonically increasing schema version:

```typescript
interface TableSchemaState {
  schemaName: string;
  tableName: string;
  version: number;           // Increments on each schema change
  migrations: SchemaMigration[];  // History of changes
}
```

### Conflict Resolution: First-Writer-Wins

If two replicas make conflicting schema changes (e.g., adding columns with the same name but different types), the first change (by HLC) wins:

```
Replica A: ALTER TABLE users ADD COLUMN age INTEGER  @ HLC(1000, 1, A)
Replica B: ALTER TABLE users ADD COLUMN age TEXT     @ HLC(1000, 2, B)

Resolution: A's change wins (lower HLC). B receives A's migration and skips its own.
```

### Migration Application

```typescript
async applyMigrations(migrations: SchemaMigration[]): Promise<void> {
  // Sort by (table, schemaVersion)
  const sorted = migrations.sort((a, b) =>
    a.schemaVersion - b.schemaVersion
  );

  for (const migration of sorted) {
    const current = await this.getTableSchemaVersion(migration.table);

    if (migration.schemaVersion <= current) {
      // Already applied, check for conflict
      const existing = await this.getMigration(migration.table, migration.schemaVersion);
      if (existing && existing.ddl !== migration.ddl) {
        // Conflict: compare HLC, keep first writer
        if (compareHLC(migration.hlc, existing.hlc) < 0) {
          // Remote is older, it should have been applied
          // This is an error state - log warning
        }
      }
      continue;  // Skip already-applied
    }

    // Apply migration
    await this.db.exec(migration.ddl);
    await this.recordMigration(migration);
  }
}
```

## Configuration

```typescript
interface SyncConfig {
  /** Tombstone retention period in milliseconds (default: 30 days) */
  tombstoneTTL: number;

  /** Whether deleted rows can be resurrected by later writes (default: false) */
  allowResurrection: boolean;

  /** Maximum changes per sync batch (default: 1000) */
  batchSize: number;

  /** Site ID (auto-generated if not provided) */
  siteId?: Uint8Array;
}

// Usage
const sync = createSyncModule(storeModule, storeEventEmitter, {
  tombstoneTTL: 30 * 24 * 60 * 60 * 1000,  // 30 days
  allowResurrection: false,
  batchSize: 1000,
});
```

## Usage Example

```typescript
import { Database } from '@quereus/quereus';
import { LevelDBModule, LevelDBStore, StoreEventEmitter } from 'quereus-plugin-store';
import { createSyncModule } from 'quereus-plugin-sync';

// 1. Set up store with event emitter
const storeEvents = new StoreEventEmitter();
const store = new LevelDBModule(storeEvents);

// 2. Open a KV store for sync metadata
const kvStore = await LevelDBStore.open({ path: './sync-meta' });

// 3. Create sync module
const { syncManager, syncEvents } = await createSyncModule(kvStore, storeEvents, {
  tombstoneTTL: 30 * 24 * 60 * 60 * 1000,
});

// 4. Register store module with database
const db = new Database();
db.registerVtabModule('store', store);

// 5. Create tables (sync automatically tracks changes via storeEvents)
await db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT,
    email TEXT
  ) USING store(path='./data')
`);

// 6. Subscribe to sync events for UI
syncEvents.onRemoteChange((event) => {
  console.log('Remote changes applied:', event.changes.length);
  // Update UI, invalidate caches, etc.
});

syncEvents.onConflictResolved((event) => {
  console.log(`Conflict on ${event.table}.${event.column}: ${event.winner} won`);
});

// 7. Implement your transport layer
async function syncWithServer(ws: WebSocket) {
  // Get changes to send
  const localChanges = await syncManager.getChangesSince(
    serverSiteId,
    lastServerHLC
  );

  // Send via your transport
  ws.send(JSON.stringify({ type: 'changes', data: localChanges }));

  // Receive and apply server changes
  ws.onmessage = async (msg) => {
    const serverChanges = JSON.parse(msg.data);
    const result = await syncManager.applyChanges(serverChanges);
    console.log(`Applied ${result.applied} changes`);
  };
}
```

### Streaming Snapshot Example

For large databases, use streaming snapshots to avoid loading everything into memory:

```typescript
// Server: Stream snapshot to client
async function sendSnapshot(ws: WebSocket) {
  for await (const chunk of syncManager.getSnapshotStream(1000)) {
    ws.send(JSON.stringify(chunk));
  }
}

// Client: Apply streamed snapshot with progress
async function receiveSnapshot(ws: WebSocket) {
  const chunks = receiveChunks(ws); // Your async iterator over WebSocket messages

  await syncManager.applySnapshotStream(chunks, (progress) => {
    console.log(`Progress: ${progress.tablesProcessed}/${progress.totalTables} tables`);
    console.log(`Entries: ${progress.entriesProcessed}/${progress.totalEntries}`);
  });
}

// Resume interrupted snapshot
async function resumeSnapshot(ws: WebSocket) {
  const checkpoint = await syncManager.getSnapshotCheckpoint(snapshotId);
  if (checkpoint) {
    // Request resume from server
    ws.send(JSON.stringify({ type: 'resume', checkpoint }));

    // Server resumes from checkpoint
    for await (const chunk of syncManager.resumeSnapshotStream(checkpoint)) {
      ws.send(JSON.stringify(chunk));
    }
  }
}
```

## Implementation Status

### Completed

#### Phase 1: Core Infrastructure ✅
- [x] Create package structure (`quereus-plugin-sync`)
- [x] Implement HLC (Hybrid Logical Clock)
  - [x] `clock/hlc.ts` - HLC type, comparison, tick, receive
  - [x] `clock/site.ts` - Site ID generation and persistence
- [x] Implement CRDT metadata storage
  - [x] `metadata/keys.ts` - Key builders for sync metadata
  - [x] `metadata/column-version.ts` - Column version tracking
  - [x] `metadata/tombstones.ts` - Deletion tracking with TTL
  - [x] `metadata/peer-state.ts` - Peer sync state tracking
  - [x] `metadata/schema-migration.ts` - Schema change tracking

#### Phase 2: Sync Protocol ✅
- [x] Define protocol types (`sync/protocol.ts`)
- [x] Implement SyncManager interface (`sync/manager.ts`)
- [x] Implement SyncManagerImpl (`sync/sync-manager-impl.ts`)
  - [x] `applyChanges()` - Apply with LWW conflict resolution
  - [x] `canDeltaSync()` - TTL check for delta vs snapshot
  - [x] `updatePeerSyncState()` / `getPeerSyncState()` - Track peer sync progress

#### Phase 3: Event Integration ✅
- [x] Subscribe to `StoreEventEmitter` for data change events
- [x] Record column versions on insert/update
- [x] Record tombstones on deletion

#### Phase 4: Schema Sync ✅
- [x] `SchemaMigrationStore` - Track DDL changes with HLC
- [x] First-writer-wins conflict resolution for schema changes

#### Phase 5: Reactive Hooks ✅
- [x] Implement `SyncEventEmitter`
  - [x] `onRemoteChange` - Remote changes applied
  - [x] `onLocalChange` - Local changes pending
  - [x] `onSyncStateChange` - Connection state
  - [x] `onConflictResolved` - Conflict outcomes

#### Phase 6: Testing ✅
- [x] Unit tests for HLC
- [x] Unit tests for Site ID
- [x] Unit tests for ColumnVersionStore
- [x] Unit tests for TombstoneStore
- [x] Integration tests for SyncManager

#### Phase 7: Change Extraction ✅
- [x] `getChangesSince()` - Extract delta changes from metadata storage
- [x] `getSnapshot()` - Full snapshot for initial/recovery sync
- [x] `applySnapshot()` - Full state replacement
- [x] `pruneTombstones()` - Clean up expired tombstones

#### Phase 8: Streaming Snapshots ✅
- [x] `getSnapshotStream()` - Memory-efficient chunked snapshot streaming
- [x] `applySnapshotStream()` - Apply streamed snapshots with progress tracking
- [x] `getSnapshotCheckpoint()` / `resumeSnapshotStream()` - Resumable transfers
- [x] HLC-indexed change log for efficient delta queries

### Remaining Work

#### Integration Tests
- [ ] Integration tests with IndexedDB
- [ ] Multi-replica conflict scenarios
- [ ] Tombstone TTL expiration tests
- [ ] Schema migration conflict tests

#### Documentation & Examples
- [ ] Example: WebSocket sync transport
- [ ] Example: HTTP polling sync transport
