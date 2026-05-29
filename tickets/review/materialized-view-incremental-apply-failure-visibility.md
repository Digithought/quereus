description: Review the two-tier incremental-MV apply-failure recovery (self-heal full rebuild → `diverged` read-error) and its fault-injection seam + tests.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, docs/materialized-views.md
----

## What was built

An incremental MV (`refresh = 'on-commit-incremental'`) previously **silently
skipped** a failed maintenance batch: the user's commit stood, but the backing
table was left diverged from its sources with **no error and no flag**, so reads
returned wrong data indefinitely until a manual `refresh`. This ticket adds a
visible signal with two-tier self-healing recovery, preserving "the user's commit
always stands" (no rollback).

### Control flow (`database-materialized-views.ts`, the `apply` closure)

```
apply(input):
  try:
    if mv.diverged:                       // self-heal retry on next source-touching commit
      recoveryRebuild(db, mv); mv.diverged = false; return   // ignore incremental delta
    if globalRelations: rebuildBacking; return
    ...per-binding delete-key + runResidual + applyMaintenance...   // ('apply' fault fires here)
  catch err:
    warnLog(...attempting full rebuild (commit stands)...)
    try:
      recoveryRebuild(db, mv)             // Tier 1 — self-heal (different code path)
      if mv.diverged: mv.diverged = false // (recovered)
    catch err2:
      mv.diverged = true                  // Tier 2 — visible divergence
```

- **Tier 1 self-heal** runs `rebuildBacking` (whole-body `collectBodyRows`) — a
  *different* path from the per-binding `runResidual`/`applyMaintenance` that
  failed — so residual-specific / transient failures recover invisibly with
  correct data.
- **Tier 2** sets the new `MaterializedViewSchema.diverged` flag (schema/view.ts),
  distinct from `stale`. Reads error **unconditionally** in `select.ts`
  (`else if (mvSchema)` branch, *before* the `stale` block, no body re-validation)
  with a message naming the MV + `refresh materialized view <name>`.
- **Clearing `diverged`:** only a full re-materialization clears it — a successful
  Tier-1 recovery (never sets it), a successful `refresh` (`emitRefreshMaterializedView`
  now clears `diverged` alongside `stale`), or the **self-heal retry** (a later
  commit that touches a source short-circuits the delta and full-rebuilds). A
  later *incremental* apply never clears it (it only maintains the new delta).

### Fault-injection seam

`MaterializedViewManager.maintenanceFaultInjector?: (phase: 'residual'|'apply'|'rebuild') => void`,
installed via `Database._setMaterializedViewMaintenanceFault(fn)` (both `@internal`,
never set in production). Fires at the top of `runResidual` (`'residual'`), just
before `applyMaintenance` (`'apply'`), and inside `recoveryRebuild` (`'rebuild'`).

## How to validate

- Build: `yarn workspace @quereus/quereus run build` — green.
- Tests: `yarn workspace @quereus/quereus test` — 3789 passing, 9 pending.
- Lint: `yarn workspace @quereus/quereus run lint` (single-quoted globs) — clean.
- Focused: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/materialized-view-diagnostics.spec.ts"`

### Test coverage (`test/materialized-view-diagnostics.spec.ts`, new describe block)

Uses a 4-row row-preserving MV + single-row `UPDATE` so the delta stays on the
per-binding path (ratio 0.25 < 0.5 fallback). Four tests:
1. **Tier-1 self-heal** — fault on `'residual'` only → MV reflects the change,
   `diverged` false, read succeeds.
2. **Tier-2 divergence** — fault on `'residual'`+`'rebuild'` → `diverged` true,
   read errors (`'diverged'` + `'refresh materialized view mv'`), **and the
   source still reflects the user's write (commit stood)**.
3. **Self-heal retry** — from diverged, clear fault, commit another change →
   diverged-retry rebuild clears the flag; reads reflect *both* deltas.
4. **Refresh clears diverged** — from diverged, `refresh` clears it; reads succeed.

## Known gaps / decisions for the reviewer (tests are a floor)

- **"Commit always stands" is asserted explicitly only in the Tier-2 test.** In
  the other three the final MV read reflects the source write, which proves the
  commit stood *and* propagated — but a reviewer may want an explicit source-row
  assertion in each. Tier-2 is the meaningful one (it's the only case where the MV
  read itself errors).
- **Deliberate deviation from the plan's pseudocode:** the diverged self-heal
  *retry* routes through the same `recoveryRebuild` wrapper as the Tier-1 catch
  recovery (so the `'rebuild'` fault affects both and the two rebuild attempts
  behave identically), whereas the ticket pseudocode showed a plain
  `rebuildBacking` in the retry. Behaviorally identical for the listed tests (the
  retry test clears the fault). If a reviewer prefers the literal pseudocode,
  inline `rebuildBacking` in the retry branch.
- **The `'apply'` fault phase is wired but not exercised by a dedicated test.**
  An `'apply'`-only fault would behave like Tier-1 self-heal (rebuild is a
  separate path). Worth a test if the reviewer wants the phase pinned.
- **Read-error coverage:** the `diverged` guard lives only in the single
  FROM-clause MV-resolution branch (`select.ts:442`), which covers all supported
  reads (subqueries/joins/CTEs route through it). A user reaching directly into
  the hidden `sqlite_mv_<name>` backing table would bypass it — not a supported
  read path, but noted.
- **No embedder-facing enumerator** (`getDivergedMaterializedViews()`) was added —
  intentionally out of scope per the plan's tradeoff note; the read error *is* the
  observable. Cheap to add later if wanted.
- **Idempotent double-rebuild:** if the incremental path's own `rebuildBacking`
  branch (globalRelations / no-clean-mapping) throws, the catch attempts
  `rebuildBacking` once more before marking diverged. Accepted per the plan (keeps
  control flow simple); confirm it's acceptable.
