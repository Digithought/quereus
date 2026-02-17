---
description: Review plan for quereus-sync core package (CRDT replication engine)
dependencies: 3-review-pkg-store
priority: 3
---

# Sync Package Review Plan

Review plan for the sync core package (`packages/quereus-sync/`). This should stay transport-agnostic and focus on protocol/types, metadata tracking, and correctness guarantees.

## Responsibilities & Boundaries

**Core Sync (`quereus-sync`):**
- Sync protocol types and validation
- Metadata tracking (versions/tombstones/schema versions, as implemented)
- Clock/ordering semantics (if HLC or similar is used)
- Change serialization and application (to an abstract store adapter)
- Snapshot generation/application (if supported)
- Peer state tracking

**Boundaries:**
- Does NOT handle transport (WebSocket/HTTP) - that's sync-client/coordinator
- Does NOT persist data - delegates to store via `ApplyToStoreCallback`
- Does NOT manage connections - that's coordinator/client

## Critical Invariants

1. **Clock monotonicity**: Whatever ordering token is used must be monotonic per-site (if HLC is used, it must never decrease).
2. **Causality/ordering**: If the protocol claims happens-before preservation, ordering tokens must reflect that.
3. **Idempotency**: Applying the same ChangeSet multiple times is safe (no duplicate side effects).
4. **Convergence**: Replicas applying the same set of changes converge to the same state (under the intended conflict model).
5. **Deletion semantics**: Deletes/tombstones cannot accidentally resurrect rows under retries/reordering.

## Ordering & Consistency Guarantees

- **Change ordering**: Confirm what ordering the protocol guarantees (within a ChangeSet and across ChangeSets).
- **Conflict resolution**: Confirm the actual conflict strategy (LWW? per-row? per-column? mergeable CRDT?) and document it precisely.
- **Schema changes**: Confirm if/when schema migrations can be part of replication and their ordering relative to data changes.
- **Snapshot consistency**: If snapshots exist, confirm their atomicity/consistency contract.

## Idempotency & Retries

**Idempotency Mechanisms:**
- Column version store deduplicates by (table, pk, column, hlc)
- Tombstone store deduplicates by (table, pk, hlc)
- Peer state updates are idempotent (last-write-wins)

**Retry Safety:**
- `applyChanges()` can be called multiple times with same ChangeSet
- `getChangesSince()` returns same results for same `sinceHLC`
- Snapshot application is idempotent (replaces all state)

## Conflict Resolution

**Conflict model:**
- Identify where and how conflicts are resolved (client, core sync, store adapter).
- Confirm whether resolution is LWW or something else, and what the tie-break rules are (site id? deterministic ordering?).

**Deletion handling:**
- Confirm how deletes are represented and how they interact with late/duplicate updates.
- Confirm if “resurrection” is possible and whether it is intentional/configurable.

## Acceptance Criteria

### Functional
- [ ] `getChangesSince()` returns all changes since peer's last acknowledged token (HLC or equivalent)
- [ ] `applyChanges()` is correct under the implemented conflict model
- [ ] Snapshot generation/application (if present) is correct and clearly specified
- [ ] Schema changes (if replicated) have a clear ordering/compatibility story
- [ ] Clock/token advances monotonically across operations (if applicable)

### Correctness
- [ ] Idempotency: applying same ChangeSet twice produces identical result
- [ ] Convergence: two replicas applying same changes converge to same state
- [ ] Causality/ordering semantics are correct for the claimed guarantees
- [ ] Deletion semantics prevent unintended resurrection under retries/reordering

### Performance
- [ ] `getChangesSince()` efficient for large change logs (uses scan bounds)
- [ ] Snapshot streaming handles large databases without memory exhaustion
- [ ] Change log pruning prevents unbounded growth
- [ ] Column version storage scales with number of columns modified

## Test Plan

### Unit Tests (`packages/quereus-sync/test/`)

**SyncManager:**
- `getChangesSince()` with various HLC states
- `applyChanges()` with conflicts, no conflicts, idempotent retries
- Snapshot generation/application round-trip
- Tombstone TTL expiration behavior
- Schema migration ordering

**HLC:**
- Clock monotonicity under concurrent operations
- Causality preservation across sites
- Clock synchronization with remote peers

**Conflict Resolution:**
- Column-level LWW with concurrent writes
- Tombstone resurrection prevention
- Concurrent deletes and inserts

### Integration Tests

**End-to-End Sync:**
- Two replicas sync bidirectional changes
- Convergence after concurrent modifications
- Snapshot fallback when delta sync impossible
- Schema migration propagation

**Failure Injection:**
- Partial `applyChanges()` failure (some changes succeed, some fail)
- Network interruption during snapshot streaming
- Clock drift scenarios (HLC comparison edge cases)
- Tombstone TTL expiration mid-sync

### Property-Based Tests

- Idempotency: `applyChanges(cs); applyChanges(cs)` ≡ `applyChanges(cs)`
- Convergence: `applyChanges(cs1); applyChanges(cs2)` ≡ `applyChanges(cs2); applyChanges(cs1)` (when commutative)
- HLC ordering: All changes in ChangeSet have HLC >= previous ChangeSet

## Files to Review

**Core:**
- `packages/quereus-sync/src/sync/manager.ts` - SyncManager interface
- `packages/quereus-sync/src/sync/sync-manager-impl.ts` - Implementation
- `packages/quereus-sync/src/sync/protocol.ts` - Protocol types
- `packages/quereus-sync/src/sync/events.ts` - Event emission

**Metadata Stores:**
- `packages/quereus-sync/src/metadata/column-version.ts`
- `packages/quereus-sync/src/metadata/tombstones.ts`
- `packages/quereus-sync/src/metadata/peer-state.ts`
- `packages/quereus-sync/src/metadata/schema-migration.ts`
- `packages/quereus-sync/src/metadata/change-log.ts`

**Clock:**
- `packages/quereus-sync/src/clock/hlc.ts` (if used)
- `packages/quereus-sync/src/clock/site.ts`

## Code Quality Concerns

1. **Large Implementation File**: `sync-manager-impl.ts` is ~1600 lines - consider decomposition
2. **Error Handling**: Verify all error paths properly clean up state
3. **Memory Management**: Snapshot streaming must not accumulate in memory
4. **Transaction Boundaries**: Ensure atomicity of ChangeSet application

## TODO

- [ ] Review HLC monotonicity guarantees under clock drift
- [ ] Verify idempotency of all operations
- [ ] Test convergence with concurrent modifications
- [ ] Review tombstone TTL edge cases
- [ ] Decompose large sync-manager-impl.ts file
- [ ] Add property-based tests for CRDT properties
- [ ] Review error handling and cleanup paths
- [ ] Performance test with large change logs
