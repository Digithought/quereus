description: Post-optimization rule `ruleEagerPrefetchProbe` that wraps the probe (left) side of a physical hash join in `EagerPrefetchNode` when the build (right) side advertises high first-row latency. Reuses the established `physical.expectedLatencyMs` cost gate already consumed by the FK fan-out and UNION-ALL gather rules, so the rule is inert by design on local-only memory-vtab plans.
files: packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts
----

## Goal

Recognize physical hash joins where the build side has high first-row latency, and wrap the probe (`left`) input in `EagerPrefetchNode` so the probe-side iterator can pipeline its reads with the parent emit's per-row work.

## Target shape

`BloomJoinNode` (physical, `PlanNodeType.HashJoin`). Per `bloom-join-node.ts:30-34`, **`left` is the probe (streamed) side** and `right` is the build (materialized) side — opposite of textbook convention. The wrap target is `left`. (The plan ticket once contained the text "right (probe)"; that was incorrect for this codebase.)

The runtime currently consumes `rightSource` to completion (build phase, `bloom-join.ts:57-67`) before iterating `leftSource` (probe phase, `bloom-join.ts:77`). With current `EagerPrefetchNode` semantics — pump starts on first iteration, not on emit (`eager-prefetch.ts:173` and `prefetchAsyncIterable` body) — the immediate win is **per-row probe-latency hiding**: the buffered pump fetches the next batch of left rows while `BloomJoinNode.run`'s synchronous probe work (key serialize, hash lookup, residual eval, yield) runs. The "build phase overlaps with probe-prefetch first round-trip" win the plan ticket describes is **also** unlocked once EagerPrefetch (or BloomJoin's emit) starts the probe pump before the build for-await — see § "Out of scope" — but the wrap rule itself is the necessary precondition for both wins, so landing it now is correct independent of when the eager-start change lands.

## Cost gate

Anchored on `physical.expectedLatencyMs`, the same field consumed by `rule-fanout-lookup-join` and `rule-async-gather-union-all`. That field is populated 0 on every in-process / memory-vtab leaf (`reference.ts:193-236`) and non-zero only when a `VirtualTableModule.expectedLatencyMs` declaration sits at a leaf — i.e. when a remote vtab plugin is in tree. As a consequence the rule is **inert by design on memory-vtab plans**, preserving the local-only golden-plan invariant the parallel rules already lock.

Specifically: gate on `node.right.physical.expectedLatencyMs >= tuning.parallel.prefetchProbeThresholdMs`. We deliberately gate on the **build side**, not on `node.physical.expectedLatencyMs` (which is the max-of-children via the default child-merge in `plan-node.ts:545-590`). Reasoning: if `left` is the slow one, the consumer above the join already takes the latency hit one way or another; the prefetch wrap doesn't change first-row time meaningfully. The asymmetric win the plan ticket cares about — overlapping the BloomJoin's build wait with concurrent probe-side fetching — is gated by `right` latency. (The implementer is free to switch to a `max(left, right)` gate after measuring against a real remote vtab if the symmetric framing turns out to be more accurate; either is a one-line change in the rule and a test-fixture rotation.)

## Skip predicates

Skip the wrap when any of:

- `left.nodeType === PlanNodeType.EagerPrefetch` — already wrapped (idempotence).
- `left.nodeType === PlanNodeType.Cache` — pre-materialized; a prefetch over a cache is pointless and confusing in plan output. (Materialization-advisory runs at PostOptimization priority 30, *after* this rule at priority 15, so this guard handles the rare case where some other path inserted a Cache earlier — e.g. mutating-subquery-cache at PostOpt priority 10.)
- `left.nodeType === PlanNodeType.AsyncGather` — the gather already drives its branches concurrently; adding a prefetch buffer between it and the join just adds latency-of-first-row without buying overlap.

Pure-`nodeType` checks are sufficient; a `CapabilityDetectors.isCached` style detector isn't worth introducing for three constants.

## Rule mechanics

- Phase: `PassId.PostOptimization`
- Node type: `PlanNodeType.HashJoin`
- `phase: 'rewrite'`
- Priority: **15** — strictly after `asof-strategy-select` (PostOpt priority 11, finalizes leaf physical properties incl. `expectedLatencyMs`) and `mutating-subquery-cache` (priority 10), strictly before `cte-optimization` (priority 20) and `materialization-advisory` (priority 30, must see the prefetch-wrapped tree so it doesn't re-wrap in Cache).
- Rewrite: `node.withChildren([new EagerPrefetchNode(node.scope, node.left, bufferSize), node.right, ...residual?])`. Buffer size pulled from `tuning.parallel.prefetchBufferSize`.

`BloomJoinNode.withChildren` (`bloom-join-node.ts:123-152`) already short-circuits when nothing changed and arity-checks the children — pass exactly the same shape (`left`, `right`, optional residual) so it returns a fresh `BloomJoinNode` without trying to validate types beyond `isRelationalNode`.

## Tuning knobs

Add to `OptimizerTuning.parallel` (`optimizer-tuning.ts`):

- `prefetchProbeThresholdMs: number` — minimum `right.physical.expectedLatencyMs` (in ms) for the wrap to fire. Default `25` — same fixture value the existing parallel rules already use, so the synthetic `HighLatencyMemoryModule` test fixture (declared in `test/optimizer/parallel-async-gather.spec.ts:25-29` and `parallel-fanout.spec.ts:25-32`) exercises this rule with no further test-side tuning.
- `prefetchBufferSize: number` — default `64`. Mirrors the `EagerPrefetchNode` constructor default (`eager-prefetch-node.ts:28`) so the in-tree default is unchanged from what manual construction already produces.

Pin both with a `default tuning has prefetch knobs > 0` test mirroring the analogous pin in `parallel-async-gather.spec.ts` (the "default tuning has gatherThresholdMs > 0" case at line 311) — locks the local-only no-rewrite invariant.

## File layout

New file: `packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts`. Sits next to `rule-async-gather-union-all.ts` in the same `parallel/` folder.

Register in `optimizer.ts` next to `async-gather-union-all` registration (around line 555). Follow the existing comment style: name the gate, name the priority neighbours, name the no-rewrite-on-local invariant.

## Tests

New file: `packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts`. Mirror the structure of `parallel-async-gather.spec.ts` — import `MemoryTableModule`, declare a local `HighLatencyMemoryModule` (subclass with `readonly expectedLatencyMs = 25`), use `query_plan(?)` as the introspection surface.

Pin these cases:

- **Fires when right (build) is high-latency and left is local.** A join over `local_orders` joined to `hi_lat_lookup` should produce a `BLOOMJOIN` (or `HASHJOIN`) whose probe side is an `EAGERPREFETCH`. Assertion: `plan.some(r => r.op === 'EAGERPREFETCH' || r.node_type === 'EagerPrefetch')`, AND that prefetch sits between the HashJoin and the probe-side leaf (walk the plan rows by parent/child relationship if `query_plan` already exposes that, else assert on row ordering as the gather/fanout specs do).
- **Does NOT fire on local-only joins.** Two memory-vtab tables joined with an equi-pair — no prefetch in the plan, regardless of row counts.
- **Does NOT fire when left is already EagerPrefetch.** Construct the join manually with an EagerPrefetch already over the probe (or run the rule twice and assert idempotence at the SQL level — the same SQL planned twice doesn't produce a doubly-wrapped probe).
- **Does NOT fire when left is already Cache.** Same approach (manual construction or rely on a SQL shape where `rule-mutating-subquery-cache` produces a `Cache` over the join's left source).
- **Does NOT fire when threshold is raised above the leaf's `expectedLatencyMs`.** Override `tuning.parallel.prefetchProbeThresholdMs` to 1000, verify no prefetch.
- **`disabledRules` opt-out works.** Set `disabledRules: new Set(['eager-prefetch-probe'])`, verify no prefetch.
- **Default tuning has `prefetchProbeThresholdMs > 0`.** Locks the local-only no-rewrite invariant at the tuning layer.
- **End-to-end execution returns the same rows the unwrapped plan does.** Run the SQL with the rule enabled and again with `disabledRules: new Set(['eager-prefetch-probe'])`; assert the row sets match. (This is the only execution-level test the rule needs at this stage — a SQLLogic test demonstrating a latency win is not appropriate per the plan ticket's "out of scope" note.)

## Out of scope (deliberate, follow-on backlog)

- **EagerPrefetch eager-start in `run()` instead of first-iteration.** The current implementation defers fork+pump start to the first `.next()` on the prefetch's async generator body (`prefetchAsyncIterable` body runs lazily). To realize the "build overlaps with probe's first round-trip" win the plan ticket describes, the pump must start as soon as the scheduler invokes the prefetch's `run()` — which is before the BloomJoin's `run()` is invoked, so the pump runs concurrently with the build for-await. Two viable approaches:
  1. Restructure `emitEagerPrefetch` so its `run()` returns a *non-generator* AsyncIterable whose construction has already kicked off the pump.
  2. Modify `emitBloomJoin` to call `leftSource[Symbol.asyncIterator]()` (and one `.next()`) before the build for-await, to trigger the prefetch's generator body.
  Either is a follow-on; file as `parallel-eager-prefetch-eager-start` in `tickets/backlog/` after this ticket lands, with the rationale captured here.
- **Broad cost-driven gate.** The plan ticket mentions option (2): `right.estimatedRows × per-row-build-cost > threshold` regardless of remoteness. Defer until the optimizer has a per-row-build-cost characteristic on physical nodes; today only `getTotalCost()` aggregates exist and they don't separate first-row from per-row.
- **Merge / nested-loop / asof joins.** Different operator shapes:
  - Merge join consumes both sides interleaved; the win shape is "prefetch both" not "prefetch left", and the right gate would need to be on the slower side.
  - Nested-loop joins re-iterate the right side per outer row; a prefetch on the left helps a little but `rule-fanout-lookup-join` already covers the high-value remote-RHS case.
  - Asof joins have their own strategy-select rule (`asof-strategy-select`).
- **Wrapping the build side.** Per the plan ticket, the build is consumed once linearly before the probe touches it; prefetching it serves no purpose. The join already drains it greedily.
- **Wrapping arbitrary high-latency subtrees.** The "wrap any subtree whose expected first-row latency exceeds a threshold" heuristic is broader than this ticket; defer until the optimizer has a propagated `expectedFirstRowLatencyMs` distinct from `expectedLatencyMs`.

## TODO

- Add `prefetchProbeThresholdMs` and `prefetchBufferSize` to `OptimizerTuning.parallel` in `optimizer-tuning.ts`. Document both in the same comment block style as `gatherThresholdMs`. Update `DEFAULT_TUNING.parallel`.
- Implement `ruleEagerPrefetchProbe` in `packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts`. Module-level docstring covering: target shape (BloomJoin left=probe), cost gate (right.expectedLatencyMs ≥ threshold), skip predicates (EagerPrefetch / Cache / AsyncGather on left), idempotence, no-rewrite-on-local invariant.
- Register the rule in `optimizer.ts` under `PassId.PostOptimization`, priority 15, with a comment naming neighbours (after `mutating-subquery-cache` at 10 / `asof-strategy-select` at 11, before `cte-optimization` at 20 / `materialization-advisory` at 30).
- Add `packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts` with the cases listed in § Tests above. Reuse the `HighLatencyMemoryModule` pattern from `parallel-async-gather.spec.ts`.
- Run `yarn test` from `packages/quereus`; run `yarn lint`. Both must pass clean. Stream long-running output as `2>&1 | tee /tmp/foo.log` per AGENTS.md.
- Update `docs/optimizer.md` if it enumerates parallel rules (search for `async-gather-union-all` or `fanout-lookup-join` to confirm coverage style); add a short bullet for this rule with the same level of detail. If the docs don't enumerate the parallel rules individually, leave docs alone.
- File `tickets/backlog/parallel-eager-prefetch-eager-start.md` describing the EagerPrefetch eager-start follow-on (see § Out of scope, item 1). Two-paragraph backlog ticket — problem statement, suggested approach options — no plan-stage detail.
