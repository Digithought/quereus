description: AsyncGatherNode — N independent (uncorrelated) child relations driven concurrently and combined by an explicit combinator (unionAll / crossProduct / zipByKey). Final operator in the parallel-* track; targets UNION ALL over remote sources and N-way full outer joins.
prereq: parallel-driver-context-fork, parallel-vtab-concurrency-mode, parallel-runtime-fork-test-harness
files: packages/quereus/src/planner/nodes/, packages/quereus/src/runtime/emit/, packages/quereus/src/planner/rules/, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/planner/optimizer-tuning.ts
----

## Goal

A physical operator `AsyncGatherNode(children[], combinator)` where children are uncorrelated relations (no bindings flow between them), driven concurrently. Three combinators:

- **`unionAll`** — interleave rows in arrival order. Callers requiring total order wrap the gather in `Sort`.
- **`crossProduct`** — full N-way Cartesian; useful only when every child fits in memory.
- **`zipByKey(keys)`** — full outer hash join across N inputs on shared key columns. Generalizes binary `FULL OUTER JOIN` to N-ary.

## Use cases

- **UNION ALL over remote sources.** Today `select * from remote_a union all select * from remote_b` scans `remote_a` to completion before starting `remote_b`. `AsyncGatherNode(unionAll)` overlaps them.
- **Cross product of small lookup tables.** Niche, but the combinator is essentially free once the gather exists.
- **N-way `FULL OUTER JOIN`.** Three-or-more-way outer joins on a shared key (e.g. `users FULL OUTER JOIN orders FULL OUTER JOIN reviews ON user_id`) are awkward as left-deep trees; `zipByKey` is the natural shape.

## Recognition rules

- **`unionAll`**: post-optimization rule over `UnionAll` whose children all advertise `expectedLatencyMs ≥ tuning.parallel.gatherThresholdMs` and `concurrencySafe`. Default threshold is high enough that local-only plans never trigger.
- **`crossProduct`**: opt-in only — no recognition rule in v1. Users / vtabs can construct it directly.
- **`zipByKey`**: track as a follow-up sub-ticket; needs a hash-merge implementation distinct from the binary-join paths. Don't scope it inside this ticket — capture and defer.

## Why this lands last

The simpler operators (`EagerPrefetchNode`, `FanOutLookupJoin`) cover the highest-payoff cases. `AsyncGatherNode` is the catch-all whose combinator API benefits from concrete patterns observed in the earlier nodes. Landing it after the others lets its design draw from real usage rather than speculation.

## Open questions for the plan agent

- **Output ordering for `unionAll`.** Arrival order is non-deterministic. The plan stage decides whether the operator promises any order at all, and whether to require an explicit `Sort` above when callers want one.
- **Backpressure across branches.** If branch A produces rows faster than the consumer pulls, branch B's slot may starve. Plan picks a per-branch buffering policy.
- **FD propagation.** `unionAll` keeps the intersection of child FDs (current `UnionAll` semantics); `crossProduct` takes the union; `zipByKey` is more involved (key columns determined; non-key columns conditionally null on outer-join misses).

## Out of scope

- `zipByKey` implementation — separate ticket once the combinator API is real.
- Sort-merge variant of `unionAll` for ordered inputs.
- Adaptive scheduler that weights branch pulls by observed latency.
