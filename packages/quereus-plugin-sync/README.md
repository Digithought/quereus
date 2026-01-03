# @quereus/plugin-sync

CRDT-based multi-master sync plugin for [Quereus](https://github.com/gotchoices/quereus). Enables offline-first applications with automatic conflict resolution.

## Features

- **Multi-master replication**: Any replica can write, changes merge automatically
- **Column-level LWW**: Last-Write-Wins at the column level for fine-grained conflict resolution
- **Hybrid Logical Clocks**: Causally-ordered timestamps that work offline
- **Transport agnostic**: Bring your own WebSocket, HTTP, or WebRTC transport
- **Offline-first**: Local changes sync when connectivity returns
- **Schema sync**: DDL changes (CREATE TABLE, ALTER TABLE) propagate across replicas

## Installation

```bash
npm install @quereus/plugin-sync @quereus/plugin-store
```

## Quick Start

```typescript
import { Database } from '@quereus/quereus';
import { StoreEventEmitter, LevelDBStore } from '@quereus/plugin-store';
import { createSyncModule, createStoreAdapter } from '@quereus/plugin-sync';

// Create the store with event emitter
const storeEvents = new StoreEventEmitter();
const store = await LevelDBStore.open({ path: './data' });

// Create sync-enabled module
const { syncModule, syncManager, syncEvents } = createSyncModule(store, storeEvents);

// Register with database
const db = new Database();
db.registerVtabModule('store', syncModule);

// Create tables and use normally - all changes are tracked
await db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)
  USING store
`);

await db.exec(`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')`);

// Get changes to send to another replica
const changes = await syncManager.getChangesSince(peerSiteId);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Application                             │
├─────────────────────────────────────────────────────────────┤
│  SyncManager                                                 │
│  ├── HLCManager (Hybrid Logical Clock)                      │
│  ├── ColumnVersionStore (LWW metadata)                      │
│  ├── TombstoneStore (deletion tracking)                     │
│  ├── ChangeLogStore (HLC-indexed changes)                   │
│  └── PeerStateStore (delta sync state)                      │
├─────────────────────────────────────────────────────────────┤
│  @quereus/plugin-store (KVStore)                            │
└─────────────────────────────────────────────────────────────┘
```

## Sync Protocol

### Delta Sync

When replicas have synced before:

```typescript
// Get changes since last sync
const changes = await syncManager.getChangesSince(peerSiteId);

// Apply received changes
const result = await syncManager.applyChanges(changeSets, applyToStoreCallback);
```

### Snapshot Sync

For new replicas or when delta sync isn't available:

```typescript
// Stream snapshot chunks
for await (const chunk of syncManager.streamSnapshot({ chunkSize: 1000 })) {
  sendToPeer(chunk);
}

// Apply received snapshot
await syncManager.applyStreamedSnapshot(chunks, applyToStoreCallback);
```

## Events

Subscribe to sync events for UI updates:

```typescript
syncEvents.onLocalChange((event) => {
  console.log('Local change:', event.tableName, event.type);
});

syncEvents.onRemoteChange((event) => {
  console.log('Remote change:', event.tableName, event.type);
  refreshUI();
});

syncEvents.onConflict((event) => {
  console.log('Conflict resolved:', event.resolution);
});
```

## Conflict Resolution

Conflicts are resolved automatically using Last-Write-Wins at the column level:

- Each column has an associated HLC timestamp
- When merging, the column with the higher HLC wins
- Ties are broken by site ID (deterministic ordering)

This means concurrent updates to *different* columns of the same row both apply, while updates to the *same* column use the latest value.

## API

### Core Exports

- `createSyncModule(store, storeEvents, config?)` - Factory to create sync-enabled store module
- `createStoreAdapter(db, store, storeEvents)` - Adapter for applying remote changes to store
- `SyncManager` - Main sync coordination interface
- `SyncEventEmitter` - Event subscription interface

### Clock Exports

- `HLCManager` - Hybrid Logical Clock manager
- `generateSiteId()` - Generate unique 16-byte site identifier
- `siteIdToBase64(id)` / `siteIdFromBase64(str)` - Site ID serialization

### Protocol Types

- `ChangeSet` - Collection of changes from one transaction
- `Change` - Single column or row change
- `SchemaMigration` - Schema change (CREATE/ALTER/DROP TABLE)
- `SnapshotChunk` - Streaming snapshot data

## Related Packages

- [`@quereus/store`](../quereus-store/) - Storage base layer (required)
- [`@quereus/sync-client`](../quereus-sync-client/) - WebSocket sync client (handles connection, reconnection, batching)
- [`@quereus/sync-coordinator`](../sync-coordinator/) - Server-side coordinator

## License

MIT

