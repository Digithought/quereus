description: Review the incremental materialized-view implementation — `with refresh = 'on-commit-incremental'` policy, create-time eligibility gate, the `MaterializedViewManager` delta subscription, the manager-level backing-table maintenance write path, and per-binding delete-then-upsert apply with full-rebuild fallback. Phases A–C + docs landed here; Phase D change-scope projection split to `materialized-view-incremental-changescope`.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/planner/analysis/key-filter.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md, docs/incremental-maintenance.md, docs/optimizer.md
----

## What landed

A third consumer of the `DeltaExecutor` kernel: `on-commit-incremental` materialized
views maintained at COMMIT. Build + lint + full test suite green (**3747 passing,
9 pending**); new corpus `test/logic/52-materialized-views-incremental.sqllogic`.

- **Refresh policy.** `MaterializedViewSchema.refreshPolicy: RefreshPolicy`
  (`{kind:'manual'}` default | `{kind:'on-commit-incremental'}`). Surface syntax is a
  **trailing** `with refresh = '...'` clause (sibling to the existing trailing
  `with tags`, per the ticket's "keep consistent with the existing trailing clause"
  — note this differs from the ticket's pre-`as` *example*). Parses into
  `CreateMaterializedViewStmt.refreshPolicy`, round-trips in `ast-stringify`, threads
  through `CreateMaterializedViewNode` → create emitter → stored schema.
- **Manager.** `MaterializedViewManager` now owns a `DeltaExecutor` and a
  `Database`-backed context (broadened from `SchemaManager`; `database.ts` passes
  `this`). Keeps the phase-1 staleness subscription; additionally releases an MV's
  incremental subscription on source schema-change and on `materialized_view_removed`.
- **Post-commit wiring.** `Database.runPostCommitMaterializedViews()` invoked in
  `database-transaction.ts` next to `runPostCommitWatchers()` (post-commit window,
  change log alive, errors swallowed).
- **Write path.** `MemoryTableManager.applyMaintenance(ops)` — manager-level
  delete-key/upsert against the committed base layer under the SchemaChange latch,
  **bypassing** `validateMutationPermissions` (the user read-only boundary) and the
  transaction machinery. The "preferred" option from the ticket.
- **Shared `injectKeyFilter`.** Lifted from `database-assertions.ts` into
  `planner/analysis/key-filter.ts`; assertions now import it (DRY; behavior-preserving
  — full suite incl. assertions green).
- **Eligibility gate.** Set-ops (non-`union all`) and recursive CTEs rejected
  structurally in the builder; binding-eligibility rejected at create in the manager
  (rolls the MV + backing table back).
- **Apply.** Per-binding delete-then-upsert; `globalRelations` (cost fallback) →
  full `rebuildBacking` (shared helper extracted from the refresh emitter). Drop
  emitter detaches the subscription.
- **Docs.** `materialized-views.md` (new § Incremental refresh), `incremental-maintenance.md`
  (new § Third consumer), `optimizer.md` cross-ref updated.

## ⚠️ The #1 thing to scrutinize — bindings are SYNTHESIZED, not from `extractBindings`

The ticket's central premise — "reuse `extractBindings` classification; reject
`'global'` sources" — **does not hold for canonical MV bodies**, and this was the
biggest design decision. `extractBindings`/`analyzeRowSpecific` classify `'row'`
only when *equality constraints* cover a unique key, and `'group'` only when the
`GROUP BY` closure covers a unique key. So:

- `select id, x+1 from t` → t classifies **`'global'`** (no equality predicate).
- `select k, sum(v) from g group by k` (k not a key of g) → g classifies **`'global'`**.

Both canonical MV bodies the ticket lists as headline tests would be rejected by a
literal "reject `'global'`" gate. So `compile()` in `database-materialized-views.ts`
**derives maintenance bindings directly** instead:
- single-source, no aggregate → `'row'` on the source **primary key**;
- single-source aggregate over bare `GROUP BY` columns → `'group'` on those columns.
The synthesized `BindingMode` map is handed to the *same* unchanged kernel, which
dispatches per changed PK/group tuple. **Reviewer: confirm this is sound** (it binds
on source identity, which is the correct notion for maintenance) and that the
divergence from the ticket text is acceptable. This is the highest-leverage area to
re-derive from first principles.

## Known gaps / deltas from the ticket (treat tests as a floor)

- **Single-source only.** Multi-source / join bodies are **rejected** at create
  (the ticket envisioned join MVs). Joins need per-source bindings the synthesis
  doesn't yet build — deferred. A new ticket should cover join MVs.
- **Delete-key mapping → rebuild fallback.** The binding→physical-PK delete key is
  computed via attribute provenance (`computeDeleteKeyOrder`). When it isn't clean —
  notably **`order by` bodies** (physical PK seeded with ordering columns) and
  **`DISTINCT`** (MV-PK = all columns, not the source PK) — that relation falls back
  to a **full rebuild**. Correct, but not incremental. Verify the fallback triggers
  rather than mis-deleting. No dedicated test asserts these take the rebuild path.
- **Cost-fallback probe.** `52-...sqllogic` § 5 asserts *correctness* after a bulk
  insert, but does **not** distinguish "rebuilt base layer" from "per-row patched"
  (the ticket asked for a probe). A white-box unit test in `test/runtime/` spying on
  `replaceBaseLayer` vs `applyMaintenance` would close this.
- **Post-commit error policy** ("body errors mid-apply → log & drop, commit stands")
  is implemented (try/catch around `apply`) but **not** unit-tested — hard to force a
  deterministic apply error. Reviewer may want a fault-injection test.
- **`applyMaintenance` not unit-tested directly** — exercised end-to-end via the
  sqllogic corpus only.
- **NULL group keys.** `getChangedTuples` can emit NULL group tuples; the residual's
  NULL-safe equality (inherited from `injectKeyFilter`) handles the filter, and the
  delete key is built with the NULL value. Worth a targeted test (`group by` over a
  nullable column with NULLs).
- **Cascading MVs (MV-over-MV)** may need >1 commit to converge — documented
  limitation; backing writes during the post-commit pass aren't in the current change
  log. Filed: `materialized-view-incremental-cascading-convergence` (not yet created
  as a ticket — reviewer may file it).
- **Bag bodies** (keyless, all-columns PK) hit the same `UNIQUE constraint failed` on
  a duplicate upsert that manual refresh hits — interaction documented, fix lives in
  `materialized-view-bag-body-duplicates`.
- **Phase D change-scope** (`getChangeScope()` projecting an incremental MV ref to its
  source scopes, so `Database.watch` on the MV fires on source mutations) is **split**
  to `materialized-view-incremental-changescope` (implement/, prereq this slug).

## How to validate

```
yarn workspace @quereus/quereus build
yarn workspace @quereus/quereus lint
yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mv.log; tail -n 40 /tmp/mv.log
# Targeted:
cd packages/quereus && node test-runner.mjs --grep "52-materialized-views-incremental"
```

### Use cases covered by `52-...sqllogic`
1. **Per-row apply** — `select id, x+1 as x1 from t`; insert/update/delete on `t`
   reflected at commit, no manual refresh.
2. **Per-group apply** — `select k, sum(v) as sv from g group by k`; new row in a
   group, new group, deleting a group's only row.
3. **OLD/NEW group transition** — `update g set k=...` recomputes both groups.
4. **Manual refresh** still works on an incremental MV (resync).
5. **Cost fallback** — bulk insert yields correct state (rebuild path; see gap above).
6. **Eligibility** — whole-table aggregate (`count(*)`) rejected at create; same body
   as `manual` is allowed.
7. **Set-op / recursive-CTE** bodies rejected with clear diagnostics.
8. **Schema-change invalidation** — drop a source → subscription detaches, MV reads
   error "stale".

### Suggested adversarial probes for the reviewer
- A row body with a `where` filter (`select id,x from t where x>0`) — a row leaving
  the filter via update should delete its MV row.
- A nullable group key with NULL rows.
- `order by` body — confirm rebuild fallback keeps results correct after a single-row
  update.
- Compound PK source; multi-column `group by`.
- Two incremental MVs over the same source (independent subscriptions).
