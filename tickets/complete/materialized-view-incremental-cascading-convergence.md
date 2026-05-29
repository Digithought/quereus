description: Cascading incremental materialized views (an `on-commit-incremental` MV whose body reads another incremental MV's backing table) now converge within a single COMMIT via a topologically-ordered post-commit maintenance pass plus a per-pass delta overlay layered on the change log. Reviewed and completed.
files: packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, packages/quereus/test/incremental/delta-executor.spec.ts, docs/materialized-views.md, docs/incremental-maintenance.md
----

## What was implemented

Cascading incremental MVs converge within a single COMMIT. Before this change a
depth-N chain lagged one commit per level; interim reads of a dependent returned
stale data with no error.

The manager processes incremental MVs in **dependency-topological order** within
the existing single post-commit maintenance pass, and makes each producer MV's
backing-table write visible to its dependents through a manager-owned **delta
overlay** layered on the `TransactionManager` change log.

- **Kernel seams** (`delta-executor.ts`, consumer-neutral / opt-in):
  `DeltaExecutorContext.isGloballyChanged?(base)` (flag a base for global
  re-eval when it was rebuilt wholesale), and `runAll(opts)` with `order?` and
  `rescanPerSubscription?`. Assertions and watchers still call `runAll()` with no
  args → zero behavior change.
- **MV manager** (`database-materialized-views.ts`): per-pass `pendingDelta`
  (backing base → captured per-row changes by serialized PK) and
  `globallyChangedBacking` (bases rebuilt wholesale), reset at the top of
  `runPostCommit`; an overlay-aware executor context; `applyMaintenanceAndCapture`
  (synthesizes insert/update/delete overlay deltas from before/after backing
  reads around the latched write); `markBackingRebuilt` (every full rebuild path);
  and a cached Kahn topological order over producer-backing → consumer edges.

See `docs/materialized-views.md` § Limitations and `docs/incremental-maintenance.md`
§ Cascading convergence for the design.

## Review findings

**Diff reviewed:** commit `2060e539` (the implement-stage commit), all 9 files,
read before the handoff summary. Validation re-run from scratch.

### Checked — correct

- **Overlay capture/projection.** Before/after read semantics are sound:
  `applyMaintenance` mutates the backing btree in place with immutable row
  objects, so the pre-write `lookupEffectiveRow` reference holds the old content
  and the post-write read sees the new row — no aliasing. `overlayChangedTuples`
  projects requested columns from captured full rows with the same
  insert→new / delete→old / update→old&new emission and PK-granular de-dup as the
  change log. The aggregate old/new-group projection (§15) is correct.
- **Mutation safety.** `TransactionManager.getChangedBaseTables()` builds a fresh
  `Set` each call, so the overlay's `out.add(...)` union does not corrupt
  transaction state. Verified at `database-transaction.ts:586`.
- **`pendingDelta` vs `globallyChangedBacking` exclusivity.** A single `apply`
  either captures per-binding deltas *or* marks a wholesale rebuild, never both.
  Even in the pathological "partial overlay then catch→rebuild" case, `runOne`
  checks `isGloballyChanged` *before* the per-tuple path, so the global flag wins
  — the stale partial overlay is never read.
- **Topological order.** Kahn over producer-backing → consumer edges; self-edges
  excluded; DAG argument sound (a body is fixed at create, upstream must
  pre-exist); cycle guard degrades loudly. Cached rank keyed by `subscriptionId`
  matches the live `DeltaSubscription.id`. Each manager owns its own
  `DeltaExecutor`, so MV ordering never touches assertion/watcher dispatch.
- **Cost-fallback on cascade hops.** Backing tables report `estimatedRows` 0/
  undefined, so the ratio fallback does not spuriously demote dependents to
  rebuild; behavior stays correct on either path (§16 covers both).
- **Docs.** `materialized-views.md` and `incremental-maintenance.md` both read as
  accurate against the code, including the cascading-divergence caveat and the
  DAG/no-fixpoint argument. The `database-transaction.ts` post-commit comment no
  longer documents the (removed) lag.
- **Lint / tsc / tests.** `yarn lint` clean, `tsc --noEmit` clean, full
  `packages/quereus` suite **3793 passing, 9 pending, 0 failing** — before and
  after the review edits below.

### Minor — fixed in this pass

- **Missing composite-PK cascade coverage.** The handoff flagged
  `pkToString`/`serializeTuple` composite-PK dedup and the composite
  `backingPkDefinition` capture path as only indirectly exercised. Added **§18**
  to `52-materialized-views-incremental.sqllogic`: a dependent over a multi-column
  `group by g1, g2` leaf MV, asserting a single-group source insert ripples
  through the composite-keyed overlay to the dependent in one commit. Passes.
- **Per-binding capture overhead on non-cascading MVs.** Every incremental MV was
  paying 2N backing point-reads per maintenance even with no dependent — a
  hot-path regression for the common single-MV case. Added a cached
  `getConsumedBackingBases()` (the producer side of cascade edges) and a guard in
  `applyMaintenanceAndCapture`: a backing base with no consumer skips the
  before/after reads and just writes (restoring zero capture overhead). The cache
  shares data and invalidation with the existing `topoRanks` cache (recomputed
  lazily after register/unregister), so it is no riskier than the ordering cache
  it mirrors — if it were stale, ordering would break first. Both the
  has-consumer path (§13–§18) and the no-consumer path (§1–§12) are test-covered;
  the `'apply'` fault-injection seam still fires on both branches.

### Minor — noted, not changed

- **`serializeTuple` (`database-materialized-views.ts`) duplicates `tupleKey`
  (`delta-executor.ts`).** Near-identical type-prefixed serialization with
  *different* join separators (`` vs `|`). Left as-is: both are
  module-private, serve different consumers (overlay map keys vs watch-value
  intersection), and are only ever compared against themselves — merging them
  would couple the runtime kernel to the core MV module for a 10-line helper. The
  handoff's claim that `serializeTuple` "uses a backtick join" is inaccurate; it
  uses ``.

### Major — filed as a new ticket

- **Cascading divergence is not propagated.** If an upstream MV hits Tier-2
  divergence (even its rebuild failed), its dependents are still maintained
  against the upstream's stale backing and do **not** error — only *direct* reads
  of the diverged MV error. A transitive read of a dependent silently serves
  drifted data. Rare (requires the always-correct rebuild to also fail) and
  documented, but the failure mode warrants a decision. Filed
  `tickets/backlog/materialized-view-cascading-divergence-propagation.md`.

### Not propagated to dependents but acceptable

- Single-source bodies only (v1) — multi-source/join bodies are rejected at
  create, so a cascade is a linear chain (forest), not a general DAG with
  diamonds. The topo machinery is already general and stays correct when join
  bodies land (`materialized-view-incremental-join-bodies`). No action.
- Convergence relies on `runAll` awaiting each `runOne` sequentially so a
  producer's writes are visible before a consumer runs. Guaranteed by topo order
  + sequential await; documented as a constraint for any future change that
  parallelizes `runAll`. No action.
