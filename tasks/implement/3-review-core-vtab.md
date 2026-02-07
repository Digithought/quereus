---
description: Comprehensive review of virtual table subsystem (VTab interface, Memory table, cursors)
dependencies: none
priority: 3
---

# Virtual Table Subsystem Review

## Goal

Conduct adversarial review of the virtual table subsystem to ensure interface correctness, MVCC isolation accuracy, and constraint pushdown reliability. Verify MemoryTable implementation correctness and event system reliability.

## Scope

- **VTab interface**: Core interfaces and types (`src/vtab/types.ts`, `manifest.ts`, `cursor.ts`, `events.ts`)
- **Memory table**: MVCC implementation (`src/vtab/memory/index.ts`, `layer/`, `cursor/`)
- **Infrastructure**: Constraint handling, index info, module wrapper (`src/vtab/`)

## Non-goals

- Runtime execution integration (see `3-review-core-runtime.md`)
- Planner integration (see `3-review-core-planner.md`)

## Checklist

### VTab Interface

- [ ] **Interface completeness**: Review `packages/quereus/src/vtab/types.ts` and confirm the surface area matches current use-cases (core MemoryTable + plugin vtabs).
- [ ] **Type safety**: Ensure constraint values and index metadata are represented with types that prevent common mistakes (e.g. missing operator/value combinations).
- [ ] **Optional vs required contracts**: Make explicit which methods are optional and what default behavior is when omitted.
- [ ] **Async consistency**: Confirm async methods behave consistently and callers always await/handle rejections correctly.

### Memory Table Implementation

- [ ] **Layer cleanup**: Confirm transaction layers are cleaned up on success/error paths (no dangling layers).
- [ ] **Index consistency**: Audit all mutation paths in `packages/quereus/src/vtab/memory/` to ensure indexes stay consistent and cannot drift under updates/deletes.
- [ ] **Primary key semantics**: Confirm uniqueness enforcement and error reporting for duplicate/missing PKs.
- [ ] **Event emission**: Validate that all mutations emit correct events (and that batching semantics are consistent/documented).

### MVCC Isolation

- [ ] **Isolation guarantees**: Define and validate the isolation level of MemoryTable transactions and confirm tests match that contract.
- [ ] **Merge correctness**: Validate commit/merge behavior under concurrent writes (what conflicts are detected vs last-write-wins).
- [ ] **Rollback completeness**: Ensure rollback restores state and releases all layer resources.
- [ ] **Version retention**: Confirm how versions are retained/compacted and ensure long-running write loads do not leak memory.

### Constraint Handling

- [ ] **Pushdown contract**: Confirm what it means for a constraint to be “pushdown-able” and ensure the decision is consistent between `constraint-info` and MemoryTable cursors.
- [ ] **Operator coverage**: Enumerate supported operators (EQ/LT/LE/GT/GE/IN/IS NULL/IS NOT NULL) and add tests for each.
- [ ] **NULL semantics**: Ensure constraint evaluation matches comparison/coercion semantics (and is consistent with SQLite where intended).
- [ ] **Collation propagation**: Ensure collation influences constraint evaluation consistently where applicable.

### Code Quality

- [ ] **Maintainability hotspots**: Identify the hardest-to-maintain parts of `xBestIndex`/`xFilter` and propose incremental refactors that reduce bug surface area.
- [ ] **Error handling**: Ensure errors are typed and actionable, and that unexpected exceptions propagate (don’t swallow).
- [ ] **Layer logic encapsulation**: If layer management is spread across files, consider whether a small abstraction would clarify invariants (capture as follow-up work).

### Test Coverage

- [ ] **VTab interface tests**: Add/extend tests under `packages/quereus/test/vtab/` for module lifecycle, cursor operations, and constraint handling.
- [ ] **MemoryTable tests**: Add/extend tests under `packages/quereus/test/vtab/` for CRUD, indexing, transactions, and events.
- [ ] **MVCC tests**: Add/extend isolation/layer tests under `packages/quereus/test/vtab/`.
- [ ] **Integration tests**: Add end-to-end integration tests under `packages/quereus/test/` that exercise constraint pushdown and transaction participation.

## Deliverables

1. **Fixed bugs**: Layer cleanup on error, index consistency, constraint evaluation
2. **Refactored code**: Constraint evaluator, decomposed xBestIndex/xFilter, layer manager
3. **Test suites**: VTab interface, MemoryTable, MVCC, integration tests
4. **Documentation**: `docs/vtab.md` (implementation guide), `docs/memory-table.md` (internals), `docs/vtab-events.md` (event system)

## Test Plan

### Unit Tests

- **VTab interface**: Module lifecycle (create, connect, disconnect, destroy), cursor operations (open, iterate, close, multiple cursors), constraint handling (pass to xBestIndex, apply in xFilter, unsupported constraints)
- **MemoryTable**: CRUD operations (insert, update, delete, primary key conflict, missing row), indexing (primary key, secondary index, scan fallback, cost estimation), transactions (isolation, commit, rollback, nested), events (insert, update, delete, batching)
- **MVCC**: Isolation (uncommitted changes hidden, committed changes visible, concurrent modifications), layer management (create transaction layer, merge on commit, discard on rollback, cleanup old versions), conflict detection (write-write, read-write, resolution)

### Integration Tests

- **Query engine**: SELECT, INSERT, UPDATE, DELETE, JOIN queries
- **Constraint pushdown**: Equality, range, IN constraints pushed down, non-pushable handled correctly
- **Transactions**: VTab participates in transactions, rollback handled, savepoints supported

### Logic Tests

- Add SQL logic tests for VTab correctness (`test/logic/15-vtab-*.sqllogic`):
  - CRUD operations
  - Index usage
  - Transaction isolation
  - Constraint pushdown

## Acceptance Criteria

- All VTab interface methods tested and working correctly
- MVCC isolation verified (concurrent transactions don't interfere)
- Index consistency maintained across all mutation paths
- Constraint pushdown works for all supported operators
- No obvious memory leaks under stress (best-effort regression)
- Events emitted correctly for all mutations
- Layer cleanup on error verified

## Notes/Links

- Related: `3-review-core-runtime.md` (runtime-VTab integration)
- Related: `3-review-core-planner.md` (planner-VTab integration)
- VTab interface: `src/vtab/types.ts`