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

## Outer-source / shared-context interaction (must verify before shipping batched)

The batched runtime (`runFanOutLookupJoinBatched`) pumps the outer source
*concurrently* with in-flight row forks. Unlike serial mode — which fully
resolves one outer row before pulling the next — the pump calls
`outerIter.next()` while previous rows' branch forks are still live. Two
consequences the recognition rule's integration tests **must** exercise (the
batched-runtime ticket only tested array-backed outer sources that never touch
`rctx`):

- **Shared `rctx.context`.** The scheduler runs every instruction against one
  shared `RuntimeContext` (`scheduler.ts`), so the outer sub-plan mutates the
  *same* `rctx.context` the batched driver forks per row. The per-row outer slot
  is correctly isolated (each row forks its own `rowCtx` + boxed `ref`, shadowing
  the outer attribute), so branch correlations on outer columns are safe. But any
  branch sub-plan that reads a *non-outer* context entry the outer source mutates
  mid-pump could observe a torn value. Confirm real branch plans only reference
  the isolated outer-row attributes.
- **Strict-fork under nesting.** When the fan-out is itself nested under another
  fork (so `rctx.context` is a strict-wrapped map), the outer source mutating
  `rctx.context` while row forks hold the bump counter (>0) will throw a
  strict-fork violation. CI runs fan-out specs under `QUEREUS_FORK_STRICT=1`, so
  the first integration/golden test that builds a batched node over a real outer
  plan inside a parallel region may surface this. Decide: prefetch/snapshot the
  outer ahead of forking, or relax the contract for the batched outer pump.

## Notes

- Golden-plan impact: this rule *will* change physical plans on high-latency
  fixtures — budget test fixtures accordingly (mirror `parallel-fanout.spec.ts`).
- Defer the streaming-`cross` + batched-outer combined mode (the cross-mode
  ticket owns that); recognition here assumes `atMostOne-*` branches only until
  cross mode lands.
