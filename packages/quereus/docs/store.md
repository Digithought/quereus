# Persistent Store Module Design

This document describes the design and architecture for `quereus-plugin-store`, a persistent key-value storage module for Quereus using LevelDB (Node.js) or IndexedDB (browser).

## Reactive Hooks

The store module exposes reactive JavaScript hooks for schema and data changes, enabling UI updates, caching invalidation, and real-time synchronization.

### Schema Change Hooks

```typescript
interface SchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index';
  schemaName: string;
  objectName: string;
  ddl?: string;  // For create/alter
}

store.onSchemaChange((event: SchemaChangeEvent) => {
  console.log(`${event.type} ${event.objectType}: ${event.schemaName}.${event.objectName}`);
});
```

### Data Change Hooks

```typescript
interface DataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  schemaName: string;
  tableName: string;
  key: SqlValue[];      // Primary key values
  oldRow?: Row;         // For update/delete
  newRow?: Row;         // For insert/update
}

store.onDataChange((event: DataChangeEvent) => {
  // Invalidate cache, update UI, replicate, etc.
});
```

### Use Cases

- **UI Reactivity**: Update views when underlying data changes
- **Cache Invalidation**: Clear or update cached query results
- **Replication**: Stream changes to remote systems
- **Audit Logging**: Record all mutations with full context
- **Cross-Tab Sync**: Notify other browser tabs of changes (IndexedDB)

### StoreEventEmitter API

The `StoreEventEmitter` class provides the reactive hooks infrastructure:

```typescript
import { StoreEventEmitter } from 'quereus-plugin-store';

// Create emitter and pass to module constructor
const eventEmitter = new StoreEventEmitter();
const module = new LevelDBModule({ path: './data' }, eventEmitter);

// Subscribe to schema changes
const unsubscribeSchema = eventEmitter.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
  if (event.ddl) console.log('DDL:', event.ddl);
});

// Subscribe to data changes
const unsubscribeData = eventEmitter.onDataChange((event) => {
  console.log(`${event.type} on ${event.tableName}, key:`, event.key);
});

// Unsubscribe when done
unsubscribeSchema();
unsubscribeData();
```

### Cross-Tab Notifications (IndexedDB)

In browser environments, multiple tabs may share the same IndexedDB database. The `IndexedDBModule` uses `BroadcastChannel` to propagate `DataChangeEvent` across tabs:

```typescript
// Tab A makes a change
await db.exec("INSERT INTO users VALUES (1, 'Alice')");
// Event fires in Tab A via local emitter
// Event also broadcasts to other tabs

// Tab B receives the event
eventEmitter.onDataChange((event) => {
  // Fires for both local AND remote changes
  console.log(`${event.type} in ${event.tableName}`);
});
```

Events received from other tabs have `event.remote = true` to distinguish them from local changes.

## Overview

The store module provides persistent table storage while maintaining Quereus's key-based addressing model. Both backends expose a unified `KVStore` interface, with platform-specific modules (`leveldb`, `indexeddb`) that share common logic.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    quereus-plugin-store                       │
├──────────────────────────────────────────────────────────────┤
│  Common Layer                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │ Key Encoder │  │ Row Serial. │  │ KVTable (base)      │   │
│  │ (sort-safe) │  │ (ext. JSON) │  │ - getBestAccessPlan │   │
│  └─────────────┘  └─────────────┘  │ - query, update     │   │
│                                    └─────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│  KVStore Interface                                            │
│  get | put | delete | iterate | batch | close                 │
├──────────────┬───────────────────────────────────────────────┤
│  LevelDB     │  IndexedDB                                     │
│  (Node.js)   │  (Browser)                                     │
│  classic-lvl │  Native API                                    │
└──────────────┴───────────────────────────────────────────────┘
```

## Storage Layout

### Key Structure

All keys are byte arrays with type-prefixed encoding for correct sort order:

| Prefix | Purpose | Format |
|--------|---------|--------|
| `d:` | Data rows | `d:{schema}.{table}:{encoded_pk}` |
| `i:` | Secondary index | `i:{schema}.{table}.{index}:{encoded_cols}:{pk}` |
| `m:` | Metadata | `m:ddl:{schema}.{table}`, `m:stats:{schema}.{table}` |

### Primary Key Encoding

Composite keys are encoded to preserve lexicographic sort order:

- `0x00` - NULL
- `0x01` + 8-byte big-endian signed int (with sign flip for ordering)
- `0x02` + IEEE 754 double (with sign flip)
- `0x03` + UTF-8 bytes + `0x00` terminator (escaped internal nulls)
- `0x04` + length-prefixed bytes (BLOB)

### Row Serialization

Rows are stored as values using Quereus's extended JSON serializer, which handles:
- `bigint` via `{"$bigint": "12345..."}`
- `Uint8Array` via `{"$blob": "base64..."}`
- Standard JSON types

### Metadata Storage

| Key | Value |
|-----|-------|
| `m:ddl:{schema}.{table}` | CREATE TABLE DDL string |
| `m:ddl:{schema}.{table}#{index}` | CREATE INDEX DDL string |
| `m:stats:{schema}.{table}` | `{rows: number, updated: timestamp}` |

## Secondary Indexes

Indexes are stored as separate key-value entries pointing back to the primary key:

```
Data:   d:main.users:42        → {id:42, email:"a@b.com", name:"Alice"}
Index:  i:main.users.idx_email:a@b.com:42 → (empty or pk bytes)
```

Index maintenance occurs during `update()`:
- INSERT: Add index entries for new row
- DELETE: Remove index entries for old row  
- UPDATE: Remove old entries, add new entries

The module's `getBestAccessPlan()` considers available indexes when evaluating filter constraints.

## Query Planning

The module implements `getBestAccessPlan()` to communicate capabilities:

| Access Pattern | Cost Model | Provides Ordering |
|----------------|------------|-------------------|
| PK equality | O(1) | Yes (single row) |
| PK range | O(k) where k = matched rows | Yes (BINARY only) |
| Secondary index eq | O(1) + PK lookup | No |
| Secondary index range | O(k) + PK lookups | No |
| Full scan | O(n) | Yes (PK order, BINARY) |

Non-BINARY collations: The module cannot provide collation-aware ordering. It reports `providesOrdering: undefined` and Quereus handles sorting above the Retrieve boundary.

## Schema Discovery

When connecting to existing storage, the module reads DDL from metadata keys and uses `importCatalog()` to register tables without triggering creation hooks.

### Interface Extension

```typescript
// Added to Database or SchemaManager
async importCatalog(ddlStatements: string[]): Promise<void>
```

This method:
1. Parses each DDL statement
2. Calls `module.connect()` (not `create()`)
3. Registers schema
4. Skips creation hooks

### Discovery Flow

1. Module opens storage at configured path/database
2. Scans `m:ddl:*` keys to collect DDL statements
3. Calls `db.importCatalog(ddlStatements)`
4. Tables become queryable

## Transaction Support

The store module integrates with Quereus's transaction coordinator to provide multi-table atomic transactions.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Quereus Database                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          Transaction Coordinator                     │    │
│  │  - Calls begin/commit/rollback on all connections   │    │
│  │  - Runs global assertions before commit             │    │
│  └─────────────────────────────────────────────────────┘    │
│           │              │              │                    │
│           ▼              ▼              ▼                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ Connection  │ │ Connection  │ │ Connection  │            │
│  │  (users)    │ │  (orders)   │ │  (items)    │            │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘            │
└─────────┼───────────────┼───────────────┼────────────────────┘
          │               │               │
          ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│               LevelDBModule TransactionCoordinator           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Shared WriteBatch                       │    │
│  │  - Collects writes from all tables                  │    │
│  │  - Single atomic write on commit                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│                    ┌─────────────┐                          │
│                    │  LevelDB    │                          │
│                    │  (classic)  │                          │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Connection Registration**: When a table is first accessed, a `LevelDBConnection` is created and registered with the Database
2. **Transaction Begin**: Quereus calls `begin()` on all registered connections; the coordinator starts buffering writes
3. **Mutations**: All `update()` operations queue changes to the shared `WriteBatch` instead of writing directly
4. **Transaction Commit**: Quereus calls `commit()` on connections; the coordinator writes the batch atomically
5. **Transaction Rollback**: The coordinator discards the pending batch; no changes are persisted

### Multi-Table Atomicity

Since all tables in a LevelDB module share the same underlying database (tables are distinguished by key prefixes), a single `WriteBatch` can atomically commit changes across all tables:

```typescript
BEGIN TRANSACTION;
INSERT INTO users VALUES (1, 'Alice');
INSERT INTO orders VALUES (100, 1, 50.00);
INSERT INTO items VALUES (1000, 100, 'Widget');
COMMIT;  -- All three inserts succeed or fail together
```

### Savepoint Support

Savepoints create nested snapshots within a transaction:

```sql
BEGIN;
INSERT INTO users VALUES (1, 'Alice');
SAVEPOINT sp1;
INSERT INTO users VALUES (2, 'Bob');
ROLLBACK TO sp1;  -- Discards Bob, keeps Alice
COMMIT;           -- Only Alice is persisted
```

The coordinator maintains a stack of pending operations, rolling back to the appropriate snapshot on `ROLLBACK TO`.

### LevelDB Backend
- All tables share one `ClassicLevel` instance
- `WriteBatch` provides atomic multi-key writes
- Savepoints tracked via operation snapshots

### IndexedDB Backend
- Transaction spans multiple object stores
- Native IDB transaction provides atomicity
- `transaction.abort()` for rollback

## Statistics

Row counts are maintained lazily for efficient query planning:

- **Storage**: `m:stats:{schema}.{table}` contains `{rowCount, updatedAt}`
- **Tracking**: Each insert increments count (+1), each delete decrements (-1)
- **Persistence**: After ~100 mutations, stats are flushed to storage in a microtask
- **Flush on close**: Stats are persisted when a table is disconnected

```typescript
// Access statistics programmatically
const table = module.getTable('main', 'users');
const rowCount = await table.getEstimatedRowCount();
```

The `getBestAccessPlan()` method uses these statistics for cost estimation when choosing between full scans and index lookups.

## Configuration

```sql
-- LevelDB (Node.js)
CREATE TABLE t (...) USING leveldb(path = './data/mydb');

-- IndexedDB (Browser)  
CREATE TABLE t (...) USING indexeddb(database = 'myapp');
```

In practice, applications set the default module:
```typescript
db.setDefaultModule('leveldb', { path: './data' });
// Then users simply: CREATE TABLE t (...)
```

## Schema Migration

Uses lazy migration: rows missing new columns return NULL or the declared default on read. No eager rewriting of existing data.

## Collation Support

The store module uses collation-aware binary encoding to preserve sort order in the underlying key-value store.

### Collation Encoders

Collations can register a `CollationEncoder` that transforms strings before binary encoding:

```typescript
interface CollationEncoder {
  /** Transform string for sort-preserving binary encoding */
  encode(value: string): string;
}
```

### Built-in Collations

| Collation | Encoder | Ordering Support |
|-----------|---------|------------------|
| **NOCASE** | Lowercases before encoding | Full (default) |
| **BINARY** | No transformation | Full |
| **RTRIM** | Trims trailing spaces | Full |
| **Custom** | Falls back to BINARY encoding | Requires Quereus re-sort |

The default collation is **NOCASE**, matching Quereus's case-insensitive comparison semantics.

### Future Work

**TODO**: Add per-column collation specification for primary keys and index columns:

```sql
-- Future syntax (not yet implemented)
CREATE TABLE t (
  name TEXT COLLATE BINARY PRIMARY KEY,
  email TEXT COLLATE NOCASE
) USING leveldb;

CREATE INDEX idx_name ON t(name COLLATE BINARY);
```

## Package Structure

```
packages/quereus-plugin-store/
  src/
    common/
      encoding.ts       # Key encoding utilities (type-prefixed sort-safe encoding)
      key-builder.ts    # Data/index key construction and scan bounds
      serialization.ts  # Extended JSON row serialization
      kv-store.ts       # KVStore interface with iterate and batch support
      events.ts         # Schema and data change event emitter
      ddl-generator.ts  # Generate CREATE TABLE/INDEX DDL from schemas
      index.ts          # Common module exports
    leveldb/
      store.ts          # LevelDBStore (classic-level wrapper)
      module.ts         # LevelDBModule (VirtualTableModule with createIndex)
      table.ts          # LevelDBTable (VirtualTable with query/update)
      index.ts          # LevelDB module exports
    indexeddb/
      store.ts          # IndexedDBStore (browser native API wrapper)
      module.ts         # IndexedDBModule (VirtualTableModule with createIndex)
      table.ts          # IndexedDBTable (VirtualTable with query/update)
      broadcast.ts      # CrossTabSync for BroadcastChannel notifications
      index.ts          # IndexedDB module exports
    index.ts            # Platform-conditional exports
```

## Implementation Status

### Phase 1: Core Infrastructure ✓
- [x] Define `KVStore` interface with get/put/delete/iterate/batch/approximateCount
- [x] Implement key encoding with sort-order preservation (type-prefixed)
- [x] Implement row serialization using extended JSON
- [x] Implement key builder for data rows and secondary indexes
- [x] Implement schema/data change event emitter

### Phase 2: LevelDB Backend ✓
- [x] Implement `LevelDBStore` using `classic-level`
- [x] Implement `LevelDBModule` with create/connect/destroy
- [x] Implement `LevelDBTable` (query with PK point/range/scan, update with insert/update/delete)
- [x] Implement `getBestAccessPlan()` with cost estimation
- [x] Add single-table batch transactions via `WriteBatch`

### Phase 3: Secondary Indexes ✓
- [x] Index storage layout (i:schema.table.index:cols:pk)
- [x] Index maintenance during insert/update/delete
- [x] Index-aware `getBestAccessPlan()` cost estimation
- [x] CREATE INDEX DDL integration (createIndex on modules)

### Phase 4: IndexedDB Backend ✓
- [x] Implement `IndexedDBStore` with full KVStore interface
- [x] Implement `IndexedDBModule` and `IndexedDBTable`
- [x] Cross-tab change notifications via BroadcastChannel

### Phase 5: Schema Persistence ✓
- [x] Metadata storage (DDL strings in m:ddl:* keys)
- [x] Schema discovery via `loadAllDDL()` + `importCatalog()`
- [x] DDL generation from TableSchema/IndexSchema
- [x] Reactive hooks for schema changes (StoreEventEmitter)
- [x] Lazy statistics refresh and persistence (~100 mutation batching)
- [x] Comprehensive test suite

### Phase 6: Additional Features ✓
- [x] Multi-table transactions via TransactionCoordinator
- [x] Collation-aware binary encoding infrastructure
- [ ] Per-column collation specification for keys/indexes (TODO)
