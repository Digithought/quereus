# Isolation Layer Design

## Overview

This document describes a **generic transaction isolation layer** that can wrap any `VirtualTableModule` to provide ACID transaction semantics with read-your-own-writes, snapshot isolation, and savepoint support.

The goal is to decouple **storage** concerns from **isolation** concerns:

- **Storage modules** (memory, LevelDB, IndexedDB, custom) focus on persistence and indexing
- **Isolation layer** provides consistent transaction semantics across all modules

This enables module authors to implement simple read/write logic while getting full transaction support "for free."

---

## Motivation

### Current State

The memory virtual table module (`@quereus/quereus`) implements its own transaction isolation using `inheritree` B+Trees with copy-on-write inheritance. This works well but:

1. The isolation logic is tightly coupled to the storage implementation
2. Other modules (store, sync, custom) must re-implement isolation from scratch
3. Each implementation has different semantics and edge cases

The store module (`quereus-plugin-store`) currently has no read isolation—queries see committed data only, not pending writes from the current transaction.

### Desired State

A composable isolation layer that:

- Wraps any underlying module transparently
- Provides consistent MVCC-style isolation semantics
- Handles savepoints via nested layers
- Is well-tested in one place rather than per-module

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   IsolationModule                        │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │         Overlay Module (e.g., memory vtab)         │ │
│  │                                                     │ │
│  │  - Stores pending inserts, updates, tombstones     │ │
│  │  - Supports range scans, index lookups, etc.       │ │
│  │  - Savepoints via module's own transaction support │ │
│  │  - Any module that supports isolation can serve    │ │
│  └────────────────────────────────────────────────────┘ │
│                          │                               │
│                          │ row-level merge               │
│                          ▼                               │
│  ┌────────────────────────────────────────────────────┐ │
│  │           Underlying Module (any)                   │ │
│  │                                                     │ │
│  │  - LevelDB / IndexedDB store                       │ │
│  │  - Custom module without isolation                 │ │
│  │  - Any VirtualTableModule                          │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Key Principle: Row-Level Composition

The isolation layer operates purely at the **row level**, merging query results from two modules:

1. **Overlay module** — Stores uncommitted changes (inserts, updates, deletes as tombstones)
2. **Underlying module** — Stores committed data

Both modules are accessed through the standard `VirtualTable` and `VirtualTableConnection` interfaces. The isolation layer has no knowledge of BTrees, blocks, LevelDB, or any implementation details.

### Why Use a Module as Overlay Storage?

Using an existing module for overlay storage provides:

- **Range scan support** — The overlay module already implements efficient range iteration
- **Secondary index support** — The overlay module maintains its own indexes
- **Savepoint support** — The overlay module's transaction semantics handle savepoints
- **Consistency** — Same query semantics for overlay and underlying data

The isolation layer's only job is merging two row streams.

### Overlay Module Selection

The overlay module is configurable and can be any module that supports isolation:

| Overlay Module | Use Case |
|----------------|----------|
| Memory vtab | Default; fast, ephemeral, suitable for most transactions |
| LevelDB/IndexedDB | Large transactions, crash recovery of uncommitted work |
| Same as underlying | Uniform storage, useful for testing |

The key requirement is that the overlay module must support the capabilities needed for isolation (particularly savepoints if the isolation layer exposes savepoint support).

---

## Core Concepts

### Overlay Storage

The overlay is a virtual table instance (typically from the memory vtab module) that stores uncommitted changes for a connection. It mirrors the schema of the underlying table, including:

- Primary key columns
- All data columns
- Secondary indexes

The overlay table has an additional hidden column or marker to distinguish tombstones (deleted rows) from regular rows.

### Change Types

The overlay stores three types of changes as rows:

1. **Insert** — New row not present in underlying module (stored as regular row)
2. **Update** — Modified row replacing one in underlying module (stored as regular row)
3. **Delete** — Tombstone marking a row as removed (stored with tombstone marker)

The isolation layer doesn't distinguish inserts from updates—both are simply "this PK should return this row." The distinction only matters at commit time when applying to the underlying module.

### Merge Semantics

When reading, the isolation layer merges overlay changes with underlying data:

```
For each row from underlying module:
  - If overlay has tombstone for this PK → skip row
  - If overlay has update for this PK → emit overlay row instead
  - Otherwise → emit underlying row

For each insert in overlay not yet emitted:
  - Emit at correct sort position
```

This is analogous to LSM-tree merge or 3-way merge in version control.

---

## Transaction Lifecycle

### Begin Transaction

1. Create new `OverlayState` for this connection (or inherit from existing if nested)
2. Call `underlyingConnection.begin()` to start underlying transaction

### Read Operations

1. Execute query against overlay first
2. Execute same query against underlying module
3. Merge results using primary key ordering
4. For index scans: consult overlay's secondary index to find additional/removed keys

### Write Operations

1. Apply change to overlay only (insert/update/delete)
2. Update overlay's primary index
3. Update overlay's secondary indexes
4. Do NOT write to underlying module yet

### Savepoint

1. Call `overlayConnection.savepoint(n)` to create savepoint in overlay module
2. The overlay module handles the savepoint semantics internally

### Rollback to Savepoint

1. Call `overlayConnection.rollbackToSavepoint(n)` to revert overlay changes
2. The overlay module discards changes made after the savepoint

### Commit

1. Collect all changes from overlay
2. Apply to underlying module via `update()` calls
3. Call `underlyingConnection.commit()`
4. Clear overlay state

### Rollback

1. Discard overlay state entirely
2. Call `underlyingConnection.rollback()`

---

## Capability Discovery

Modules should advertise their isolation support so consumers can make informed decisions.

### Capability Interface

```typescript
interface ModuleCapabilities {
  /** Module provides transaction isolation (read-your-own-writes, snapshot reads) */
  isolation?: boolean;

  /** Module supports savepoints within transactions */
  savepoints?: boolean;

  /** Module persists data across restarts */
  persistent?: boolean;

  /** Module supports secondary indexes */
  secondaryIndexes?: boolean;
}

interface VirtualTableModule {
  // ... existing methods

  /** Returns capability flags for this module */
  getCapabilities?(): ModuleCapabilities;
}
```

### Usage

```typescript
const module = db.getModule('store');
const caps = module.getCapabilities?.() ?? {};

if (!caps.isolation) {
  // Wrap with isolation layer, or warn user
  console.warn('Module does not provide isolation; queries may see partial writes');
}
```

### Wrapped Module Capabilities

When the isolation layer wraps a module, it augments the capabilities:

| Capability | Underlying | Wrapped Result |
|------------|------------|----------------|
| `isolation` | `false` | `true` |
| `savepoints` | `false` | `true` |
| `persistent` | (passthrough) | (passthrough) |
| `secondaryIndexes` | (passthrough) | (passthrough) |

---

## Secondary Index Handling

### Why the Overlay Must Have Matching Indexes

Consider a table with a secondary index on `email`:

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE);
CREATE INDEX idx_email ON users(email);
```

A query like:

```sql
SELECT * FROM users WHERE email = 'alice@example.com';
```

Uses the secondary index. If the overlay only tracks by primary key:

1. Query asks underlying module's index for `email = 'alice@example.com'`
2. Underlying returns row with `id = 5`
3. But overlay might have deleted id=5, or updated its email to something else!

The overlay table must have the same indexes as the underlying table so that:
- Index scans on overlay find pending inserts/updates by index key
- Merge can correctly combine overlay and underlying index scan results

### Overlay Table Schema

The isolation layer creates an overlay table with:
- Same columns as underlying table
- Same primary key
- Same secondary indexes
- Additional tombstone marker column

This is handled automatically when the isolation layer creates the overlay table instance.

### Index Scan Merge

When scanning via secondary index:

1. Execute index scan on overlay table → returns overlay rows matching index predicate
2. Execute index scan on underlying table → returns committed rows matching predicate
3. Merge by primary key:
   - Overlay tombstone for PK → skip underlying row
   - Overlay row for PK → emit overlay row, skip underlying
   - No overlay entry → emit underlying row

---

## Key Ordering

### The Problem

For merge iteration to work correctly, the overlay must iterate in the **same order** as the underlying module. Different modules may use different orderings:

| Module | Ordering |
|--------|----------|
| Memory vtab | `compareSqlValues()` with collation support |
| Store module | Binary-encoded keys (lexicographic byte order) |

If these differ, merge produces incorrect results.

### Solution: Module-Provided Comparator

The underlying module must provide its key comparison function:

```typescript
interface IsolationCapableTable extends VirtualTable {
  /** Compare two rows by primary key, using module's native ordering */
  comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number;

  /** Extract primary key values from a row */
  extractPrimaryKey(row: Row): SqlValue[];

  /** Compare index keys for a given index */
  compareIndexKey(indexName: string, a: SqlValue[], b: SqlValue[]): number;
}
```

The isolation layer passes these comparators to the overlay module (if configurable) or validates that the overlay and underlying modules use compatible orderings.

### Collation Considerations

For text columns with non-binary collation (NOCASE, etc.):

- The underlying module's comparator must respect the collation
- The overlay uses the same comparator
- Both iterate in the same order

---

## Challenges and Mitigations

### 1. Merge Iteration Complexity

**Challenge:** Merging two ordered streams while handling inserts, updates, and deletes is error-prone.

**Mitigation:**
- Implement as a standalone, well-tested `MergeIterator` utility
- Use property-based testing (fast-check) to verify invariants:
  - Output is correctly ordered
  - All overlay changes appear in output
  - Deleted rows never appear
  - Updates replace originals exactly once
- Keep stateless: input two async iterables, output one

### 2. Cursor Invalidation During Mutation

**Challenge:** If a query is iterating and a write occurs, the cursor may be invalid.

**Mitigation:**
- Writes go to overlay module, which has its own cursor safety semantics
- If overlay module supports snapshot isolation (memory vtab does), iteration is safe
- Document behavior based on overlay module's capabilities

### 3. Commit Failure Recovery

**Challenge:** If the underlying module fails mid-commit, the overlay has partially flushed.

**Mitigation:**
- Collect all changes before any writes
- Write all changes, then commit underlying transaction
- If writes fail, underlying transaction rolls back (atomic)
- Overlay remains intact; user can retry or rollback

### 4. Performance Overhead

**Challenge:** Every read now goes through overlay check + merge.

**Mitigation:**
- Fast path: if overlay is empty, delegate directly to underlying
- Track "has changes" flag to skip merge when unnecessary
- For point lookups: check overlay first (O(log n)), only hit underlying if not found
- Accept some overhead in exchange for correctness and simplicity

### 5. Large Transaction Storage

**Challenge:** Large transactions may accumulate many uncommitted changes in the overlay.

**Mitigation:**
- The overlay module is configurable—use memory vtab for small/fast transactions
- For large transactions, use a persistent overlay module (e.g., temp LevelDB instance)
- This is a deployment/configuration choice, not a limitation of the architecture

### 6. Schema Operations (DDL)

**Challenge:** CREATE INDEX, ALTER TABLE, DROP TABLE don't fit the row-based overlay model.

**Mitigation:**
- DDL operations bypass the overlay and go directly to underlying module
- Schema changes may have their own transactional semantics
- Document that DDL is not isolated in the same way as DML

---

## Relationship to Memory VTab

### Current Memory VTab Architecture

The memory vtab uses `inheritree` BTrees for both storage and isolation in a tightly integrated design:

- Base data stored in BTrees
- Transaction layers created via BTree copy-on-write inheritance
- Efficient single-layer design, but couples storage and isolation

### Future Options

**Option A: Keep Memory VTab Special**

Memory vtab continues using integrated approach for performance. Isolation layer used only for store and custom modules.

- Pros: No performance regression for memory vtab
- Cons: Two isolation implementations to maintain

**Option B: Unify Under Isolation Layer**

Create a "raw memory module" (BTrees, no isolation) and wrap with isolation layer.

- Pros: Single isolation implementation, simpler memory vtab
- Cons: Some performance overhead, two layers of BTrees

**Recommendation:** Start with Option A. Measure performance of Option B. Migrate if overhead is acceptable.

---

## API Surface

### Wrapping a Module

```typescript
import { IsolationModule } from '@quereus/isolation';
import { StoreModule } from '@quereus/plugin-store';
import { MemoryModule } from '@quereus/quereus';

// Create underlying module (the persistent storage)
const storeModule = new StoreModule(leveldb);

// Create overlay module (for uncommitted changes)
const overlayModule = new MemoryModule();  // Or another StoreModule, etc.

// Wrap with isolation
const isolatedModule = new IsolationModule({
  underlying: storeModule,
  overlay: overlayModule,
});

// Register with database
db.registerModule('store', isolatedModule);
```

### Checking Capabilities

```typescript
const caps = isolatedModule.getCapabilities();
// { isolation: true, savepoints: true, persistent: true, ... }
```

### Transparent Usage

Once wrapped, usage is identical to any other module:

```sql
CREATE VIRTUAL TABLE users USING store (...);
BEGIN;
INSERT INTO users VALUES (1, 'Alice');
SELECT * FROM users WHERE id = 1;  -- Returns Alice (read-your-own-write)
ROLLBACK;
SELECT * FROM users WHERE id = 1;  -- Returns nothing
```

---

## Testing Strategy

### Unit Tests

- `OverlayState`: insert, update, delete, iteration, savepoints
- `MergeIterator`: all combinations of overlay/underlying states
- Secondary index tracking: insert, update, delete propagation

### Property-Based Tests

Using fast-check or similar:

- Generate random sequences of operations
- Apply to isolated module and a reference implementation
- Verify results match

### Integration Tests

- Wrap memory vtab with isolation layer, run existing memory vtab tests
- Wrap store module with isolation layer, verify read-your-own-writes
- Multi-table transactions with mixed modules

---

## TODO

### Phase 1: Core Infrastructure

- [ ] Define `ModuleCapabilities` interface in `@quereus/quereus`
- [ ] Add `getCapabilities()` to `VirtualTableModule` interface
- [ ] Implement capabilities for existing modules (memory, store)
- [ ] Define key extraction and comparison interfaces for modules

### Phase 2: Merge Iterator

- [ ] Implement `MergeIterator` for combining two row streams by primary key
- [ ] Handle all cases: overlay insert, overlay update, overlay tombstone, passthrough
- [ ] Add property-based tests for ordering and completeness invariants
- [ ] Test with various key types and orderings

### Phase 3: Isolation Layer Core

- [ ] Implement `IsolationModule` wrapping `VirtualTableModule`
- [ ] Implement `IsolatedTable` wrapping `VirtualTable`
- [ ] Implement `IsolatedConnection` wrapping `VirtualTableConnection`
- [ ] Create overlay table with matching schema and indexes
- [ ] Wire up transaction lifecycle (begin, commit, rollback, savepoints)

### Phase 4: Query Routing

- [ ] Route writes to overlay table
- [ ] Route reads through merge iterator (overlay + underlying)
- [ ] Handle index scans via overlay indexes
- [ ] Implement commit flush (apply overlay to underlying)

### Phase 5: Integration

- [ ] Add isolation layer to store module (opt-in or default)
- [ ] Update store module documentation
- [ ] Run store module tests with isolation enabled
- [ ] Performance benchmarking vs. non-isolated access

### Phase 6: Memory VTab Evaluation (Future)

- [ ] Prototype "raw memory module" without isolation
- [ ] Benchmark isolated wrapper vs. current integrated approach
- [ ] Decide on unification strategy

---

## References

- [SQLite Virtual Table docs](https://sqlite.org/vtab.html) — Transaction semantics
- [LSM-Tree](https://en.wikipedia.org/wiki/Log-structured_merge-tree) — Similar merge concepts
- Memory VTab source — Reference implementation for overlay module with isolation support

