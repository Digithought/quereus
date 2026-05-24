description: Recognize 1:n parameterized-lookup join chains as `cross` FanOutLookupJoin branches, with per-branch row-estimate + max-product guards so a large product stays a nested-loop chain. Plus verify the materialization advisory treats cross branches like NLJ inners (re-execute, never cache).
prereq: parallel-fanout-lookup-join-cross-node
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts
----

## Goal

Cluster a chain of equi-join lookups whose cardinality is **data-driven** (no FK→PK
at-most-one guarantee) into a single `FanOutLookupJoinNode` with `mode: 'cross'` branches. This
is a recognition pass distinct from v1's at-most-one clustering: same concurrent-drive latency
win, but the output row count is the product of per-branch cardinalities, so it needs row/product
guards before clustering.

## Recognition (`rule-fanout-lookup-join.ts`)

`recognizeBranch` today returns `null` unless `checkFkPkAlignment` holds (and, for inner, a
covering not-null FK + row-preserving path). A `cross` branch is the **complement**: a
parameterized equi-lookup that is *not* provably at-most-one.

- Add a cross-branch recognizer (extend `recognizeBranch` to also emit a `mode: 'cross'` result,
  or add a sibling pass over the same `joins[]` walk). Eligibility:
  - `join.joinType` is `'inner'` or `'cross'` (a `'left'` 1:n chain is out of scope — see open
    questions; reject for v1).
  - AND-of-column-equalities ON-clause via `extractEquiPairsFromCondition` +
    `isAndOfColumnEqualities` + `normalizePredicate`, with the equi-pair's left attribute
    originating in the outer subtree (reuse the existing `outerAttrIdToIdx` translation) — this is
    what makes the lookup parameterizable from `rctx.context`.
  - `extractTableSchema(join.right)` resolves (a single lookup table).
  - FK→PK alignment is **absent** (`!checkFkPkAlignment(...)`), OR present-but-not-at-most-one
    (e.g. FK→non-unique). Net: anything the at-most-one path rejects for cardinality reasons but
    that is still a clean parameterized equi-lookup becomes a `cross` branch.
- A chain may legitimately mix at-most-one and cross branches; build a single
  `FanOutLookupJoinNode` carrying both modes (the node ticket makes the emitter mode-agnostic).
- Branch child assembly is unchanged: `new FilterNode(scope, lookup, condition)`,
  `outputAttrs: lookup.getAttributes()`, `concurrencySafe` from `lookup.physical.concurrencySafe`.
- `preserveAttributeIds`: cross branch outputs are **not** nullable-widened (inner semantics);
  only `atMostOne-left` widens. Mirror the node's `buildAttributes` branch on
  `mode === 'atMostOne-left'`.

### Guards (the memory-safety mechanism — do not skip)

The Cartesian product can be unbounded, so gate **before** clustering:

- Per-branch: skip the cross cluster if any cross branch's `lookup.estimatedRows` exceeds a new
  `tuning.parallel.maxCrossBranchRows` (propose default reusing the spirit of
  `join.maxRightRowsForCaching` = 50000; pick a parallel-specific default, e.g. 10000).
- Whole-product: skip if `outer.estimatedRows × Π(cross branch estimatedRows)` exceeds a new
  `tuning.parallel.maxCrossProduct` (propose default e.g. 1e6). Guard against `undefined`
  estimates conservatively (treat unknown as "too large" ⇒ don't cluster, leaving the safe
  nested-loop chain).
- When a guard trips, return `null` (leave the chain as ordinary nested-loop joins, which stream
  / re-execute and are already memory-safe). Document both new tuning fields in
  `optimizer-tuning.ts` alongside the other `parallel` knobs, and add them to `DEFAULT_TUNING`.

### Cost gate

Unchanged: anchored on `physical.expectedLatencyMs` over the combined branch set
(`maxLatency`, `savings = (totalBranches - concurrencyCap) × maxLatency`, vs
`overhead = totalBranches × branchSetupCost`). So the rule stays inert on local memory-vtab plans
(latency 0). Cross branches participate in `maxLatency` like any other.

## Optimizer integration — verify, don't over-build

The plan ticket asks to confirm the materialization advisory treats `cross` branch children like
a nested-loop join's inner side. Findings from the codebase that shape this:

- `ReferenceGraphBuilder` (`planner/cache/reference-graph.ts`) **never originates a loop
  context** — `inLoop` starts `false` and is only ever *propagated*, never set `true`
  (`buildReferences` / `visitAllChildren`). So `RefStats.appearsInLoop` is effectively always
  `false` today, and the advisory's Rule 6 (`materialization-advisory.ts:134`) is currently inert
  for **all** loop contexts, NLJ inners included.
- Even if it weren't, the advisory's Rule 3 (`materialization-advisory.ts:99`,
  `isCorrelatedSubquery`) declines to cache correlated nodes — and cross branches are correlated.
- Net: cross branches already get the correct treatment (re-execute per outer row, never cached
  across outer rows), identical to NLJ inners, **with no advisory/reference-graph change needed
  for v1.** Intra-outer-row product replay is the node's transient per-row materialization
  (sibling ticket), bounded by the recognition guards above.

So this phase is **verification + regression tests**, not new caching wiring:

- Add a test asserting a recognized cross branch's lookup is *not* wrapped in a `CacheNode` after
  optimization (it must re-execute per outer row). Confirm `isCorrelatedSubquery` returns true for
  the branch child shape.
- Add a test that a cross chain exceeding `maxCrossBranchRows` / `maxCrossProduct` does **not**
  form a fan-out (stays nested-loop) — this is the memory bound, proven at recognition.
- If, while testing, you find the advisory *does* somehow wrap a cross branch (e.g. a future
  loop-detection change lands), make it respect the `maxRightRowsForCaching` size gate rather than
  caching unconditionally, and degrade to re-execution above it. Otherwise leave the advisory
  untouched and record the "loop detection is inert" finding in the review handoff so the next
  agent doesn't re-derive it.

## Plan/recognition tests (`test/optimizer/parallel-fanout.spec.ts`)

Reuse the `HighLatencyMemoryModule` fixture + `concurrency: 2` tightening already in the file.

- A 1:n equi-lookup chain (FK→non-unique, or no FK) under the high-latency module forms a
  `FanOutLookupJoin` whose branches report `mode: 'cross'` (assert via plan `properties`), and the
  join count collapses.
- End-to-end result equality: the cross fan-out plan returns the **same multiset** as the
  equivalent `select … from outer join b0 … join b1 …` nested-loop chain (run both, compare).
  Use `forkExecTest` (skips under strict-fork, per the file's existing pattern).
- Empty cross branch (a lookup key with no matches) drops that outer row (inner-drop) — matches
  the nested-loop chain.
- Guard trip: inflate a branch's estimate above `maxCrossBranchRows` ⇒ no fan-out.
- Mixed chain: one at-most-one FK→PK branch + one cross branch in the same query → single
  `FanOutLookupJoin` with both modes; result equals the nested-loop chain.
- Local-only (default memory module, latency 0) → no rewrite (rule inert), per existing pattern.

## TODO

- [ ] Add `maxCrossBranchRows` + `maxCrossProduct` to `parallel` tuning + `DEFAULT_TUNING` + docs.
- [ ] Cross-branch recognizer in `recognizeBranch`/sibling pass; reject `left` 1:n for v1.
- [ ] Row + product guards gating cluster formation; conservative on unknown estimates.
- [ ] Build cross/mixed `FanOutLookupJoinNode`; cross outputs not nullable-widened in
      `preserveAttributeIds`.
- [ ] Verification tests: cross branch not CacheNode-wrapped; guard trip leaves nested-loop.
- [ ] Recognition + end-to-end plan tests (multiset equality vs nested-loop chain).
- [ ] Record the "reference-graph loop detection is inert / Rule 3 already excludes correlated
      cross branches" finding in the review handoff.
- [ ] `yarn workspace @quereus/quereus run build` + `… test` green; lint clean.

## Open questions (locked / parked)

- **Empty cross branch** → inner-drop (locked; node ticket enforces, tests assert). A `cross-left`
  variant for replaced LEFT chains is future work — park if a LEFT 1:n chain is encountered.
- **Remote-rescan vs spill** (record only): re-executing a *remote* cross branch across outer
  rows re-pays round-trip latency; caching a large per-row result risks memory. Per-outer-row
  results are normally small, so transient materialization is the sensible default; the unbounded
  remote case is what a future `'spill'` strategy (`cache-node.ts:9`, currently unimplemented)
  would serve. Out of scope here.
