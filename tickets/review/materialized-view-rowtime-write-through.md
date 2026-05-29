description: Review row-time (write-through) materialized-view maintenance for the covering-index shape — a new `row-time` refresh policy that keeps a covering MV's backing table consistent synchronously with each source row-write (same transaction, visible mid-statement), not at COMMIT. Maintenance capability only; UNIQUE enforcement routing is the downstream `covering-structure-mv-rowtime-enforcement` ticket.
prereq:
files: packages/quereus/src/schema/view.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/materialized-views.md, docs/incremental-maintenance.md, docs/lens.md
----

## What landed

A third refresh policy, **`row-time`**, gated at create to the **covering-index
shape**. For an eligible MV the backing table is maintained *synchronously* with
each source row-write — within the writing transaction, visible mid-statement
(reads-own-writes), committed/rolled-back in lockstep with the source write — by a
pure projection of the changed row (delete old image's backing key, upsert new
image). No body re-execution, no scan, no compiled residual.

This delivers the **maintenance capability only**. Enforcement routing
(`findIndexForConstraint` returning the `materialized-view` variant;
`checkSingleUniqueConstraint` consuming the backing table) is untouched and still
fails loudly — that is the downstream `covering-structure-mv-rowtime-enforcement`
ticket, which lists this as its prereq.

### Implementation tour (for the reviewer)

- **Policy + parse + round-trip** — `RefreshPolicy` gains `{ kind: 'row-time' }`
  (`schema/view.ts`); the parser accepts `with refresh = 'row-time'`
  (`parser.ts` `parseRefreshPolicyValue`, `ast.ts`, `materialized-view-nodes.ts`);
  the create emitter maps it via a new `refreshPolicyKind` helper
  (`runtime/emit/materialized-view.ts`). `ast-stringify.ts` round-trips it with
  **no change** — its existing `refreshPolicy !== 'manual'` branch is generic
  (worth a glance to confirm).
- **Eligibility + plan** — `database-materialized-views.ts`
  `registerMaterializedView` branches `row-time` to `buildRowTimePlan`, which
  reuses the manager's own shape primitives (`collectTableRefs`, `findAggregate`,
  `containsAnyJoin`, `containsNodeType`, provenance via `resolveSourceCol` /
  `relationalAttributes`). The compiled `RowTimeMaintenancePlan` (projection column
  map + backing PK + optional `compilePredicate`) is cached in a `rowTime` map and
  indexed by source base in `rowTimeBySource`; released on drop / schema-change /
  re-register (`releaseRowTime`, mirroring `releaseEntry`).
- **Privileged transactional write** — `MemoryTableManager.applyMaintenanceToLayer`
  (`manager.ts`), the transaction-layer analogue of `applyMaintenance`: applies
  `delete-key`/`upsert` ops to a connection's *pending* `TransactionLayer`,
  bypassing `validateMutationPermissions`, via `recordUpsert`/`recordDelete`.
  Synchronous (no latch — the pending layer is private to the connection).
- **Synchronous hook** — `Database._maintainRowTimeCoveringStructures` /
  `_hasRowTimeCoveringStructures` delegate to the manager's `maintainRowTime` /
  `hasRowTimePlanFor`. Called from `dml-executor.ts` after **all six**
  `_recordInsert/_recordUpdate/_recordDelete` sites (insert, REPLACE-on-insert,
  UPSERT-do-update, normal update, REPLACE-eviction-on-update, delete), guarded by
  the cheap sync `_hasRowTimeCoveringStructures` so non-covered writes pay nothing.
  The backing write rides the **same connection** a `select` from the MV uses
  (`getBackingConnection` — reuse via `getConnectionsForTable`, else
  create+`registerConnection`), so reads-own-writes and coordinated commit/rollback
  come for free.
- **Watch** — `statement.ts` `resolveMaterializedViewSource` now projects a
  `row-time` MV's backing reference to its sources too (the backing table is
  maintained off the user change log).

## Validation status

- `yarn build` (full monorepo): clean.
- `yarn lint` (quereus): clean.
- `yarn test` (quereus, memory): **3797 passing, 9 pending, 0 failing** — no
  regressions. New file `test/logic/53-materialized-views-rowtime.sqllogic` passes.
- `yarn test:store` **not run** (store path explicitly out of scope per ticket).

## Test coverage (53-materialized-views-rowtime.sqllogic)

1. Autocommit write-through (insert/update/delete reflected with no BEGIN, no refresh).
2. Mid-transaction visibility + rollback reverts; committed txn persists.
3. **Differential vs `on-commit-incremental` over the same body** — row-time
   reflects pre-commit, incremental does not; both agree post-commit.
4. Partial body (`where x > 0`) scope transitions: update out of scope deletes the
   backing row, into scope adds it, in-scope key-changing update moves it.
5. Multi-row statement → full set (pending-layer accumulation / reads-own-writes).
6. Compound-PK source.
7. Two row-time MVs over one source (both maintained from one write).
8. Eligibility rejections (each errors with the `row-time` diagnostic): aggregate,
   join, set op, LIMIT, DISTINCT-dropping-PK, recursive CTE, projection dropping a
   source PK column, **expression/computed projected column**. A manual MV over the
   aggregate body succeeds.
9. DROP detaches the plan (post-drop write touches nothing).
10. **Failed source write leaves no backing delta** — a multi-row insert whose 2nd
    row violates the PK aborts the whole statement; neither the source row nor its
    backing maintenance survives (statement-savepoint atomicity).

## Honest gaps / decisions the reviewer should weigh

- **Passthrough-only projection (deliberate scope, NOT in the ticket's explicit
  rejection list).** Eligibility requires every backing column to resolve to a
  source column via attribute provenance — i.e. *no computed/expression projected
  columns* (`select id, x + 1 as x1` is **rejected** for row-time; works for
  `on-commit-incremental`). This is the literal reading of the ticket's "pure
  projection of the changed row… passthrough column ids forward directly… no
  residual scheduler," and it is exactly what the downstream UNIQUE enforcement
  needs (UC cols + source PK are all passthrough). Supporting expression
  projections would require evaluating scalars per row (a mini-residual),
  contradicting the cost contract. **Reviewer: confirm this restriction is
  acceptable, or open a follow-up to support expression projections.**
- **"Self-collision within one statement" reframed.** For the covering-index shape
  the backing physical PK always carries the source PK (logical-key tiebreaker), so
  two distinct source rows can **never** collide on the backing key — the ticket's
  "rows project to the same backing key" scenario is structurally impossible here.
  Test §5 verifies the underlying substrate (pending-layer accumulation across a
  multi-row statement) instead. The collision-resolution path (`upsert` overwriting
  by key) is exercised by REPLACE / in-scope key-changing updates.
- **Cost ("no per-row body execution") is by construction, not asserted via
  metrics.** The row-time path builds **no** `Scheduler` and calls **no**
  `emitPlanNode` (contrast the incremental `compile()`/`runResidual`); this is
  verifiable by code inspection of `applyRowTimeChange` / `buildRowTimePlan`. A
  pure-sqllogic test can't read the instruction-tracer/metrics seam. Consider a
  `.spec.ts` if a programmatic assertion is wanted.
- **"Source without a PK" rejection is unreachable for memory tables.** Quereus
  defaults a PK-less table to an **all-columns** PK (`schema/table.ts`
  `resolvePrimaryKey`), so `sourcePkCols.length === 0` is defensive only. The
  reachable failure is "projection drops a source PK column" (tested). The
  defensive check is kept to mirror the incremental gate.
- **Backing-connection lookup is O(active connections) per maintained row**
  (`getConnectionsForTable` scan). Fine for v1; a per-transaction cache on the plan
  is a possible optimization but risks staleness across txn boundaries — left out.
- **Store: works for store-backed *sources* for free** (better than the ticket
  anticipated). MV backing tables are *always* memory-backed
  (`buildBackingTableSchema` → memory module), so the privileged memory-specific
  `applyMaintenanceToLayer` composes even when the source table is store-backed:
  the runtime DML hook is module-agnostic, the source write rides the store path,
  the backing write rides the memory path, and both commit/roll-back together via
  the coordinated commit. **Verified: file 53 passes under `yarn test:store`**
  (single-file run), so it is *not* in `MEMORY_ONLY_FILES` — same as
  `52-materialized-views-incremental.sqllogic`. The full `yarn test:store` suite
  was not run (per ticket); a store-*backed* MV would be genuinely new work, but no
  such thing exists today.
- **Cascading (row-time MV feeding another MV) not specially handled.** A row-time
  MV's backing writes go through the memory layer's own change tracking, not the DB
  change log, so they do not feed `on-commit-incremental` dependents' deltas. No
  test covers MV-over-row-time-MV; believed rare and out of this ticket's scope —
  worth a reviewer sanity check.

## Suggested reviewer focus

- The **6 DML hook sites** in `dml-executor.ts` — confirm none are missed and the
  old/new rows passed match what `_recordX` recorded (esp. the REPLACE-on-update
  evict path: site emits `delete(replacedRow)` then `update(oldRow→newRow)`, which
  share a backing key — verify the net backing state is correct).
- **Autocommit atomicity**: confirm a bare `insert into T` both maintains the
  backing table and commits it atomically (test §1/§10 cover this), and that the
  backing connection registered mid-statement correctly inherits the statement
  savepoint via `registerConnection`'s savepoint replay.
- `buildRowTimePlan` eligibility completeness — any covering-shape body that should
  be rejected but isn't (or vice-versa)?
