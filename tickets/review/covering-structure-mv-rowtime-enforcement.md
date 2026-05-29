description: Review of row-time UNIQUE enforcement routed through an explicit row-time covering materialized view's backing table. The `materialized-view` arm of `CoveringStructure` is now a live enforcement path: `findIndexForConstraint` returns it (in preference to the auto-index) when a linked, non-stale, non-diverged `row-time` covering MV exists, and conflict resolution point-looks-up the MV's backing table (reads-own-writes) to recover the conflicting source PK so REPLACE/IGNORE/ABORT resolve against the correct source row.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-internal.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/index.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/view.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus-store/test/unique-constraints.spec.ts, docs/materialized-views.md, docs/lens.md
----

## What landed

The deferred second half of `covering-structure-unique-enforcement`. The recognition +
linkage shipped earlier; the prerequisite `materialized-view-rowtime-write-through` was
already landed. This ticket consumes that capability and makes the `materialized-view`
arm of `CoveringStructure` a live enforcement path.

### Phase 1 — MV manager + Database surface (`database-materialized-views.ts`, `database.ts`, `database-internal.ts`)

- `MaterializedViewManager.findRowTimeCoveringStructure(schema, table, uc)` — returns the
  linked, `row-time`, non-stale, non-diverged covering MV, or `undefined`. O(1) negative
  fast path off `rowTimeBySource`. Resolves the constraint's `coveringStructureName`
  forward pointer; **falls back** to the authoritative schema-manager constraint matched by
  column set (`resolveCoveringStructureName`) because a store table holds a *copied* schema
  whose `uc.coveringStructureName` never received the eager link's mutation.
- `MaterializedViewManager.lookupCoveringConflicts(mv, uc, newRow, newSourcePk)` — full
  scan of the backing table through the coordinated connection (`pendingTransactionLayer ??
  readLayer` → reads-own-writes), maps source UC/PK cols → backing cols via the inverse of
  `projectionSourceCols`, matches UC values (collation-aware off the source schema),
  recovers each conflicting source PK, excludes `newSourcePk`. Returns candidate source
  PK(s). **v1 is a full scan**; a backing-PK prefix scan is the deferred optimization.
- `Database._findRowTimeCoveringStructure` / `_lookupCoveringConflicts` shims (next to the
  existing `_maintainRowTimeCoveringStructures` / `_hasRowTimeCoveringStructures`). All three
  added to the exported `DatabaseInternal` interface (for the store; see caveat below).
- `MaterializedViewSchema` / `ViewSchema` / `RefreshPolicy` now exported from `src/index.ts`.

### Phase 2 — memory enforcement (`vtab/memory/layer/manager.ts`)

- `findIndexForConstraint` returns `{ kind: 'materialized-view', view }` in **preference to**
  `memory-index` when `_findRowTimeCoveringStructure` returns an MV.
- `checkSingleUniqueConstraint` is now `async`; the `materialized-view` arm calls the new
  `checkUniqueViaMaterializedView`; the partial-UNIQUE source-side skip handles the MV case
  via `uc.predicate` (the prover proves the MV's WHERE equivalent to it).
- `checkUniqueViaMaterializedView`: for each candidate, **validates against the live source
  row** (`lookupEffectiveRow` + UC re-match) before acting — a backing entry can lag a row
  deleted/updated internally this statement (e.g. the PK-changing UPDATE's old-row delete),
  so a stale candidate is skipped rather than raised as a false conflict. REPLACE evicts the
  source row (`recordDelete`) **and** drives `_maintainRowTimeCoveringStructures(delete)` so
  the evicted row's backing entry is removed mid-statement.
- `checkUniqueConstraints` + `performUpdateWithPrimaryKeyChange` are now `async`; all call
  sites awaited. `uniqueColumnsChanged` compiles `uc.predicate` ad hoc for the MV/uncovered
  case (cold path) to learn predicate-referenced columns.

### Phase 3 — store parity (`quereus-store/src/common/store-table.ts`)

- `checkUniqueConstraints` routes through `_findRowTimeCoveringStructure` /
  `_lookupCoveringConflicts` (new `findUniqueConflictViaCoveringMv`) when a covering MV
  exists, validating candidates against the live store row (committed + pending overlay via
  new `readLiveRowByPk`). REPLACE eviction (`deleteRowAt`) is followed by
  `_maintainRowTimeCoveringStructures(delete)`.

### Phase 4 — tests + docs

- `test/covering-structure.spec.ts` — new `row-time covering enforcement` block (12 tests):
  resolver behavior, ABORT/IGNORE/REPLACE, ON CONFLICT existingRow recovery, intra-statement
  dup, UPDATE-onto-existing-UC (+ schema-level `on conflict replace`), PK-only-change
  self-move (the liveness regression), PK-change-onto-existing, partial covering MV,
  non-row-time fall-through.
- `test/logic/54-covering-mv-enforcement.sqllogic` — runs under **both** `yarn test`
  (memory source) and `yarn test:store` (store source). Asserts enforcement outcomes +
  source-table state (which hold on both paths).
- `quereus-store/test/unique-constraints.spec.ts` — new `covering materialized-view
  enforcement` block (5 tests) exercising `store-table.ts` **directly** (no isolation),
  including OR REPLACE backing-consistency.
- `docs/materialized-views.md` (§ Covering structures → "Enforcement through a row-time
  covering MV") and `docs/lens.md` (§ Constraint Attachment) flipped from "deferred" to
  "delivered"; `table.ts`/`view.ts` field comments updated.

## Validation performed

- `yarn workspace @quereus/quereus test` (full memory suite): **3810 passing, 9 pending, 0 failing**.
- `@quereus/store` package suite: **274 passing, 0 failing** (logged "boom"/invalid-DDL lines are intentional fixtures).
- Targeted store-isolation sweep (`QUEREUS_TEST_STORE=true`) over 12 UNIQUE/constraint/MV/upsert logic files incl. `54`: **all pass**.
- `covering-structure.spec.ts`: **51 passing**. `unique-constraints.spec.ts` covering block: **5 passing**. `54.sqllogic` under memory + store: **pass**.
- `yarn workspace @quereus/quereus run typecheck` + `lint`: clean. `@quereus/store` typecheck: clean.

## Honest gaps / sharp edges for the reviewer (treat tests as a floor)

1. **Performance: v1 is a full backing scan per conflict check.** With a linked row-time
   covering MV present on a *physical* table, `findIndexForConstraint` now **prefers the MV
   over the auto-index**, so every UNIQUE insert/update does an **O(n) backing scan** instead
   of an O(log n) index probe — a bulk insert becomes O(n²). This is intended per the ticket
   (it makes the MV path live + testable in v1) and the backing-PK prefix-scan optimization is
   explicitly deferred, but it is a real regression for physical tables that happen to have a
   row-time covering MV. Worth a hard look: is the *preference* (MV over auto-index) the right
   v1 default for physical schemas, or should the auto-index win until the prefix scan lands?
   The auto-index remains maintained but unconsulted either way.

2. **The isolation-wrapped store path does NOT route through the MV.** `yarn test:store`
   exercises the store via `createIsolatedStoreModule` (quereus-isolation), whose
   `isolated-table.ts` enforces UNIQUE via its own merged-view (overlay + underlying)
   detection — it never calls `store-table.ts`'s `checkUniqueConstraints`. So the store-table
   MV routing is **only** exercised by the direct (non-isolated) `unique-constraints.spec.ts`.
   Enforcement *outcomes* under the isolation sweep are correct (its own logic), but the
   covering MV's **backing is not maintained for the isolation layer's internal REPLACE
   evictions** (the MV-query-after-internal-eviction would show a stale row on that path).
   `54.sqllogic` therefore deliberately omits the backing-consistency (`select from mv`)
   assertions for internal-eviction cases (kept in the memory + direct-store specs).
   Routing the isolation layer through the covering MV is **not done** (the ticket named
   `store-table.ts`); consider whether it warrants a follow-up `fix/`+`backlog/` ticket.

3. **`DatabaseInternal` is effectively `any` cross-package.** `stripInternal: true` + a
   file-banner `@internal` strip the whole `DatabaseInternal` interface from quereus's emitted
   `.d.ts`, so the store's `(this.db as DatabaseInternal)._lookupCoveringConflicts(...)` calls
   are runtime-duck-typed `any` (consistent with the pre-existing `registerConnection` usage).
   The interface additions are correct and documentary but provide no cross-package type
   safety. Reviewer: confirm this is acceptable, or consider un-stripping the interface.

4. **`resolveCoveringStructureName` column-match.** The store fallback matches the live
   constraint by exact column-index-list equality; a (degenerate) table with two UCs over the
   same column list would be ambiguous. Acceptable for v1.

5. **Liveness validation re-reads the source per candidate.** Sound (it's the backstop against
   stale-backing phantoms), but it means the backing scan is a *candidate generator* validated
   against live source — verify this is the intended soundness contract (it matches the
   ticket's "recover it from the source layer/store via the conflict PK").

6. **`yarn test:store` full sweep not run** (slow, ~10+ min, idle-timeout risk under tess) —
   ran a targeted 12-file subset + the store package suite instead, per the ticket's guidance.
   Deferred to CI.

## Suggested review focus

- Re-derive the soundness gate: the conflict check runs *during* the source write, before that
  row's `maintainRowTime`, so the backing reflects prior rows but not the row being checked.
  Confirm the liveness-validation + `newSourcePk` exclusion together never miss a real conflict
  and never raise a phantom (esp. multi-row statements, REPLACE chains, PK-changing UPDATEs).
- Confirm no double-maintenance: the DML-executor row-time hook maintains the *outer* statement
  row; the internal eviction maintains the *evicted* row; they must not overlap (they don't —
  different rows).
- Stress the partial-covering-MV path (predicate scope transitions) and collation-sensitive UC
  columns (the full scan uses source-column collation for the UC match; the existing scan
  fallback used plain `compareSqlValues` — verify the chosen collation behavior is right).
