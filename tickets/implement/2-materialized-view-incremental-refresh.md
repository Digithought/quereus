description: Phase 2 of materialized views — incremental maintenance via a `DeltaSubscription` registered with a `DeltaExecutor` owned by the (already-existing) `MaterializedViewManager`. Adds a `refresh policy` knob (manual / on-commit-incremental), per-binding delete-then-upsert apply into the backing table, an FD-coverage eligibility gate, and automatic full-refresh fallback for `'global'` bindings and for the cost-cliff. Kernel surface (`DeltaSubscription`, `BindingMode`, capture-spec, cost fallback) is already live (assertions + watchers consume it); this ticket lights up the documented plug-in pattern for MVs.
prereq: materialized-view-core
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/core/database-watchers.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/vtab/memory/layer/manager.ts, docs/incremental-maintenance.md, docs/materialized-views.md, docs/optimizer.md
----

## Scope

Add a third consumer to the `DeltaExecutor` kernel that maintains materialized-view
backing tables incrementally on COMMIT. Structurally it mirrors `database-watchers.ts`
(post-commit phase, failed apply logs-and-skips, never rolls the user's commit back),
but its `apply` **writes** (delete-then-upsert into the backing table) instead of
firing a handler.

The kernel surface is already complete and consumer-neutral — **no kernel changes
are required**. New surface is: a `refreshPolicy` knob, the eligibility gate at
create time, the per-MV subscription compilation, the backing-table maintenance
write path, and the source-union change-scope projection.

## Grounded state of the world (read before writing code)

The phase-1 core (`materialized-view-core`) has **landed** (`tickets/complete/1-materialized-view-core.md`).
Several pieces the original plan assumed are "new" already exist — extend them:

- **`MaterializedViewManager` already exists** (`core/database-materialized-views.ts`)
  as a *staleness-only* manager: it takes just `schemaManager`, subscribes to
  `table_removed`/`table_modified`, and flips `mv.stale`. This ticket **extends** that
  class — it does not create a new one. Give it a `DeltaExecutor` (mirror
  `WatcherManager`'s ctor/`DeltaExecutorContext` wiring), broaden its constructor
  context from `SchemaManager` to a `Database`-backed context (the same shape
  `WatcherManagerContext` uses: `schemaManager`, `optimizer`, `getChangedBaseTables`,
  `getChangedTuples`, `registerCaptureSpec`, `_findTable`, plus the bits needed to
  build/optimize/emit a residual plan — `_buildPlan`, `prepare`,
  `getInstructionTracer`, `options`). Keep the existing staleness subscription.
  `database.ts:140` currently constructs it with `this.schemaManager` — change to `this`.
- **The MV builder is `planner/building/materialized-view.ts`** (one file with
  create/refresh/drop builders), **not** `create-materialized-view.ts`.
- **`CreateMaterializedViewStmt`** is `parser/ast.ts:326` (already carries
  `moduleName`/`moduleArgs`/`tags`). Add `refreshPolicy` here.
- **The full-rebuild path already exists** inline in `emitRefreshMaterializedView`
  (`runtime/emit/materialized-view.ts:97`): `collectBodyRows(db, bodySql)` →
  `getBackingManager(backing)` → `manager.replaceBaseLayer(rows)`. Extract this into
  a shared helper in `materialized-view-helpers.ts` (e.g. `rebuildBacking(db, mv)`)
  and reuse it from both `emitRefreshMaterializedView` and the incremental
  manager's global/cost-fallback path. **Do not duplicate it.**
- **The drop emitter has the wiring stub**: `runtime/emit/materialized-view.ts:163`
  — `// (Phase 2 placeholder) detach any DeltaSubscription — no-op in v1.` Replace
  with a real detach (notify the manager, or have the manager react to
  `materialized_view_removed`).
- **`unionScopes(a, b)` already exists** (`change-scope.ts:681`); `analyzeChangeScope`
  (`change-scope.ts:203`) is the entry. There is **no** MV-reference handling in
  change-scope today (an MV resolves to a `TableReferenceNode` over its backing
  table, so the scope currently reports the backing table). The source-union
  projection is genuinely new.
- **Post-commit phase wiring**: `database-transaction.ts:258` already calls
  `runPostCommitWatchers()` inside the post-commit `try` (after connections commit,
  while the change log is still alive). MV maintenance runs in the same window —
  add a sibling `runPostCommitMaterializedViews()` on `Database` and invoke it next
  to the watcher call. Order matters for cascading MVs (see below).

## Design

### `refresh policy`

Extend `MaterializedViewSchema` (`schema/view.ts`) with:

```ts
type RefreshPolicy =
  | { kind: 'manual' }                  // default; bit-for-bit phase-1 behavior
  | { kind: 'on-commit-incremental' };  // this ticket
```

Default is `manual`, so an existing MV is unchanged. A future `on-commit-full`
policy is **out of scope** (filed to backlog).

Surface syntax (finalize in this ticket; keep consistent with the existing trailing
`with tags (...)` clause that already parses on `create materialized view`):

```sql
create materialized view mv
  with refresh = 'on-commit-incremental'
  as select ...;
```

Parse into `CreateMaterializedViewStmt.refreshPolicy`; round-trip through
`emit/ast-stringify.ts` (`createMaterializedViewToString`). Thread it through
`CreateMaterializedViewNode` → the create emitter → the stored `MaterializedViewSchema`.

### Eligibility gate (create time)

An MV qualifies for `on-commit-incremental` iff **every** source `TableReferenceNode`
in the optimized body classifies as `'row'` or `'group'` (not `'global'`) under
`extractBindings`. Reuse `optimizer.optimizeForAnalysis(plan, db)` to get the
pre-physical analyzed plan (exactly as `database-assertions.ts:253` does), then
`extractBindings(analyzed)`.

`create materialized view ... with refresh = 'on-commit-incremental'` on an
ineligible body **errors at create time** (in the builder or create emitter),
naming each `'global'`-classified source. This is the same signal the eligibility
path already exposes; reusing it keeps the surface coherent.

Reject set-ops with bag-distinguishing semantics (UNION/INTERSECT/EXCEPT other
than `union all`) and recursive CTE bodies up front with a clear diagnostic — both
are filed to backlog (`materialized-view-incremental-set-ops`,
`materialized-view-incremental-recursive-cte`).

### The maintenance write path — **resolve this first; it is the biggest risk**

The backing table is **read-only to users** (the phase-1 write boundary). Concretely:
`MemoryTableManager.performMutation` (`vtab/memory/layer/manager.ts:600`) calls
`validateMutationPermissions`, which throws `READONLY` for the MV backing table; and
DML builders refuse MV names via `assertNotMaterializedView`. Manual refresh sidesteps
all of this by going manager-level: `replaceBaseLayer(rows)` (`manager.ts:1101`) swaps
the committed base layer wholesale.

Incremental apply needs **per-row** delete + insert/upsert against the committed base
layer, post-commit, bypassing the user write-boundary. Decide and implement one of:

- **(Preferred) A manager-level maintenance entry point** on `MemoryTableManager`
  (sibling to `replaceBaseLayer`) that applies a batch of `{ delete: key[] }` /
  `{ upsert: Row }` operations directly to the base layer under the same `SchemaChange`
  latch `replaceBaseLayer` uses — explicitly *not* gated by `validateMutationPermissions`
  and not requiring a user `MemoryTableConnection`. This keeps maintenance writes off
  the user-transaction path entirely (consistent with post-commit, fire-and-forget).
- Alternatively, open an internal maintenance transaction/connection on the backing
  table post-commit and route mutations through `performMutation` with the read-only
  guard relaxed for maintenance — heavier, and re-enters the transaction machinery
  the watcher path deliberately avoids. Document the tradeoff if you go this way.

Verify the chosen API surfaces:
- **delete by full MV-PK** (the per-row case),
- **delete by PK prefix / range** (the `'group'` case where the MV-PK is a strict
  superset of the group key — see "group delete-key" below). Check whether the base
  layer's btree/scan-plan exposes a range delete; if not, fall back to "scan the
  prefix, collect matching full keys, delete each" and note the cost.

### `MaterializedViewSubscription` compilation

For each `on-commit-incremental` MV, at create time (and on schema-change
re-validation), the manager builds a cached entry — structurally the
`CachedAssertionPlan`/`compileUnderSuppression` shape from `database-assertions.ts`,
adapted to write instead of assert:

1. `extractBindings(analyzedBody)` → `PlanBindings`.
2. Register capture demand (`db.registerCaptureSpec`) for non-PK columns referenced
   by `'group'` group-keys and by `'row'` keys picked from a non-PK unique key
   (PK columns are always captured — see the assertion path's `recordExtras`).
3. For each `'row'`/`'group'` binding, inject a key-filter on the source
   `TableReferenceNode` and pre-compile a **residual scheduler** that runs the MV
   body restricted to one binding tuple's worth of source rows. Reuse the
   `injectKeyFilter` machinery from `database-assertions.ts` (lift the shared
   `injectKeyFilter`/`tryWrapTableReference`/NULL-safe-equality helpers into a
   shared module if it reduces duplication — assertions, and now MVs, both need it;
   this is a candidate refactor, not a requirement).
4. Build a `DeltaSubscription` whose `apply`:
   - **Per-relation tuple batch** (`input.perRelationTuples`): bind the residual
     params (`pk0..`/`gk0..`), run the residual scheduler to produce the recomputed
     rows for that binding, **delete** backing-table rows whose MV-PK matches the
     affected binding's projection, then **insert** the residual output. Net effect
     is a per-binding delete-then-upsert.
   - **`globalRelations`** (cost fallback fired, or a `'global'` binding present):
     re-run the full body and swap the base layer via the extracted `rebuildBacking`
     helper — identical to manual refresh.

### Subtleties to nail down

- **Group delete-key.** The MV-PK comes from the *body*'s `keysOf`; a `'group'`
  binding's `groupColumns` are coordinates in the *source*'s output space. The delete
  predicate must translate source-group-key → MV-PK via the body's projection. For
  `group by x, y → sum(z)`, the binding tuple `(x, y)` is the MV-PK directly (common
  case). Where the MV-PK is a strict superset of the group key, delete by a *prefix*
  of the MV-PK (range delete — see write-path API above).
- **OLD/NEW group transitions.** An UPDATE that moves a row between groups emits both
  OLD and NEW projections (already captured by the change layer — see
  `incremental-maintenance.md` § Recording changes). Both must drive the apply so the
  OLD group's MV row is recomputed (possibly deleted) and the NEW group's recomputed
  (possibly inserted).
- **Join bodies.** A two-source equi-join MV yields two `'row'` bindings (one per
  source). For each affected outer-row, recompute the join's contribution for that
  outer row only — exactly the per-binding residual, applied at the source-table
  level.
- **Aggregate bodies with HAVING.** `having` is post-aggregate; `'group'`
  classification captures the source's group cover correctly. Apply is
  delete-then-*conditional*-insert (a recomputed group may now fail HAVING → omitted,
  so the delete stands with no re-insert).
- **DISTINCT.** Trivial `'group'` over all columns.
- **`order by` in body.** Ordering is a layout property of the backing table (the
  physical PK seeds ordering columns ahead of the logical key — see
  `computeBackingPrimaryKey` in `materialized-view-helpers.ts`). The memory vtab
  reinserts in PK order; verify no double-sort and that an incremental insert lands
  at the correct position.
- **Bag bodies / all-columns PK.** When `keysOf` yields no key, the body materializes
  on an all-columns PK (already incremental-ineligible-ish, and the source of the
  filed `materialized-view-bag-body-duplicates` failure). Under incremental, a
  duplicate-producing body hits the same UNIQUE-on-PK failure on upsert. Don't fix
  that here — surface the same loud failure and note the interaction; the contract
  fix lives in that backlog ticket.
- **Cost fallback.** `deltaPerRowFallbackRatio` already demotes per-binding to global
  in the kernel. For MVs, "global" = the full `rebuildBacking` path. No new logic —
  just route `globalRelations` to the rebuild helper.

### Manual refresh interaction

`refresh materialized view mv` works regardless of policy. For an
`on-commit-incremental` MV it is the resync escape valve (debugging / suspected
divergence). Already implemented; just confirm it coexists.

### `getChangeScope()` for MV references (`change-scope.ts`)

A `select` from an `on-commit-incremental` MV resolves to a `TableReferenceNode` over
the backing table, so `analyzeChangeScope` currently reports the *backing table*.
Project it to the **union of the MV's sources' scopes** instead, computed once at MV
create time and cached on the `MaterializedViewSchema` (reuse `unionScopes`,
`change-scope.ts:681`). Detect "this `TableReferenceNode` is an `on-commit-incremental`
MV backing table" via the schema manager (backing-table name ↔ MV lookup; the
`sqlite_mv_` prefix / `backingTableNameFor`). A `Database.watch` against such an MV
then fires on source mutations. Manual-refresh MVs keep reporting just the backing
table (their cadence is `refresh`, not source mutations).

### Cascading MVs (registration order)

MV-over-MV: source changes drive the leaf MV's apply, whose backing-table write drives
the next MV's apply. The kernel walks subscriptions in registration order, and the MV
manager's post-commit run happens in one pass over the live change log. A backing-table
write made *during* the post-commit pass is not itself in the current change log, so a
dependent MV may not converge in one commit. **v1 documents this limitation** and files
`materialized-view-incremental-cascading-convergence` to backlog. Register MVs in
dependency order where cheaply knowable, but do not build a topological scheduler here.

## Build / test commands

- `yarn workspace @quereus/quereus build`
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows)
- `yarn workspace @quereus/quereus test` — stream: `... 2>&1 | tee /tmp/mv.log; tail -n 80 /tmp/mv.log`

## Key tests (write alongside the code — TDD)

Primary corpus: a new `test/logic/52-materialized-views-incremental.sqllogic`
(mirror `51-materialized-views.sqllogic`), plus targeted unit specs in `test/plan/`
and `test/runtime/`.

- **Eligibility gate.** `create materialized view ... with refresh = 'on-commit-incremental'
  as select * from t cross join (select 1)` → errors at create, naming the `'global'`
  source. An eligible keyed/aggregate body succeeds.
- **Per-row apply.** `select id, x+1 from t` (keyed). insert/update/delete on `t`
  updates the MV at commit; reads see new state with no manual refresh.
- **Per-group apply.** `select x, sum(y) from t group by x`. New `x=k` creates an MV
  row at commit; deleting the only row for `x=k` removes the MV row.
- **OLD/NEW group transition.** Update `t` changing its group-by value → both OLD and
  NEW group rows recompute. Extend the existing OLD/NEW surface in `test/runtime/`.
- **Cost fallback.** Insert > `deltaPerRowFallbackRatio` of `t`'s rows in one txn →
  full rebuild (assert the base layer is swapped, not patched — e.g. via a probe that
  distinguishes rebuild from per-row patch).
- **Manual refresh still works** on an `on-commit-incremental` MV (resync).
- **Schema-change invalidation.** Drop a source → subscription detaches cleanly; MV
  reads error "stale" until dropped/recreated (existing staleness path; confirm the
  incremental subscription is also released).
- **`getChangeScope()` for incremental MV** reports source tables, not the backing
  table; a `Database.watch` on the MV fires on source mutations.
- **Post-commit error policy.** Body that errors mid-apply at commit → manager logs and
  drops; the user's commit stands (matches `database-watchers.ts`). Add to
  `test/runtime/`.
- **Set-op / recursive-CTE rejection** under `on-commit-incremental` errors clearly.

## TODO (implement)

Phase A — manager skeleton + write path
- Extend `MaterializedViewManager` (`core/database-materialized-views.ts`): own a
  `DeltaExecutor`, broaden its constructor context to a `Database`-backed shape
  (mirror `WatcherManagerContext`), keep the existing staleness subscription. Update
  `database.ts:140` to pass `this`.
- Add `runPostCommitMaterializedViews()` on `Database` and invoke it in
  `database-transaction.ts` next to `runPostCommitWatchers()` (post-commit, change log
  alive, errors swallowed).
- Implement the backing-table **maintenance write path** (manager-level delete/upsert
  on `MemoryTableManager`, bypassing the read-only guard — see "write path" above).
  This unblocks everything else; do it first and unit-test it directly.

Phase B — refresh policy + eligibility + subscription compilation
- Add `RefreshPolicy` to `MaterializedViewSchema`; parse `with refresh = '...'` into
  `CreateMaterializedViewStmt.refreshPolicy`; round-trip in `ast-stringify.ts`; thread
  through the create node/emitter into the stored schema. Default `manual`.
- Eligibility gate at create time (builder/emitter): `optimizeForAnalysis` +
  `extractBindings`; reject `'global'` sources (name them) and set-op/recursive bodies.
- Extract the shared full-rebuild helper (`rebuildBacking`) from
  `emitRefreshMaterializedView` into `materialized-view-helpers.ts`; reuse from refresh.
- Build the cached subscription per MV: `extractBindings`, capture demand, per-binding
  residuals via `injectKeyFilter` (reuse/lift from `database-assertions.ts`).

Phase C — apply path
- `apply`: per-binding delete-then-upsert; OLD/NEW group handling; group delete-key
  (PK vs prefix); `globalRelations` → `rebuildBacking`.
- Wire the drop-emitter Phase-2 placeholder (`runtime/emit/materialized-view.ts:163`)
  to detach the subscription + release capture demand.

Phase D — change-scope + docs
- `change-scope.ts`: project an `on-commit-incremental` MV reference to the cached
  source-union scope (`unionScopes`); detect MV backing tables via the schema manager.
- Update `docs/incremental-maintenance.md` (move MV from "still to come" to a live
  "Third consumer: MaterializedViewManager" section; refresh the pipeline diagram),
  `docs/materialized-views.md` (incremental-refresh section: policy, eligibility,
  apply contract, OLD/NEW, cost fallback, cascading limitation), and the
  `docs/optimizer.md` binding-aware-delta cross-reference.

> If budget runs short, Phase D (change-scope + docs) is the cleanest seam to split
> into a same-stage follow-up ticket (`prereq` this slug) per the BUDGET_WARNING rules —
> Phases A–C are the functional core and should land together.
