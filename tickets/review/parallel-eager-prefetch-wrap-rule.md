description: Review the `eager-prefetch-probe` PostOptimization rule — wraps a hash join's probe (left) side in EagerPrefetch when the build (right) side is high-latency. Verify the cost gate, skip predicates, pass placement, and test coverage.
files: packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts, docs/optimizer.md, tickets/backlog/parallel-eager-prefetch-eager-start.md
----

## What landed

A new PostOptimization rule `ruleEagerPrefetchProbe` that recognizes a physical hash join (`BloomJoinNode`, `PlanNodeType.HashJoin`) whose **build (`right`) side** advertises high first-row latency, and wraps the **probe (`left`) side** in an `EagerPrefetchNode`. Inert by design on local-only memory-vtab plans because the cost gate is anchored on `right.physical.expectedLatencyMs`, which is 0 everywhere except remote-vtab leaves.

Key convention to keep in mind while reviewing: in `BloomJoinNode`, `left` is the **probe (streamed)** side and `right` is the **build (materialized)** side — opposite of textbook. The wrap target is `left`; the gate reads `right`.

### Changes

- **`optimizer-tuning.ts`** — added `prefetchProbeThresholdMs` (default 25) and `prefetchBufferSize` (default 64) to `OptimizerTuning.parallel` + `DEFAULT_TUNING.parallel`, documented in the same style as `gatherThresholdMs`.
- **`rule-eager-prefetch-probe.ts`** (new, in `rules/parallel/`) — the rule. Cost gate `right.physical.expectedLatencyMs >= prefetchProbeThresholdMs`; skip predicates for `left.nodeType` ∈ {`EagerPrefetch`, `Cache`, `AsyncGather`}; rewrite via `node.withChildren([new EagerPrefetchNode(scope, left, bufferSize), right, ...residual?])`.
- **`optimizer.ts`** — registered `id: 'eager-prefetch-probe'`, `nodeType: HashJoin`, `phase: 'rewrite'`, **priority 15** in `PassId.PostOptimization` (after mutating-subquery-cache@10 / asof-strategy-select@11, before cte-optimization@20 / materialization-advisory@30).
- **`parallel-eager-prefetch-probe.spec.ts`** (new) — 12 tests, all passing.
- **`docs/optimizer.md`** — new "Eager-prefetch probe wrap" subsection alongside the other parallel rules.
- **`tickets/backlog/parallel-eager-prefetch-eager-start.md`** (new) — the deliberate follow-on (see below).

## Validation performed

- `yarn build` (packages/quereus) — clean.
- `yarn lint` (packages/quereus) — clean.
- `yarn test` (full monorepo) — 3425 passing in quereus + all other workspaces green (the quereus-sync stack traces in the log are deliberate error-injection tests inside passing suites, not failures).

## Test cases pinned (use these as the floor, not the ceiling)

SQL-level (full optimizer, `query_plan(?)` introspection over a `HighLatencyMemoryModule` fixture):
- **Fires** when build is high-latency + probe local; asserts exactly one `EAGERPREFETCH` whose `parent_id` is the hash-join row (i.e. it is the probe child).
- **Does NOT fire** on a local-only join.
- **Idempotent** — re-planning the same SQL yields exactly one prefetch (covers the `EagerPrefetch`-already-on-left skip).
- **Threshold raised** to 1000 → no prefetch.
- **`disabledRules: {'eager-prefetch-probe'}`** → no prefetch.
- **Default tuning** `prefetchProbeThresholdMs > 0` and `prefetchBufferSize > 0`.
- **Execution equivalence** — rule-on vs rule-off row sets match (8 rows).

Direct rule invocation (manually built `BloomJoinNode` + mock `OptContext`, since these probe shapes are awkward from SQL):
- Fires (returns a `BloomJoinNode` whose `left` is an `EagerPrefetchNode` wrapping the original probe).
- Skips when `left` is `EagerPrefetch` / `Cache` / `AsyncGather`.
- Skips when build latency is below threshold.

## Known gaps / things a reviewer should poke at

- **The "fires" SQL test depends on the optimizer selecting a hash join AND keeping the high-latency table on the build (right) side.** It uses an INNER join with both join keys non-PK (forces hash over merge) and `hi_lat_lookup` placed on the right with fewer rows than `local_orders` (the INNER swap only triggers when `leftRows < rightRows`, so build stays = right). This is somewhat sensitive to row-estimation / physical-selection behavior; if a future cost-model change flips the algorithm or the build side, the test would silently stop exercising the rule. The execution-equivalence test guards against a vacuous pass by asserting the rule fired. Worth a sanity check that the join shape is robust.
- **No runtime/latency-win test.** Per the plan ticket this is deliberate — the rule is the precondition, and the actual build-overlaps-probe win is unlocked only by the EagerPrefetch eager-start change filed as `tickets/backlog/parallel-eager-prefetch-eager-start`. Today's win is per-row probe-latency hiding (pump fetches next batch during the join's synchronous probe work). No SQLLogic latency test was added (correctly, per plan ticket "out of scope").
- **Gate is on `right` (build) latency only.** The ticket explicitly allows switching to `max(left, right)` after measuring against a real remote vtab. There is no remote-vtab plugin in-tree to measure against, so the asymmetric framing is unverified empirically — it is a reasoned default, not a measured one.
- **The Cache/AsyncGather skip predicates are only exercised via direct rule invocation with mock nodes**, not via a real SQL plan that naturally produces those shapes on the probe. The mock-based coverage is sound for the rule's logic but does not prove those shapes actually arise upstream of a hash join in practice.
- **`MockRelNode` is duplicated** from `test/runtime/fanout-lookup-join.spec.ts` rather than shared. Acceptable per existing test conventions (that file also re-declares it), but a reviewer may prefer extracting a shared helper.
