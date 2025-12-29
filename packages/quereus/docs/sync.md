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

### Transactional Integrity During Sync

When applying remote changes, the sync system must write to two separate stores:
1. **CRDT metadata** → sync metadata store (column versions, tombstones, peer state)
2. **Actual table data** → each table's data store

**Challenge**: In IndexedDB, each table has its own database, so we cannot have a single atomic transaction spanning both the metadata store and multiple table stores. LevelDB uses a single database with key prefixes, allowing atomic `WriteBatch` commits across tables.

**Write Order**: To ensure crash safety, changes must be applied in this order:
1. **Data first**: Write table data to the data store
2. **Metadata second**: Write CRDT metadata to the sync store

This order is safe because:
- If crash occurs before data: nothing written, re-sync will retry
- If crash occurs after data but before metadata: CRDT state is "dirty" and will re-apply the same changes on next sync. Since CRDT operations are idempotent (same HLC → same LWW outcome), re-applying is safe.
- If crash occurs after metadata: all writes complete, consistent state

The reverse order (metadata first) would be dangerous: if we crash after writing metadata but before data, the CRDT state believes the change is applied but data is missing—and re-sync won't retry.

**Current Status**: ⚠️ The current implementation writes metadata first, then data. This should be reversed.

**Per-Table Batching**: Within each table, changes should be applied using `WriteBatch` for atomicity. The `TransactionCoordinator` in the Store module provides this capability.

**Atomicity Gap (IndexedDB)**: The current IndexedDB architecture uses separate databases per table. This means sync cannot atomically commit data changes AND CRDT metadata together—they're in different databases. See [Future: Single-Database Architecture](#future-single-database-architecture) below.

**Isolation Gap**: Even with correct write ordering, readers may see partially-applied state during sync. True isolation would require Store-level support—see [Future: Store Isolation](#future-store-isolation) below.

### Future: Single-Database Architecture

The current IndexedDB implementation uses separate databases per table (e.g., `quereus_main_users`, `quereus_main_orders`). This prevents cross-table atomicity.

**Key insight**: Browser storage quotas are per-origin, not per-database. Separate databases provide no storage benefit—all databases under the same origin share the same quota.

**Preferred direction**: Migrate to a single IndexedDB database with multiple object stores:

| Single Database | Multiple Databases (current) |
|-----------------|------------------------------|
| ✅ Native cross-table IDB transactions | ❌ No cross-DB transactions |
| ✅ Sync metadata + data in one transaction | ❌ Sequential commits |
| ✅ No WAL needed for crash recovery | ⚠️ Would need WAL |
| ✅ Same storage quota | ✅ Same storage quota |

With single-database architecture, sync could:
```
const tx = idb.transaction(['users', 'orders', 'sync_meta'], 'readwrite');
// Apply all data changes
// Apply all CRDT metadata
tx.commit();  // Native atomicity across all stores
```

This is tracked in store.md as Phase 7.

### Future: Store Isolation

Longer-term, the Store module should provide transaction isolation similar to the memory vtab's layered architecture:

1. **TransactionLayer pattern**: Writers work on an isolated layer; readers see committed snapshot
2. **Copy-on-write semantics**: Inherited from memory vtab's BTree layering
3. **Atomic visibility**: All changes become visible at once on commit

If Store provides this primitive, sync can leverage it:
```
store.beginTransaction()    // Isolated write context
// Apply all data changes   (invisible to readers)
// Apply all CRDT metadata  (invisible to readers)
store.commit()              // Atomically visible
```

This would eliminate the isolation gap, providing true ACID semantics for sync operations across multiple tables. This is tracked in store.md as Phase 8.

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

The sync module subscribes to the store's `StoreEventEmitter` to capture mutations. A key design goal is that reactive events fire **exactly once** for each change, whether the change is local or remote.

#### Event Flow

**Local Changes:**
```
User SQL → Store executes → Store emits event (remote=false) → SyncManager records metadata → UI receives event
```

**Remote Changes:**
```
SyncManager receives remote change → Updates metadata → Calls applyToStore → Store executes → Store emits event (remote=true) → SyncManager ignores → UI receives event
```

In both cases, the UI receives exactly one event from the Store. The `remote` flag determines whether the SyncManager should record CRDT metadata (local) or skip (remote).

#### The `remote` Flag

Both `DataChangeEvent` and `SchemaChangeEvent` include a `remote?: boolean` flag:

```typescript
interface DataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  schemaName: string;
  tableName: string;
  key: SqlValue[];
  oldRow?: Row;
  newRow?: Row;
  remote?: boolean;  // True if from sync or cross-tab
}

interface SchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index' | 'view' | 'trigger';
  schemaName: string;
  objectName: string;
  ddl?: string;
  remote?: boolean;  // True if from sync
}
```

#### Sync Module Event Handling

```typescript
// Sync module listens to store events
storeEventEmitter.onDataChange((event) => {
  // Skip events from remote sync - metadata already recorded
  if (event.remote) return;

  // Record CRDT metadata for local changes only
  syncModule.recordChange(event);

  // Emit for UI reactivity (local change pending sync)
  syncEventEmitter.emitLocalChange({
    transactionId: currentTxId,
    changes: [eventToChange(event)],
    pendingSync: true,
  });
});

storeEventEmitter.onSchemaChange((event) => {
  // Skip events from remote sync - metadata already recorded
  if (event.remote) return;

  // Record schema CRDT metadata for local changes
  syncModule.recordSchemaChange(event);
});
```

#### Applying Remote Changes

When the SyncManager applies remote changes, it must execute SQL in a way that the resulting store events are marked with `remote: true`:

```typescript
// SyncManager applies a remote changeset
async applyRemoteChangeset(changeset: ChangeSet): Promise<void> {
  // 1. Update CRDT metadata first (before SQL execution)
  for (const change of changeset.changes) {
    await this.updateMetadataForRemote(change);
  }

  // 2. Apply to store with remote flag
  await this.applyToStore(changeset.changes, { remote: true });
  // Store emits events with remote=true, SyncManager ignores them
}
```

The store plugin provides a mechanism to execute SQL with the remote flag:

```typescript
interface ApplyOptions {
  remote?: boolean;  // Mark resulting events as remote
}

// Store implementation ensures emitted events have remote=true
async applyChanges(changes: Change[], options: ApplyOptions): Promise<void> {
  for (const change of changes) {
    // Execute SQL...
    // When emitting event, include remote flag from options
    this.events.emitDataChange({ ...event, remote: options.remote });
  }
}
```

## Schema Synchronization

Schema (catalog) changes are synchronized using the same CRDT approach as data, ensuring eventual convergence across all replicas without requiring a perpetual migration log.

### Design Principles

1. **Catalog as Data**: Schema elements (tables, columns, indexes) are tracked with HLCs just like row data
2. **Column-Level Granularity**: Each column definition has its own HLC, enabling parallel schema changes
3. **Most Destructive Wins**: DROP operations take precedence over modifications
4. **DDL Before DML**: Sync batches always apply schema changes before data changes
5. **No Perpetual Log**: Only current state is tracked, not a history of migrations

### Schema Metadata Storage

Schema metadata is stored alongside data metadata using the same patterns:

| Key Pattern | Purpose | Value |
|-------------|---------|-------|
| `sv:{schema}.{table}:__table__` | Table existence | `{hlc, exists, ddl}` |
| `sv:{schema}.{table}:{column}` | Column definition | `{hlc, definition, deleted?}` |
| `sv:{schema}.{table}:{index}:__index__` | Index definition | `{hlc, definition, deleted?}` |

### Conflict Resolution: Most Destructive Wins

Schema conflicts follow a hierarchy where more destructive operations take precedence:

```
DROP TABLE > DROP COLUMN > ALTER COLUMN > ADD COLUMN
DROP TABLE > DROP INDEX > CREATE INDEX
```

Within the same level of destructiveness, Last-Write-Wins (LWW) applies based on HLC.

**Examples:**

```
Replica A: DROP COLUMN foo      @ HLC(1000, 1, A)
Replica B: ALTER COLUMN foo...  @ HLC(2000, 1, B)

Resolution: DROP wins (more destructive), even though B has higher HLC.
```

```
Replica A: ALTER COLUMN foo SET DEFAULT 'x'  @ HLC(1000, 1, A)
Replica B: ALTER COLUMN foo SET DEFAULT 'y'  @ HLC(2000, 1, B)

Resolution: B wins (same level, higher HLC).
```

```
Replica A: ADD COLUMN bar INTEGER  @ HLC(1000, 1, A)
Replica B: ADD COLUMN bar TEXT     @ HLC(2000, 1, B)

Resolution: B wins (same level, higher HLC). Column ends up as TEXT.
```

### DDL Application Order

When applying a sync batch:

1. **Schema changes first**: All DDL operations are applied before any DML
2. **Destructive operations first**: DROP TABLE, then DROP COLUMN, then ALTER/ADD
3. **Data changes second**: INSERT/UPDATE/DELETE applied to the now-correct schema

This ensures that structures always exist before data referencing them arrives.

### Schema Change Types

```typescript
type SchemaChangeType =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column'
  | 'create_index'
  | 'drop_index'
  | 'create_view'
  | 'drop_view'
  | 'create_trigger'
  | 'drop_trigger';

interface SchemaChange {
  type: SchemaChangeType;
  schema: string;
  table: string;
  column?: string;           // For column operations
  objectName?: string;       // For index/view/trigger
  definition?: string;       // DDL or column definition
  hlc: HLC;
  deleted?: boolean;         // True for DROP operations
}
```

### Applying Remote Schema Changes

When a remote schema change is received:

1. Compare HLCs using the "most destructive wins" rule
2. If remote wins, update local schema metadata
3. Execute the DDL against the database (with `remote: true` flag)
4. The store emits schema change events for UI reactivity

```typescript
async applySchemaChange(change: SchemaChange): Promise<'applied' | 'skipped'> {
  const local = await this.getSchemaVersion(change.schema, change.table, change.column);

  if (local && !this.shouldApplySchemaChange(change, local)) {
    return 'skipped';
  }

  // Update metadata
  await this.setSchemaVersion(change.schema, change.table, change.column, {
    hlc: change.hlc,
    definition: change.definition,
    deleted: change.deleted,
  });

  // Execute DDL via callback (store applies with remote flag)
  if (change.definition) {
    await this.applyDDL(change.definition, { remote: true });
  }

  return 'applied';
}

private shouldApplySchemaChange(remote: SchemaChange, local: SchemaVersion): boolean {
  // Most destructive wins
  if (remote.deleted && !local.deleted) return true;   // DROP beats non-DROP
  if (!remote.deleted && local.deleted) return false;  // non-DROP loses to DROP

  // Same level: LWW
  return compareHLC(remote.hlc, local.hlc) > 0;
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

### Store Adapter for Remote Changes

The `createStoreAdapter` function creates a unified adapter for applying remote changes to LevelDB and IndexedDB stores:

```typescript
import { createStoreAdapter } from 'quereus-plugin-sync';
import { LevelDBStore, StoreEventEmitter } from 'quereus-plugin-store';

// Create event emitter for store events
const storeEvents = new StoreEventEmitter();

// Open your KV store
const kvStore = await LevelDBStore.open({ path: './data' });

// Create the store adapter
const applyToStore = createStoreAdapter(kvStore, storeEvents);

// Use with SyncManager - remote changes are applied via the adapter
const syncManager = new SyncManagerImpl(metadataKvStore, storeEvents, applyToStore, {
  tombstoneTTL: 30 * 24 * 60 * 60 * 1000,
});

// When remote changes arrive, the adapter:
// 1. Handles UPSERT semantics (insert if row doesn't exist, update if it does)
// 2. Deletes rows by primary key
// 3. Executes DDL for schema changes
// 4. Emits events with remote=true to prevent re-recording CRDT metadata
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

#### Phase 9: Remote Change Application ✅
- [x] `remote?: boolean` flag exists on both `DataChangeEvent` and `SchemaChangeEvent`
- [x] `handleDataChange()` skips events with `remote === true`
- [x] `handleSchemaChange()` skips events with `remote === true`
- [x] `applyToStore` callback mechanism for applying remote changes
  - [x] `ApplyToStoreCallback` type with `{ remote: true }` option
  - [x] `DataChangeToApply` / `SchemaChangeToApply` types for callback parameters
  - [x] Store implementations can emit events with `remote: true` flag
- [x] Reactive events fire exactly once (UI receives from Store, SyncManager ignores remote events)
- [x] Unit tests for `applyToStore` callback behavior

#### Phase 10: Store Integration ✅
- [x] Implement `createStoreAdapter()` - unified adapter for LevelDB and IndexedDB
- [x] Handle UPSERT semantics (column changes may be insert or update)
- [x] Handle row deletions by primary key
- [x] Execute DDL for schema changes with `remote: true`
- [x] Emit data change events with `remote: true` to prevent re-recording CRDT metadata

#### Phase 11: Schema Sync Refinement ✅
- [x] Implement column-level schema version storage (`SchemaVersionStore`)
- [x] Track schema elements with HLCs: `sv:{schema}.{table}:{column}` pattern
- [x] Implement "most destructive wins" conflict resolution
  - [x] `getDestructiveness()` - rank schema version types
  - [x] `getOperationDestructiveness()` - rank schema change operations
  - [x] `shouldApplySchemaChangeByOperation()` - compare changes with destructiveness hierarchy
- [x] Schema conflict tests (destructiveness ranking, LWW for same level)

#### Phase 12: Integration Testing ✅
- [x] E2E test: two replicas with bidirectional sync
- [x] Multi-replica conflict scenarios (concurrent writes to same column)
- [x] LWW conflict resolution tests
- [x] Delete-update conflict handling tests
- [x] Full snapshot sync between replicas

### Remaining Work

#### Transactional Integrity (Short-term)
- [ ] Fix write order in `applyChanges`: write data first, then CRDT metadata (see [Transactional Integrity During Sync](#transactional-integrity-during-sync))
- [ ] Use `WriteBatch` for per-table atomicity when applying remote changes
- [ ] Consider using `TransactionCoordinator` in store adapter for batched writes

#### Single-Database Architecture (Future - Store Phase 7)
- [ ] Migrate IndexedDB to single database with multiple object stores (see [Future: Single-Database Architecture](#future-single-database-architecture))
- [ ] Place sync metadata in same database as data tables
- [ ] Leverage native IDB transactions for cross-table atomicity

#### Store Isolation (Longer-term - Store Phase 8)
- [ ] Implement isolation in Store module using memory vtab's TransactionLayer pattern
- [ ] Leverage Store isolation for sync to get true ACID semantics (see [Future: Store Isolation](#future-store-isolation))

#### Advanced Testing
- [ ] Tombstone TTL expiration and fallback to snapshot
- [ ] Large dataset streaming snapshot tests
- [ ] Network interruption / resume tests
- [ ] Integration tests with IndexedDB (browser environment)
- [ ] Crash recovery tests (verify idempotent re-apply after partial sync)

#### Documentation & Examples
- [ ] Example: WebSocket sync transport
- [ ] Example: HTTP polling sync transport
- [ ] Example: Implementing `applyToStore` callback
- [ ] Performance benchmarks
