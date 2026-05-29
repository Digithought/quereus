description: When an incremental materialized view diverges (Tier-2: its incremental apply failed AND the always-correct full rebuild also failed), its dependent MVs are still maintained against the diverged MV's stale backing data with no error. Only *direct* reads of the diverged MV error (via the `diverged` read-guard); a dependent that reads it transitively serves silently-drifted data. Decide whether/how to propagate divergence to downstream dependents.
files: packages/quereus/src/core/database-materialized-views.ts, docs/materialized-views.md
----

## Background

The cascading incremental-MV convergence work (`materialized-view-incremental-cascading-convergence`,
landed) makes an MV-over-MV chain converge within a single COMMIT: the manager
processes incremental MVs in dependency-topological order and feeds each
producer's backing-table write to its dependents via a per-pass delta overlay.

Maintenance failures are handled in two tiers (see the `apply` path in
`database-materialized-views.ts`):

- **Tier 1 — self-heal.** An incremental apply fails; the manager falls back to
  an always-correct full rebuild. The user's commit always stands.
- **Tier 2 — visible divergence.** Even the full rebuild fails. The MV is marked
  `diverged`, and subsequent *direct* reads error unconditionally (a `diverged`
  read-guard) rather than serving drifted data.

## The gap

Tier-2 divergence is **not propagated across a cascade edge**. When an upstream
MV diverges:

- Its backing table is left holding stale data (the last good materialization).
- Its dependents are still maintained that pass — against that stale backing —
  and do **not** error.
- A read of a *dependent* therefore returns data silently computed from the
  diverged upstream. Only a direct read of the diverged MV itself errors.

This is consistent with the implementation's current contract (`markBackingRebuilt`
records wholesale rebuilds; a Tier-2 divergence records nothing in the overlay,
so dependents simply see no delta for that base and read whatever the backing
holds), and it is documented as a known limitation in
`docs/materialized-views.md` § Limitations ("Caveat — cascading divergence").

It is a rare path (it requires even the always-correct rebuild to fail, which is
already a catastrophic/near-impossible condition), but the failure mode —
silently serving drifted data from a transitive read — is worse than the direct
divergence it descends from, which errors loudly.

## What to decide / specify

- **Should divergence propagate at all?** Options span: (a) leave as-is
  (documented limitation); (b) mark direct dependents `diverged` too, so reads of
  the whole downstream subtree error until a refresh; (c) a softer signal
  (e.g. a queryable health/staleness state) without hard-erroring dependents.
- If propagating: define the transitive closure (a diverged MV taints every MV
  whose body transitively reads its backing base — the topo graph already
  computed for ordering gives the edges) and when the taint clears (a successful
  refresh/rebuild of the upstream, then re-convergence of the chain).
- Consider interaction with the existing `diverged` vs `stale` distinction and
  the read-guard, and with partial-chain recovery (upstream recovers but a
  mid-chain MV is still diverged).

## Use case

A user builds a reporting MV `report` on top of a rollup MV `rollup` on top of a
base table. `rollup` hits Tier-2 divergence. Today, `select * from rollup` errors
(good) but `select * from report` quietly returns numbers computed from the last
good `rollup` snapshot (bad — the user has no signal the figures are stale).
