description: A Tier-2-diverged materialized view today hard-errors on direct read and requires a manual `refresh` to recover, while its dependents silently serve drifted data on transitive reads. Replace the hard-error contract with self-healing degradation: a diverged (or upstream-tainted) MV resolves reads to its live body (always correct, never silently wrong), propagates a taint to its transitive dependents so the whole chain degrades-and-heals as a unit, and repairs itself from multiple triggers (commit / read / refresh) with backoff — no DBA, no manual refresh required. Targets edge deployments where the dominant failure (a temporarily-unreachable federated source) is transient and must recover unattended.
prereq: materialized-view-state-flags-bypass-cached-plans
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/vtab/memory/layer/manager.ts, docs/materialized-views.md
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

- **Constraint enforcement is a *separate* self-healing path from read resolution —
  and the lens world has no fallback.** For a **physical** schema,
  `findIndexForConstraint` already refuses a `diverged`/`stale` covering structure
  and falls back to the synchronously-maintained auto-index (docs:705-734); taint
  joins that gate and the read-fallback does not apply to a UNIQUE check. But in the
  **logical-schema / lens world the row-time covering MV is the *sole* enforcement
  structure — the auto-index is retired** (docs:741). There a diverged/tainted
  covering MV leaves UNIQUE enforcement with nothing to fall through to, so "refuse
  + use the index" is not a self-healing answer. Because row-time enforcement is
  synchronous and in-transaction, the enforcement-path self-heal must be one of:
  (a) **synchronous repair-then-enforce** (rebuild the backing inside the writing
  statement, then resolve the conflict against it — row-time already writes the
  backing in-transaction, so this fits the existing path), or (b) a **live-body
  conflict check** (resolve the UNIQUE conflict by scanning the body instead of the
  backing — the enforcement analogue of read-fallback, correct but O(body) per
  check). This is **in scope** for this work and must be decided in implement; it is
  *not* covered by `covering-mv-enforcement-prefix-scan-and-preference` (preference /
  prefix scan) or `covering-mv-isolation-layer-enforcement-routing` (isolation
  routing) — both assume a *healthy* covering MV.
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
- **View-updateability composition (forward).** The read fallback is the view's
  `get` direction — ordinary body evaluation — so it does not touch
  [view updateability](../../docs/view-updateability.md) semantics. But it composes
  cleanly with the future write-through-DML path (a roadmap item in
  `docs/materialized-views.md` § Out of scope, slug `materialized-view-writes-through-body`;
  **no ticket filed yet**), which would route MV writes through view updateability:
  a diverged MV would then degrade to behaving exactly like its plain updateable
  view — reads recompute from the body, writes propagate to sources — and those
  source writes re-trigger the commit-time repair. No doc change to
  `view-updateability.md` is needed now; this is the lens-layer end state the
  enforcement-path decision above must stay consistent with.

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

## Sequencing & shared substrate (all MV tracks landing together)

Self-healing divergence, write-through DML, and the lens layer are all shipping in
this push, so the question is build *order*, not whether. They converge on one
substrate — **an MV is a view plus a materialization cache** — and if the capability
tracks fork before it exists, each re-derives the same two primitives.

**Build the substrate first, once:**

- **Reference resolution as a freshness/trust switch.** Trustworthy cache → backing
  table; untrustworthy (`diverged`/`tainted`) *or a lens `get`* → body. A
  first-class MV resolution mode in `select.ts`, **not** an `if (diverged)` patch.
  Consumed by self-healing reads *and* the lens `get` direction.
- **Cached-plan re-resolution on read-state toggle** (the
  `materialized-view-state-flags-bypass-cached-plans` prereq), generalized to
  "re-resolve onto the current mode" rather than hard-coded to "error."
- **MV updateability classification at create**, computed by the *existing*
  view-updateability lineage/FD analysis — one property per MV: `updateable`
  (covering-index / single-source projection-filter shape, ≈ view-updateability
  Phase 1) vs `read-only-derived` (aggregate / join / recursive / set-op). This one
  classification drives three consumers: the user-write boundary (write-through
  gating), the enforcement-path self-heal (only updateable covering MVs enforce),
  and which divergence self-heal applies.

**Then the capability tracks consume it:**

- **Self-healing divergence** — taint + repair scheduler + read fallback (via the
  switch) + enforcement self-heal (via the classification).
- **Write-through DML** — `updateable` MVs only. The covering shape overlaps
  view-updateability Phase 1, so write-through for it is **not** gated on Phase 2+
  (correction: Phase 2+ bodies are precisely the `read-only-derived` ones that never
  get write-through). Aggregate MVs are permanently read-only — write-through is
  structurally impossible for them, which is exactly why read-side live-body
  fallback (not write-through) is the divergence story for the motivating
  `report`-over-`rollup` case.
- **Lens layer** — `get` via the switch, `put` via write-through, enforcement via
  the classification + self-heal.

**Co-design coupling.** The enforcement-path self-heal (synchronous-repair vs
live-body conflict check) and write-through `put` meet in the lens world: a write to
a logical table is `put` + UNIQUE enforcement against a possibly-diverged covering MV
in the *same statement*. Sequence and design those two together, after the
substrate — not in separate passes.

> **No write-through ticket exists yet.** Write-through DML is only a roadmap slug
> (`materialized-view-writes-through-body`) in `docs/materialized-views.md`. If it is
> part of this push it needs a real ticket, sequenced after the substrate above and
> co-designed with the enforcement self-heal.

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
  structures (physical schemas keep the auto-index fallback).
- **Decide the enforcement-path self-heal for the lens world** (no auto-index
  fallback): synchronous repair-then-enforce vs. live-body conflict check. Pick one,
  implement it on the row-time enforcement path, and update
  `docs/materialized-views.md` § Enforcement accordingly.
- Rewrite `docs/materialized-views.md` § Apply-failure recovery and § Limitations
  (cascading caveat) to the self-healing reality; drop the "out of scope" / manual-
  refresh framing.
- Coordinate with `materialized-view-state-flags-bypass-cached-plans` so the
  invalidation it adds routes diverged/tainted reads to the fallback for cached
  plans.
