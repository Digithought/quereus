description: Give a failed incremental MV apply a visible signal so reads cannot silently return diverged data. Self-heal via a full rebuild in the apply catch; if that also fails, set a new `diverged` flag that errors reads until a successful refresh/rebuild. User's commit always stands (no rollback).
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/runtime/emit/materialized-view.ts, docs/materialized-views.md, packages/quereus/test/materialized-view-diagnostics.spec.ts
----

## Problem

`MaterializedViewManager.buildSubscription().apply` (`database-materialized-views.ts:367-405`)
wraps the whole maintenance batch in a `try/catch` that `warnLog`s and returns.
Ops are collected across **all** binding tuples and handed to
`applyMaintenance` only once at the end of the loop, so a throw from
`runResidual` mid-collection means **none** of this commit's delta is applied.
The MV is left at its pre-commit contents — it has silently *skipped* this
commit's delta. Nothing re-applies the missed delta (the next commit maintains
only the *next* delta's bindings), so the MV diverges from its source
**permanently** until a manual `refresh`, and reads in the interim return wrong
data with **no error and no flag**.

## Key finding — `stale` does not solve this

The ticket floated "mark the MV `stale` so the next reference errors." **It
doesn't.** The `stale` path is a *schema-compatibility* gate, not a *freshness*
gate:

- The read path (`select.ts:442-464`, the `else if (mvSchema)` branch) only
  re-validates the **body against current source schemas** when `stale` is set
  (it re-runs `buildSelectStmt`/`buildValuesStmt`). If the body still plans —
  which it always does after a *data* maintenance failure, since the source
  *schema* is unchanged — it resolves to the backing table **silently** and
  returns the diverged rows. See the existing test "a stale, still-valid MV
  reference also resolves to the backing table" (`test/plan/materialized-view-plan.spec.ts:33`).
- `revalidateBody` (`materialized-view-helpers.ts:296`) and
  `emitRefreshMaterializedView` (`materialized-view.ts:115`) behave the same.
- The docs are explicit: "Staleness tracks *structural* breakage, not data
  drift" (`docs/materialized-views.md:182`).

So a data-divergence signal must be a **separate** notion with **unconditional**
read-time error semantics, not a reuse of `stale`.

## Design — two-tier recovery + a `diverged` flag

Keep the invariant "the user's commit always stands" (no rollback). On apply
failure, escalate in two tiers:

**Tier 1 — self-heal (the common case).** In the `apply` catch, after logging,
attempt a full `rebuildBacking(db, mv)`. A full rebuild runs `collectBodyRows`
(the whole body, no injected key filter) — a **different code path** from the
per-binding `runResidual`/`applyMaintenance` that just failed — so a
residual-specific or transient failure is very often recovered with zero user
friction and correct data. `rebuildBacking` is already the always-correct path
the `globalRelations` / no-clean-delete-mapping branches use.

**Tier 2 — visible divergence (the worst case).** If the recovery `rebuildBacking`
*also* throws, the MV genuinely cannot be re-materialized. Set a new
`MaterializedViewSchema.diverged = true`. Reads check this flag **unconditionally**
(independent of the `stale` body re-validation) and error with a divergence
diagnostic. This guarantees no silent wrong reads in the persistent-failure case,
while the disruption is justified (the body can't even be evaluated).

**Recovery / clearing.** `diverged` is cleared **only** by a full
re-materialization — never by a later incremental apply (a subsequent apply
maintains only the *new* delta and would not fix the old gap). Clearing paths:

- a successful Tier-1 recovery rebuild (never sets `diverged` in the first place);
- a successful `refresh materialized view` (clear alongside `mv.stale = false`
  in `emitRefreshMaterializedView`, `materialized-view.ts`);
- **self-heal retry:** when `diverged` is already set, the `apply` path
  short-circuits to a full `rebuildBacking` (ignoring the incremental delta) on
  the next commit that touches a source; success clears `diverged`. A
  deterministic failure that later becomes transient thus heals automatically.

### Consolidated apply control flow

```
apply(input):
  try:
    if mv.diverged:
      await rebuildBacking(db, mv)      // self-heal retry; ignore incremental delta
      mv.diverged = false
      return
    ... existing incremental path (delete-key + runResidual + applyMaintenance;
        globalRelations / no-clean-mapping branches call rebuildBacking) ...
  catch err:
    warnLog('Incremental maintenance for %s.%s failed; attempting full rebuild (commit stands): %O', ...)
    try:
      await rebuildBacking(db, mv)      // Tier 1 recovery
      if (mv.diverged) { mv.diverged = false; log('... recovered via full rebuild') }
    catch err2:
      mv.diverged = true               // Tier 2 visible signal
      warnLog('... could not self-heal; marked diverged (refresh required): %O', err2)
```

Note: if the failure originated *inside* one of the incremental path's own
`rebuildBacking` branches, the catch will attempt `rebuildBacking` once more
(one redundant, idempotent attempt before marking `diverged`). Acceptable — keep
the control flow simple rather than threading a "was-rebuild" flag.

### Read-time error

In `select.ts`, in the `else if (mvSchema)` branch (~line 442), **before** the
`mvSchema.stale` block, add:

```ts
if (mvSchema.diverged) {
  throw new QuereusError(
    `materialized view '${fromClause.table.name}' diverged from its sources `
      + `(incremental maintenance failed and could not self-heal); `
      + `run \`refresh materialized view ${fromClause.table.name}\``,
    StatusCode.ERROR,
  );
}
```

(No body re-validation — the body is fine; the *data* is wrong.)

### Schema field

Add to `MaterializedViewSchema` (`schema/view.ts`), near `stale`:

```ts
/** Set when an incremental apply failed AND the always-correct full-rebuild
 *  recovery also failed — the backing table cannot be re-materialized and its
 *  contents have silently diverged from the sources. Reads error unconditionally
 *  until a successful refresh / rebuild clears it (distinct from `stale`, which
 *  tracks *structural* body breakage, not data drift). Not serialized;
 *  recomputed at runtime. */
diverged?: boolean;
```

### Fault-injection seam (lands with this work)

Forcing a deterministic apply error is awkward today; add a narrow test-only
seam:

- On `MaterializedViewManager`, an optional settable hook
  `maintenanceFaultInjector?: (phase: 'residual' | 'apply' | 'rebuild') => void`,
  invoked (when set) at the top of `runResidual` (`'residual'`), immediately
  before `applyMaintenance` (`'apply'`), and at the top of the Tier-1 recovery
  `rebuildBacking` wrapper (`'rebuild'`). Throwing from the hook simulates the
  corresponding failure.
- Expose it for tests via a thin internal `Database` setter
  (`materializedViewManager` is `private readonly`, `database.ts:109`), mirroring
  existing internal accessors — e.g. `_setMaterializedViewMaintenanceFault(fn)`
  delegating to the manager. Keep it `@internal`; production never sets it.

This lets a test throw on `'residual'` only (Tier 1 self-heals → no `diverged`,
correct data) versus on both `'residual'` and `'rebuild'` (Tier 2 → `diverged`
→ read errors).

## Tests (TDD — `test/materialized-view-diagnostics.spec.ts`, `new Database()` style)

- **Tier-1 self-heal:** row-preserving `on-commit-incremental` MV; inject a throw
  on `'residual'` only; commit a source change. After post-commit the MV reflects
  the change (rebuild healed it), `diverged` is false, `select * from mv` succeeds
  and is correct.
- **Tier-2 visible divergence:** inject throws on both `'residual'` and
  `'rebuild'`; commit a source change. `diverged` is true; `select * from mv`
  errors with a message containing the MV name + "diverged" + "refresh
  materialized view". The source table still reflects the user's write (commit
  stood).
- **Self-heal retry clears diverged:** from a diverged state, clear the fault,
  commit another source change; the apply's diverged-retry rebuild succeeds,
  `diverged` clears, reads succeed and are correct (reflect *both* deltas).
- **Refresh clears diverged:** from a diverged state (fault cleared),
  `refresh materialized view mv` succeeds and clears `diverged`; reads succeed.
- **Commit always stands:** assert across all failure cases that the source row
  the user wrote is present (no rollback).

## Docs

Update `docs/materialized-views.md` § Incremental refresh (the "A failed apply
**logs and skips**" paragraph, ~line 193) to describe the two-tier recovery and
the `diverged` read-error contract, and note in § Schema-change staleness that
`diverged` is a distinct data-drift signal (vs `stale` = structural breakage).

## Notes

- This is a deliberate policy refinement over the implementing ticket's
  documented log-and-skip, chosen because (a) it preserves "commit stands",
  (b) the self-heal tier makes the common (transient / residual-specific) failure
  invisible to the user with correct data, and (c) the `diverged` tier guarantees
  the no-silent-wrong-reads invariant in the persistent-failure case — the only
  option that actually makes reads surface a data divergence (see Key finding).
- Tradeoff / alternative considered: a pure embedder-observable counter/diagnostic
  channel (no read error). Rejected as the *sole* mechanism because a naive reader
  still gets wrong data; the `diverged` flag itself is the observable. If an
  embedder-facing enumerator is wanted, a `getDivergedMaterializedViews()` on the
  manager/schema is a cheap optional add — left out of the core to keep scope tight.

## TODO

- [ ] Add `diverged?: boolean` to `MaterializedViewSchema` (`schema/view.ts`).
- [ ] Implement the two-tier recovery in `apply` and the `diverged` self-heal
      retry short-circuit (`database-materialized-views.ts`).
- [ ] Add the unconditional `diverged` read-time error in `select.ts` (before the
      `stale` block).
- [ ] Clear `diverged` on successful `refresh` (`emitRefreshMaterializedView`,
      `runtime/emit/materialized-view.ts`).
- [ ] Add the `maintenanceFaultInjector` seam on the manager + internal `Database`
      setter.
- [ ] Add the five focused tests in `materialized-view-diagnostics.spec.ts`.
- [ ] Update `docs/materialized-views.md` (§ Incremental refresh, § Schema-change
      staleness).
- [ ] `yarn workspace @quereus/quereus run build`, `yarn workspace @quereus/quereus test`,
      and lint (single-quoted globs on Windows) all green.
