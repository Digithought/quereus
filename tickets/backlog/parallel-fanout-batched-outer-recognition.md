description: Cost-model recognition that decides when a `FanOutLookupJoinNode` should run in batched (pipelined cross-row) outer mode rather than serial. The batched *runtime* lands in `parallel-fanout-lookup-join-batched-outer`; this is the optimizer rule that picks it.
prereq: parallel-fanout-lookup-join-batched-outer
files: packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/planner/rules/join/, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts
----

## Context

Once the batched outer runtime exists, `FanOutLookupJoinNode.outerMode` defaults
to `'serial'` and nothing automatically selects `'batched'`. A node is only
worth running batched when there are **many outer rows but few branches per
row** — that is, when the per-row branch count under-saturates the global
in-flight budget and the branches are high-latency enough that cross-row overlap
pays for the reorder-buffer overhead.

## What this ticket should specify (not yet design)

- **When to flip a fan-out node to `outerMode: 'batched'`.** The expected cost
  signal is the existing `expectedLatencyMs` surface (per the serial fan-out and
  gather rules) **plus outer cardinality**: batched wins roughly when
  `branchCount < outerBatchConcurrency` (budget under-saturated per row) AND the
  slowest branch's `expectedLatencyMs` clears a threshold AND estimated outer
  rows are large enough that the per-row overlap dominates buffer overhead.
- **Where the rule sits.** Same `PassId.PostOptimization` neighborhood as
  `rule-fanout-lookup-join` / `rule-async-gather-union-all`
  (`optimizer.ts` ~priority 15–17), after physical-pass selection finalizes leaf
  `expectedLatencyMs`. Likely a post-pass over already-formed `FanOutLookupJoin`
  nodes rather than a new recognition path.
- **Tuning gate** in `tuning.parallel` (a `batchedOuterThresholdMs` /
  cardinality minimum), kept inert on memory-vtab plans (`expectedLatencyMs = 0`)
  so the golden-plan sweep is unaffected — same discipline as `gatherThresholdMs`
  / `prefetchProbeThresholdMs`.
- **Interaction with `EagerPrefetch` on the outer** — prefetching the outer feeds
  the batched pump; confirm the two compose (prefetch fills read-ahead, batched
  consumes across rows) and decide whether one implies the other.

## Notes

- Golden-plan impact: this rule *will* change physical plans on high-latency
  fixtures — budget test fixtures accordingly (mirror `parallel-fanout.spec.ts`).
- Defer the streaming-`cross` + batched-outer combined mode (the cross-mode
  ticket owns that); recognition here assumes `atMostOne-*` branches only until
  cross mode lands.
