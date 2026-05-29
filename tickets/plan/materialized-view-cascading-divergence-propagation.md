description: A Tier-2-diverged materialized view today hard-errors on direct read and requires a manual `refresh` to recover, while its dependents silently serve drifted data on transitive reads. Replace the hard-error contract with self-healing degradation: a diverged (or upstream-tainted) MV resolves reads to its live body (always correct, never silently wrong), propagates a taint to its transitive dependents so the whole chain degrades-and-heals as a unit, and repairs itself from multiple triggers (commit / read / refresh) with backoff — no DBA, no manual refresh required. Targets edge deployments where the dominant failure (a temporarily-unreachable federated source) is transient and must recover unattended.
prereq: materialized-view-state-flags-bypass-cached-plans
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, docs/materialized-views.md
----

## Background

The cascading incremental-MV convergence work (`materialized-view-incremental-cascading-convergence`,
landed) makes an MV-over-MV chain converge within a single COMMIT: the manager
processes incremental MVs in dependency-topological order and feeds each
producer's backing-table write to its dependents via a per-pass delta overlay.

Maintenance failures are handled in two tiers (the `apply` path in
`database-materialized-views.ts`, ~lines 724-808):

- **Tier 1 — self-heal.** An incremental apply fails; the manager falls back to
  an always-correct full `rebuildBacking` (a *different* code path from the
  per-binding residual that failed). The user's commit always stands.
- **Tier 2 — visible divergence.** Even the full rebuild fails. `mv.diverged` is
  set; subsequent *direct* reads error unconditionally (the guard in
  `select.ts` ~line 452) rather than serving drifted data.

## The two problems

1. **Hard-error + manual recovery is the wrong contract for the edge.** Tier-2
   today demands a human run `refresh materialized view` (the diagnostic literally
   says so). At an edge deployment there is no DBA. The dominant Tier-2 cause
   there is a **transient** one — a federated/remote vtab source temporarily
   unreachable (Quereus is federation-first; architecture.md §Key Design
   Decisions) — which *will* succeed on a later attempt. The system must recover
   unattended.

2. **Cascading divergence is silent.** A Tier-2 divergence records nothing in the
   per-pass overlay, so a dependent sees no delta for that base and keeps reading
   its own backing — which was maintained against the upstream's *stale* backing.
   Only a *direct* read of the diverged MV errors; a transitive read of a
   dependent returns silently-drifted numbers. (Documented today as
   `docs/materialized-views.md` § Limitations "Caveat — cascading divergence".)

Use case: `report` (MV) over `rollup` (MV) over a base table. `rollup` hits
Tier-2. Today `select * from rollup` errors (and stays errored until a human
refreshes), while `select * from report` quietly returns figures computed from
the last good `rollup` snapshot.

## Decision

Replace "diverged → hard error on read, manual refresh to clear" with
**self-healing degradation**. Three pillars:

### 1. Reads degrade to the live body — never error silently, never get stuck

`diverged` means the *backing data* is wrong, but **the body still plans**
(docs:196-197 — divergence is data drift, not structural breakage; that is what
`stale` is). So a read of a diverged MV resolves to **live evaluation of the MV
body** (the un-materialized view definition) instead of the stale backing table.
Consequences:

- The read is **always correct** (it recomputes from current sources) and
  **never silently wrong**.
- The read **never permanently fails**: if the live body itself can't execute
  (e.g. the remote source is *still* down), it throws an ordinary transient
  runtime error — the same error a direct read of that source would throw — which
  is itself self-healing once the source returns. No "diverged forever, call a
  DBA" terminal state.
- It is **slower** while degraded (full body re-eval per read, no materialization
  benefit) — an explicit availability-over-latency trade (see Trade-offs).

This subsumes the old hard-error: there is no longer a code path that refuses the
read. `stale` (structural breakage — a source column/table genuinely gone) is
*unchanged*: its body may fail to re-plan, which is a real error, and it keeps its
existing re-validation path.

### 2. Taint propagates so the whole chain degrades and heals as a unit

When an MV diverges, mark its **transitive dependents** tainted (the topo graph
in `computeTopoRanks` already has the producer→consumer edges). A tainted MV
routes its reads to the live body too. Because a tainted dependent's live body
reads the upstream MV — which, being diverged, *also* routes to its own live body
— correctness flows transitively down the chain with no special cascade logic:
the entire subtree evaluates live and is correct end-to-end.

Taint must be tracked as a **set of culprit upstream MV keys**, not a bool, so
**partial-chain recovery** is correct: a dependent clears only when *every*
upstream that tainted it has recovered. (A mid-chain MV still diverged keeps its
descendants tainted.)

### 3. Repair self-triggers from multiple angles, with backoff

A full `rebuildBacking` repair is attempted, out-of-transaction (manager-level,
like Tier-1 today — `replaceBaseLayer` is layer-swap-safe under concurrent
`reentrant-reads` scans), triggered by **any** of:

- the **existing commit-retry** — once `diverged`, the next commit touching a
  source short-circuits the delta and runs a full rebuild (already implemented,
  ~lines 731-737);
- **read-triggered** — a read that routes to the live-body fallback *schedules*
  an out-of-band repair (fire-and-forget; the read itself stays read-only). This
  is the new lever that heals a sporadically-written, read-mostly edge DB whose
  source has come back, without waiting for a write;
- explicit `refresh materialized view` (already clears it).

On success: clear `diverged`/taint for that MV and recompute dependents' taint in
topo order. **Backoff** dedupes in-flight repairs and widens the interval after
repeated *identical* failures (deterministic case — e.g. a body that became a bag)
so reads don't trigger a doomed full rebuild on every scan — but never permanently
gives up (at the edge a "deterministic" failure like an unreachable source can
become healable).

## Scope guards / interactions

- **Live-body fallback is for read resolution only, not constraint enforcement.**
  `findIndexForConstraint` already refuses a `diverged`/`stale` covering structure
  and falls back to the synchronously-maintained auto-index (docs:704-710). Keep
  that — a UNIQUE check must not run a live re-eval. Taint joins `diverged`/`stale`
  in that gate.
- **Bag / deterministic divergence** (`materialized-view-incremental-bag-silent-dedup`):
  a body that becomes a bag fails the rebuild *deterministically*, so it would sit
  in perpetual live-body fallback (correct rows, but a bag, never re-materializing)
  and trigger a doomed rebuild on every read until backoff widens. This reinforces
  that ticket's preferred resolution (reject the bag-capable body at
  registration) — better to refuse at create than to enter a permanent degraded
  state. Cross-referenced there.
- **Cached prepared statements** (`materialized-view-state-flags-bypass-cached-plans`,
  prereq): the fallback decision is made at plan-build time in `select.ts`, so a
  statement planned while healthy keeps a cached backing-table reference and won't
  fall back when the MV later diverges. Self-healing reads for cached statements
  therefore *depend on* that ticket's invalidation (recompile → re-hit the build
  guard → fall back). That ticket's required action changes from "error" to
  "route to live body"; the new `tainted` flag needs the same invalidation.
- **Change-scope / `Database.watch`** is unaffected: the MV's cached `sourceScope`
  already projects reads to its sources, consistent with live-body evaluation.
- **Optimizer properties**: expanding to the body means the optimizer sees the
  *body's* `RelationType` (keys / isSet / ordering) rather than the backing
  table's — correct by construction; no rule special-casing needed.

## Plumbing sketch

**Schema flags** (`schema/view.ts`, `MaterializedViewSchema`): keep `diverged`
(self-originated). Add `tainted?: ReadonlySet<string>` — the set of upstream MV
keys (`schema.name`, lowercase) currently bad; non-empty ⇒ route reads to live
body. Both are runtime-only / not persisted (same as `diverged` today). Repair
backoff bookkeeping (attempt count, last-failure signature) lives on the
**manager**, not the schema.

**Taint propagation** (`database-materialized-views.ts`): factor a
`transitiveDependents(mvKey): string[]` helper out of the `consumersOf`/Kahn graph
already built in `computeTopoRanks` (~lines 986-1032). In the `apply` catch where
`mv.diverged = true` is set (~line 804), add each transitive dependent's MV key to
that dependent's `tainted` set. On a successful repair/refresh/Tier-1 recovery of
an MV, remove its key from every dependent's `tainted` set (and clear its own
`diverged`); recompute in topo order so a still-bad mid-chain node keeps its
descendants tainted.

**Read resolution** (`planner/building/select.ts`, the `else if (mvSchema)` branch
~line 442): replace the `if (mvSchema.diverged) throw` with: if
`mvSchema.diverged || (mvSchema.tainted?.size ?? 0) > 0`, build the read from the
**body** (`mvSchema.selectAst`) via the same view-body-expansion machinery the
regular-view branch just above already uses (it builds `viewSelectNode` from the
view's select), instead of `buildTableReference(backingFrom, ...)`. Then `void`
a call to the manager's repair scheduler. Leave the `stale` re-validation path
intact for structural breakage.

**Repair scheduler** (`database-materialized-views.ts`): a
`scheduleRepair(mvKey)` that dedupes an in-flight repair per MV, applies backoff
keyed on a failure signature, runs `recoveryRebuild` out-of-transaction, and on
success runs the taint-clear above. Reused by the read trigger; the commit-retry
path can route through it too for one backoff policy.

**Observability** (new requirement — degraded reads no longer error, so the state
must be *findable*): expose each MV's data-health (`ok` / `diverged` / `tainted`
+ culprits + last repair attempt) through an introspection surface (a pragma or
system view alongside existing MV metadata). Exact surface to be chosen in
implement; it is a hard requirement, not optional — "self-healing but silent"
still needs telemetry.

## Trade-offs (accepted)

- **Availability over latency.** A degraded MV silently becomes a full-body
  re-eval per read. For the edge / no-DBA goal this is the correct default;
  observability (above) makes the degradation visible.
- **No hard-error wall.** We give up the loud, immediate "this MV is wrong" stop
  in exchange for correct-but-slow reads. Net correctness is *better* (transitive
  reads stop being silently wrong); the cost is that a chronically-degraded MV is
  only visible via the health surface, not via a thrown error.

## Key tests (TDD targets for the implement phase)

- **Transient self-heal, no human.** Force Tier-2 via the
  `_setMaterializedViewMaintenanceFault` seam on `'rebuild'`; assert a read returns
  **correct** rows (live body) rather than throwing. Clear the fault; assert a
  subsequent read-triggered (or next-commit) repair re-materializes and the MV
  leaves the degraded state — with **no** explicit `refresh`.
- **Cascade correctness.** `report` over `rollup` over base; diverge `rollup`;
  assert `select * from report` returns correct (live-computed) figures, not the
  pre-divergence snapshot, and that `rollup` is in the `tainted`/`diverged` health
  surface for `report`.
- **Partial-chain recovery.** Three-level chain; diverge the middle; recover the
  top; assert the bottom stays degraded until the middle recovers, then clears.
- **Deterministic failure is bounded.** A body that fails rebuild deterministically
  serves live-body reads without re-attempting a full rebuild on *every* read
  (assert repair attempts are throttled by backoff), and never wedges.
- **Constraint enforcement untouched.** A `row-time` covering MV that is
  diverged/tainted still routes UNIQUE enforcement to the auto-index, not a live
  re-eval.
- **Cached-statement fallback** (with the prereq landed): a statement prepared
  while healthy, then read after divergence, falls back to the live body (not the
  stale backing).

## TODO (implement phase)

- Add `tainted` to `MaterializedViewSchema`; document it beside `diverged`/`stale`.
- Extract `transitiveDependents` from the `computeTopoRanks` graph; wire taint set
  on divergence and taint-clear on recovery (topo-ordered, set-based for partial
  recovery).
- Switch the `select.ts` MV branch from hard-error to body-expansion fallback for
  `diverged || tainted`; keep `stale` re-validation.
- Add the manager repair scheduler (dedupe + backoff + out-of-transaction rebuild
  + taint-clear) and the read-trigger call site.
- Add the MV data-health introspection surface.
- Update `findIndexForConstraint`'s gate to also refuse `tainted` covering
  structures.
- Rewrite `docs/materialized-views.md` § Apply-failure recovery and § Limitations
  (cascading caveat) to the self-healing reality; drop the "out of scope" / manual-
  refresh framing.
- Coordinate with `materialized-view-state-flags-bypass-cached-plans` so the
  invalidation it adds routes diverged/tainted reads to the fallback for cached
  plans.
