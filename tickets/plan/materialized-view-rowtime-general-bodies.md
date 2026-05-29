description: Extend row-time (write-through) materialized-view maintenance beyond the covering-index shape to general incrementally-maintainable bodies (single-source aggregates, inner/cross-join row-preserving bodies, lateral-TVF fan-out) — maintaining their backing tables synchronously with source writes rather than at COMMIT. The first row-time delivery (`materialized-view-rowtime-write-through`) deliberately restricts `row-time` to the covering-index shape, where per-row maintenance is a bounded O(log n) pure projection of the changed row.
prereq: materialized-view-rowtime-write-through
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/emit/dml-executor.ts, docs/materialized-views.md
----

## Problem / future concern

`materialized-view-rowtime-write-through` delivers the `row-time` refresh policy
only for the **covering-index shape** (single-source, linear `Filter → Project →
Sort` projecting the source PK), because that shape lets per-source-row
maintenance be a pure projection of the changed row — O(log n), no body
re-execution. The other shapes that `on-commit-incremental` already maintains at
COMMIT are *not* yet eligible for `row-time`:

- **single-source aggregate** with `GROUP BY` over bare columns — per-row
  maintenance must recompute the changed group(s), which means running the
  group's residual mid-statement;
- **row-preserving inner/cross-join** bodies — per-row maintenance recomputes the
  affected MV slice via the residual scheduler (join fan-in);
- **lateral-TVF fan-out** — `delete-by-prefix` + recomputed fan-out per changed
  base row.

These already have per-binding residual machinery (`runResidual`,
`computeDeleteKeyOrder`, `prefixDelete`) in `database-materialized-views.ts`; the
open question is whether running that residual **synchronously per source row**
(rather than once per binding at COMMIT) is affordable and worth it, and how the
cost-fallback-to-rebuild interacts with a mid-statement write boundary.

## Use case

A logical-schema (lens) `unique`/PK whose declared covering MV is *not* the
simple covering-index shape — e.g. a uniqueness claim that is only provable
through an aggregate or join body — would need row-time maintenance of that body
to drive row-time conflict resolution. Until then such a constraint falls back to
the commit-time `DeltaExecutor` scan (detection-only; `insert or replace` / `or
ignore` unavailable), as `docs/lens.md` already documents under the
`lens.no-backing-index` advisory path.

## Out of scope (belongs to the prereq, already delivered there)

- The `row-time` policy, parser/round-trip, the synchronous DML-boundary hook, the
  privileged transactional maintenance write, and the covering-index shape.
