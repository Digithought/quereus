description: True incremental maintenance (not full rebuild) for `on-commit-incremental` materialized views over a recursive-CTE body — semi-naïve delta evaluation for monotone source inserts, DRed (delete-and-rederive) for source deletes/updates that can shrink the fixpoint. Research-grade.
prereq: materialized-view-incremental-recursive-cte
files: packages/quereus/src/runtime/emit/recursive-cte.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/nodes/recursive-cte-node.ts
----

## Context

`materialized-view-incremental-recursive-cte` (Phase 1) makes recursive
`on-commit-incremental` MV bodies *maintainable* — but by **full rebuild on every
source commit** (classified whole-MV `'global'` → `rebuildBacking`). That is
always correct but re-derives the entire fixpoint (transitive closure) on every
mutation, regardless of how small the change is. This ticket is the deferred
**algorithmically incremental** maintenance: touch only the part of the closure a
change actually affects.

This is genuinely research-grade and was split out so Phase 1 could ship a
correct, low-risk result without blocking on it.

## What "incremental" requires here

A recursive CTE evaluates a fixpoint over its sources. The MV backing table
already holds the current fixpoint. The goal: at COMMIT, given the changed source
tuples, mutate the backing table to the new fixpoint **without** recomputing it
from scratch.

- **Source inserts (monotone — the tractable case).** The fixpoint is monotone in
  the sources, so inserted base tuples can only *add* derived rows. The standard
  technique is **semi-naïve delta evaluation seeded from the inserted source
  tuples**: seed the working delta from the new base tuples joined against the
  *existing* materialized closure, iterate the recursive rule applying only the
  growing delta (deduping against what is already materialized), and upsert the
  newly derived rows. The engine already runs semi-naïve iteration for one-shot
  evaluation in `runtime/emit/recursive-cte.ts` (delta-only working table per
  iteration) — but it seeds from a *from-scratch* base case and an empty
  accumulator. Incremental maintenance needs a new evaluation mode that seeds the
  delta from `Δsource` and treats the **existing backing table** as the
  accumulator/dedup set.

- **Source deletes / updates (non-monotone — the hard case).** A deleted source
  tuple may invalidate derived rows, but only those with *no surviving alternative
  derivation*. The known technique is **DRed (Delete-and-Rederive)**:
    1. *Over-delete*: transitively delete every derived row reachable through the
       deleted tuples.
    2. *Re-derive*: for each over-deleted row, test whether it still has a
       derivation from surviving tuples; re-insert those that do.
    3. *Insert phase*: run the semi-naïve insert pass for any newly added tuples.
  Updates are modeled as delete-then-insert of the changed source tuple.
  The re-derivation step is the expensive/subtle part; provenance-counting
  variants do not terminate for recursive rules with cycles, so DRed (or a
  refinement like DRedₐ) is the baseline.

## Acceptance bar (inherited from the original plan ticket)

Correctness under source insert / update / delete, verified against a
full-rebuild oracle (a parallel `manual` MV over the same body), **including edge
cases that shrink the closure** (deletes that disconnect a subgraph, removal of
one of several alternative paths, self-loops, and cycles). Performance must beat
Phase 1's full rebuild for small deltas on a large closure; correctness must never
regress — fall back to `rebuildBacking` for any body shape the delta evaluator
does not cover.

## Open design questions (why this is research-grade)

- **Integrating with the per-binding `DeltaExecutor` model.** The kernel's
  per-binding `'row'`/`'group'` residual model assumes a *bounded* affected slice;
  a fixpoint has none. This likely needs a distinct subscription mode (a recursive
  MV's `apply` runs a delta-maintenance procedure seeded from `Δsource`, rather
  than per-binding `runResidual` or whole-`rebuildBacking`), not a new
  `BindingMode`.
- **Where the delta evaluator lives.** A new incremental entry point alongside
  `emitRecursiveCTE` that (a) seeds from changed source tuples, (b) reads the
  backing table as the existing accumulator, (c) emits backing-table
  insert/delete ops compatible with `applyMaintenance` + the cascade overlay.
- **Bodies that wrap the recursion.** The MV body is `select … from r [where …]`
  possibly with outer projection/filter/join/aggregate around the recursive CTE.
  The delta must be pushed through that outer shape (or the supported shape
  restricted, with rebuild fallback otherwise).
- **`union all` (bag) recursion.** Set semantics ("a materialized view must be a
  set") interacts badly with bag recursion and DRed counting; likely keep `union
  all` recursive bodies on the rebuild path.
- **Multiple / mutual recursion.** Scope to single linear recursion first
  (Quereus' `RecursiveCTENode` shape); reject/rebuild others.

## References

- `runtime/emit/recursive-cte.ts` — existing one-shot semi-naïve loop (delta
  working table, `allRowsTree` dedup) to generalize for incremental seeding.
- `core/database-materialized-views.ts` — `apply` / `rebuildBacking` /
  `applyMaintenanceAndCapture` / cascade overlay; where a recursive-delta mode
  would hook in.
- `docs/incremental-maintenance.md`, `docs/materialized-views.md` — kernel and MV
  maintenance contracts.
- Background: Gupta, Mumick & Subrahmanian, "Maintaining Views Incrementally"
  (DRed); standard semi-naïve / Datalog incremental-evaluation literature.
