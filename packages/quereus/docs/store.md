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

### Cross-Tab Notifications (IndexedDB)

In browser environments, multiple tabs may share the same IndexedDB database. The `IndexedDBModule` uses `BroadcastChannel` to propagate `DataChangeEvent` across tabs:

```typescript
// Tab A makes a change
await db.exec("INSERT INTO users VALUES (1, 'Alice')");
// Event fires in Tab A via local emitter
// Event also broadcasts to other tabs

// Tab B receives the event
store.onDataChange((event) => {
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

### LevelDB (Node.js)
- Single-table atomic batches via `WriteBatch`
- `begin()` creates pending batch
- `update()` queues operations
- `commit()` writes batch atomically
- `rollback()` discards pending batch

### IndexedDB (Browser)
- Native transaction support per object store
- Similar API surface to LevelDB batches

Multi-table transactions are not supported in v1.

## Statistics

Row counts are maintained lazily:
- Stored in `m:stats:{schema}.{table}`
- Updated approximately every ~100 mutations in a background microtask
- Used by `getBestAccessPlan()` for cost estimation

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

- **BINARY**: Native byte ordering, fully supported
- **NOCASE/RTRIM**: Equality works; range scans work but require Quereus re-sort
- **Custom**: Not encoded in storage; handled by Quereus at query time

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
- [ ] Reactive hooks for schema changes
- [ ] Lazy statistics refresh and persistence
- [ ] Comprehensive test suite

### Phase 6: Additional Features
- [ ] Multi-table transactions
- [ ] Order supporting binary collation
