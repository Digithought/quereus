description: Make cascading incremental materialized views (an `on-commit-incremental` MV whose source is another incremental MV's backing table) converge within a single COMMIT, by feeding each MV's post-commit backing-table writes as deltas into its dependents — processed in MV-dependency topological order within the same maintenance pass.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database-transaction.ts, docs/materialized-views.md, docs/incremental-maintenance.md, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic
----

## Problem (confirmed in code)

Incremental MV maintenance runs post-commit in `TransactionManager.commitTransaction`
→ `runPostCommitMaterializedViews()` → `MaterializedViewManager.runPostCommit()`
→ `DeltaExecutor.runAll()` (see `database-transaction.ts:271`, `database-materialized-views.ts:204`).

The `DeltaExecutor` reads changes exclusively from the `TransactionManager` change
log (`getChangedBaseTables` / `getChangedTuples`). A leaf MV's backing-table write
is performed via `MemoryTableManager.applyMaintenance` (per-binding delete/upsert)
or `replaceBaseLayer` (rebuild) — both **off** the user-transaction path
(`manager.ts:1122`, `manager.ts:1187`), so the write is **not** recorded in the
current commit's change log.

Concretely, for `mv2` whose body is `select ... from mv1`:
- `mv1` resolves to its backing table `sqlite_mv_mv1`, so `mv2.sourceTables` =
  `['main.sqlite_mv_mv1']` and its `DeltaSubscription.dependencies` =
  `{main.sqlite_mv_mv1}` (`collectSourceTables` in `materialized-view-helpers.ts`,
  `baseTablesInPlan` in `database-materialized-views.ts:304`).
- `DeltaExecutor.runOne`'s quick-skip (`delta-executor.ts:137`) checks
  `changedBases.has(dep)`. Because `sqlite_mv_mv1` was never written through the
  change log, it is absent from `changedBases`, so `mv2` is skipped this commit.

Result: `mv2` lags one commit per nesting level; a depth-N chain needs up to N
commits to converge, and interim reads of `mv2` return stale data with no error.

Note: v1 incremental MV bodies are **single-source** (multi-source/join bodies are
rejected at create — see `compile()` in `database-materialized-views.ts:252`), so a
cascade is a **linear chain** (a forest of chains across MVs), not a general DAG
with diamonds. The design below uses general topological ordering anyway, so it
stays correct when join bodies later land
(`materialized-view-incremental-join-bodies`).

## Solution

Within a single post-commit maintenance pass, process the incremental MVs in
**dependency topological order**, and make each MV's backing-table write visible to
its dependents via a manager-owned **delta overlay** layered on top of the
`TransactionManager` change log. Because the MV-dependency graph is a DAG (cycles
are structurally impossible: an MV's body is fixed at create, and the referenced
upstream MV must already exist), a **single topologically-ordered pass converges
the whole chain** — no fixpoint loop is required. A cycle guard logs a diagnostic
and degrades gracefully rather than looping unbounded.

### Architecture

```
runPostCommit():
  reset overlay (pendingDelta, globallyChangedBacking)
  executor.runAll({ order: topoOrderOfIncrementalMVs, rescanPerSubscription: true })

DeltaExecutor change source (overlay, owned by MaterializedViewManager):
  getChangedBaseTables() = txn.getChangedBaseTables()
                           ∪ pendingDelta.keys()
                           ∪ globallyChangedBacking
  getChangedTuples(base, cols, pk):
     base ∈ pendingDelta            → project cols out of the captured old/new rows
     otherwise (genuine user table) → delegate to txn.getChangedTuples
  isGloballyChanged(base) = globallyChangedBacking.has(base)

per-MV apply (unchanged contract — writes the backing table) ADDITIONALLY:
  per-binding success → capture touched backing PKs (before/after rows) into pendingDelta[backingBase]
  any full rebuild    → mark globallyChangedBacking.add(backingBase)
```

Backing-table names use the reserved `sqlite_mv_` prefix and never collide with
user-table names, so the overlay's per-base routing is unambiguous.

Tracing the fix for `t → mv1 → mv2`:
1. `insert into t` → txn `changedBases = {main.t}`.
2. Topo order `[mv1, mv2]`. Process `mv1`: dependency `main.t` changed → apply →
   writes `sqlite_mv_mv1` → records `pendingDelta['main.sqlite_mv_mv1']`.
3. `rescanPerSubscription` recomputes `changedBases` before `mv2` → now includes
   `main.sqlite_mv_mv1`. Process `mv2`: dependency changed → `getChangedTuples`
   reads the overlay → apply → `mv2` converges **this commit**.

If `mv1` instead took the full-rebuild branch (`globalRelations`, cost-fallback,
`deleteKeyOrder === null`, or Tier-1 recovery), `globallyChangedBacking` holds
`sqlite_mv_mv1`; `mv2`'s `runOne` sees `isGloballyChanged` and forces a **full
rebuild** of `mv2` (always correct).

### Kernel changes (`delta-executor.ts`) — keep consumer-neutral

The overlay and capture logic live entirely in the MV manager. The kernel only
needs three small, optional seams so assertions/watchers are unaffected (they call
`runAll()` with no options):

- Extend `DeltaExecutorContext` with optional `isGloballyChanged?(base: string): boolean`.
- Add a `RunAllOptions` parameter to `runAll`:
  - `order?: (subs: DeltaSubscription[]) => DeltaSubscription[]` — reorder the
    snapshot before dispatch (default: insertion order).
  - `rescanPerSubscription?: boolean` — recompute `changedBases =
    ctx.getChangedBaseTables()` before each `runOne` (default false), so an
    `apply` that grows the change source via the context is visible to later
    subscriptions in the same pass.
- In `runOne`, inside the per-relation loop, right after the
  `changedBases.has(base)` guard: `if (this.ctx.isGloballyChanged?.(base)) {
  globalRelations.add(relKey); continue; }`.

### Delta capture (`database-materialized-views.ts`)

The `apply` closure in `buildSubscription` already builds `ops: MaintenanceOp[]`
(per-binding) or calls a rebuild. Add capture:

- **Per-binding success path** (after `applyMaintenance(ops)` resolves): collect the
  de-duplicated set of touched backing PKs from `ops` (delete-key `op.key`; upsert
  `op.row` → `buildPrimaryKeyFromValues(pk-values, backingPkDefinition)` — the same
  function `buildDeleteKey` uses, so keys serialize identically and dedup cleanly).
  For each touched key, point-read the backing row **before** the
  `applyMaintenance` call (`manager.lookupEffectiveRow(key, manager.currentCommittedLayer)`)
  and **after**, then synthesize a `{ op, oldRow?, newRow? }` overlay change
  (`before&&after`→update, `!before&&after`→insert, `before&&!after`→delete,
  neither→skip) keyed by serialized PK. Store full rows so the overlay's
  `getChangedTuples` can project any requested `cols` directly (no capture-demand
  bookkeeping needed for backing tables).
- **Any full-rebuild path** (after `rebuildBacking`/`recoveryRebuild` resolves —
  the `globalRelations`, `deleteKeyOrder === null`, Tier-1 recovery, and diverged
  self-heal branches): `globallyChangedBacking.add(backingBase)`.
- **Total failure (Tier-2 diverged, no successful write):** record nothing.

`MemoryTableManager.lookupEffectiveRow` and the `currentCommittedLayer` getter are
already public; no new memory-layer surface is required for the per-binding capture
(verify while implementing — add a minimal helper only if needed).

### Topological order (`database-materialized-views.ts`)

- Cache a topo order; invalidate (`= null`) on `registerMaterializedView` and
  `releaseEntry` (any add/remove of an incremental entry).
- Build edges from `producer backing base → consumer` when a consumer's
  `dependencies` (its `baseTablesInPlan`) contains another incremental MV's backing
  base. Kahn's algorithm. Store `backingBase` on `CompiledIncrementalMV` (compute
  `mvKey(mv.schemaName, mv.backingTableName)` in `compile()`) and keep a
  `subId → rank` map so the executor's `order` callback can sort the live snapshot
  (subscriptions absent from the map sort last).
- **Cycle guard:** if Kahn leaves nodes unprocessed, `warnLog` a non-convergence
  diagnostic naming the MVs in the cycle and append them in insertion order. This
  satisfies the ticket's "bounded iteration + diagnostic on non-convergence"
  requirement without an unbounded loop — a single topo pass converges any DAG, and
  the (structurally impossible) cycle case degrades loudly instead of hanging.

### Known limitation to document (do not fix here)

If an upstream MV diverges (Tier-2: even its rebuild failed), its dependents are
maintained against the upstream's stale backing data without erroring (only direct
reads of the diverged MV error, via the `diverged` read-guard). Cascading
divergence propagation is out of scope; note it in the docs Limitations section
and, if it warrants tracking, file a `backlog/` ticket.

## Expected test outcomes (TDD targets for §13+ of `52-materialized-views-incremental.sqllogic`)

- **Linear chain converges in one commit.**
  ```sql
  create table t (id integer primary key, x integer);
  insert into t values (1, 10), (2, 20);
  create materialized view mv1 as select id, x + 1 as x1 from t with refresh = 'on-commit-incremental';
  create materialized view mv2 as select id, x1 * 10 as x10 from mv1 with refresh = 'on-commit-incremental';
  insert into t values (3, 30);
  select * from mv2 order by id;
  -- → mv2 reflects id=3 (x10=310) WITHOUT a second commit/refresh
  ```
- **Depth-3 chain** (`t → mv1 → mv2 → mv3`): a single source mutation converges all
  three the same commit.
- **Aggregate dependent over a row-preserving leaf** — `mv_sum as select k, sum(v)
  from mv_leaf group by k`: an update that moves a leaf row between groups drives
  both OLD and NEW groups of `mv_sum` in the same commit (exercises old/new
  projection capture from the overlay).
- **Cost-fallback / rebuild upstream propagates** — a bulk insert that demotes `mv1`
  to a full rebuild still converges `mv2` (via `globallyChangedBacking` → forced
  rebuild).
- **DELETE / predicate-exit ripples** — deleting a source row that removes an `mv1`
  row also removes the dependent `mv2` row the same commit.
- **Non-cascading MVs unchanged** — existing §1–§12 cases keep passing (no regression
  for leaf MVs; the overlay is empty on the first level).

## TODO

### Phase 1 — kernel seams
- Add `isGloballyChanged?(base)` to `DeltaExecutorContext`.
- Add `RunAllOptions { order?, rescanPerSubscription? }` to `DeltaExecutor.runAll`; apply `order` to the snapshot and recompute `changedBases` per subscription when `rescanPerSubscription`.
- In `runOne`, force a relation to `globalRelations` when `ctx.isGloballyChanged?.(base)` is true.
- Confirm assertions/watchers (`database-assertions.ts`, `database-watchers.ts`) still call `runAll()` with no args — no behavior change.

### Phase 2 — overlay change source + capture (MV manager)
- Add overlay state: `pendingDelta: Map<backingBase, Map<pkKey, { op, oldRow?, newRow? }>>` and `globallyChangedBacking: Set<string>`; reset both at the top of `runPostCommit`.
- Replace the executor context (built in the ctor) with the overlay-aware functions (`getChangedBaseTables`, `getChangedTuples`, `isGloballyChanged`, `getRowCount` unchanged).
- Store `backingBase` on `CompiledIncrementalMV` (set in `compile()`).
- In the `apply` closure: capture per-binding touched-PK before/after rows into `pendingDelta`; mark `globallyChangedBacking` after every successful full rebuild; record nothing on Tier-2.
- Verify `MemoryTableManager.lookupEffectiveRow` + `currentCommittedLayer` suffice for the before/after point reads; add a tiny helper only if needed.

### Phase 3 — topological ordering
- Add a cached topo order over incremental MVs (Kahn over backing-base dependency edges); invalidate on register/unregister.
- Pass `order` + `rescanPerSubscription: true` to `runAll` in `runPostCommit`.
- Implement the cycle guard (warn diagnostic + insertion-order fallback).

### Phase 4 — tests + docs
- Extend `52-materialized-views-incremental.sqllogic` with the cascade cases above (new §13+).
- Update `docs/materialized-views.md` § Incremental refresh → Limitations: remove the "Cascading MVs may need more than one commit" bullet (now resolved) and replace it with the resolved behavior + the cascading-divergence caveat. Update the `database-transaction.ts:266` comment that currently documents the lag.
- Update `docs/incremental-maintenance.md` § Third consumer to describe the topo-ordered pass + overlay change source.

### Phase 5 — validate
- `yarn workspace @quereus/quereus run build` then `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mv-cascade.log; tail -n 80 /tmp/mv-cascade.log` (stream output; don't silently redirect).
- Lint: `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- If a pre-existing, unrelated failure surfaces, follow the `.pre-existing-error.md` flag procedure rather than chasing it.
