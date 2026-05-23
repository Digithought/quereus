description: Post-optimization rule that automatically wraps the probe (streamed) side of physical hash joins in `EagerPrefetchNode`, so the build phase's first round-trip overlaps with the probe scan's first round-trip. Separated from the EagerPrefetchNode landing ticket so the node can ship and be exercised manually before we tune recognition heuristics.
prereq: parallel-eager-prefetch-node
files: packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/framework/characteristics.ts
----

## Goal

Recognize hash joins where eagerly iterating the probe side would hide build-phase latency, and wrap the probe input in `EagerPrefetchNode`.

## Target

`BloomJoinNode` (physical, `PlanNodeType.HashJoin`). Per `packages/quereus/src/planner/nodes/bloom-join-node.ts`'s own comments, **`left` is the probe (streamed) side** and `right` is the build side — opposite of textbook convention. The wrap targets `left`. The original plan-stage ticket said "right (probe)"; that text is incorrect for this codebase.

## Recognition

Two candidate gates, in increasing aggressiveness:

1. **Tight, latency-driven.** Wrap `left` iff the build (`right`) side's leaf access is a remote vtab — i.e., `right` is a `RemoteQuery` subtree, or transitively grounds out in a `TableReference` whose vtab module advertises remote / high-latency characteristics. This is the use case the parent ticket describes verbatim.
2. **Broad, cost-driven.** Wrap `left` iff `right.estimatedRows × per-row-build-cost` exceeds a tuning threshold, regardless of remoteness. Catches any case where the build is the latency-dominant sibling.

Default to **(1)** for the initial rule — it's the lowest false-positive shape. (2) is a follow-on knob.

In both cases, **skip if `left` is already a `CacheNode`, `EagerPrefetchNode`, or otherwise pre-materialized**: redundant or harmful. The `isCached`/`CacheCapable` capability detector exists for this — extend it if `EagerPrefetchNode` needs a parallel `isPrefetched` marker (probably not — checking `nodeType === EagerPrefetch` is enough).

## Rule mechanics

- Phase: `PostOptimization`, after physical-selection and after access-path rules (`PassId.PostOptimization`, priority somewhere after `asof-strategy-select` at priority 11 and before `cte-optimization` at priority 20 — probably 15).
- Node type: `PlanNodeType.HashJoin`.
- Rewrite: produce a new `BloomJoinNode` with `left` replaced by `new EagerPrefetchNode(scope, left, defaultBufferSize)`.
- Buffer size: pull from `context.tuning` (add a `parallel.defaultPrefetchBuffer` tuning knob, default 64).

## Open questions

- **Detecting "remote vtab".** The cleanest signal is a characteristic on the vtab module, not a string sniff on `RemoteQuery`. Check `framework/characteristics.ts` for whether a `RemoteCapable` / `expectedLatencyMs` marker already exists; if not, this rule motivates adding one. Until that lands, a conservative fallback: check whether the build subtree contains a `RemoteQuery` node.
- **Asof / merge / nested-loop joins.** Out of scope here. Asof has its own strategy-select rule; merge joins benefit differently (both sides should overlap their first reads, which is a different operator shape — likely a binary "both sides prefetch" node, not two unary wraps).
- **Interaction with materialization-advisory.** That rule wraps in `CacheNode` for re-use scenarios. The prefetch rule should run **before** materialization advisory inspects the join, so the advisory sees the prefetch-wrapped tree and skips it. Verify ordering.

## Tests

- A hash join over a stub "slow first row" build source: assert the rule fires, the resulting plan contains `EagerPrefetch` over `left`, and end-to-end execution returns the same rows the unwrapped plan does.
- Idempotence: running the rule twice produces no double-wrap (`left` is already `EagerPrefetch`).
- Skip when `left` is already `CacheNode`.
- Skip when `right` is purely local (in-memory vtab — assert no `EagerPrefetch` in the resulting plan).
- A SQLLogic test that demonstrates the latency win is **not** appropriate here — sqllogic is for correctness; wall-clock benchmarks belong elsewhere.

## Out of scope

- The broader option-3 heuristic ("wrap any subtree whose expected first-row latency exceeds a tuning threshold"). Defer until the optimizer has an `expectedLatencyMs` characteristic.
- Wrapping the build side. The build is consumed once linearly to completion before the probe touches it; prefetching it is exactly what the join already does — there's no overlap to gain on that side alone.
