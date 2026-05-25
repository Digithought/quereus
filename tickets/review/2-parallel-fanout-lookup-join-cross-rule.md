description: Review the `cross` (1:n) FanOutLookupJoin recognition rule — per-branch + product guards, mixed at-most-one/cross chains, and the verified "advisory needs no change" finding.
prereq: parallel-fanout-lookup-join-cross-node
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, docs/optimizer.md
----

## What landed

Extended `ruleFanOutLookupJoin` to recognize **`cross` (1:n) branches** — parameterized
equi-lookups that are *not* provably at-most-one — alongside the existing at-most-one FK→PK
and correlated-subquery branches. The sibling node ticket (`parallel-fanout-lookup-join-cross-node`,
already in review) made `FanOutLookupJoinNode` mode-aware; this ticket is the recognition +
guard layer that *produces* cross branches.

### Changes

- **`optimizer-tuning.ts`** — added `parallel.maxCrossBranchRows` (default 10000) and
  `parallel.maxCrossProduct` (default 1e6) to the interface and `DEFAULT_TUNING`, documented inline.
- **`rule-fanout-lookup-join.ts`**
  - `recognizeBranch` now also accepts `cross` join type and emits `mode: 'cross'` when FK→PK
    alignment is **absent** (no FK, or FK→non-unique) on an INNER/CROSS join. Structure:
    - aligned + `left` → `atMostOne-left`
    - aligned + `inner` → at-most-one-inner **iff** covering not-null FK + row-preserving path;
      otherwise `return null` (bails the cluster — preserves the existing nullable-FK-inner test).
    - not-aligned + `inner`/`cross` → `cross`
    - `left` not-aligned → `return null` (left 1:n out of scope for v1).
  - New `crossGuardsPass(outer, crossLookups, tuning)`: skip clustering if any cross branch's
    lookup estimate > `maxCrossBranchRows`, or if `outer × Π(cross-branch rows)` > `maxCrossProduct`.
    Conservative on `undefined` (treat as too large). `rowEstimate(node)` helper reads
    `physical?.estimatedRows ?? estimatedRows`. Applied after the `minBranches` check, before the
    cost gate / node construction.
  - `preserveAttributeIds` already widened only `atMostOne-left` → cross outputs are correctly
    **not** nullable-widened. No change needed; verified by reading + by the node's matching
    `buildAttributes`/`getType`.
- **`docs/optimizer.md`** — fan-out section retitled "(FK→PK + 1:n cross)", documents the cross
  branch kind, the memory guard, the two new tuning knobs, and the remaining `cross-left` gap.
- **`parallel-fanout.spec.ts`** — new `describe('cross (1:n) lookup branches')` block (8 tests).

## Verification done (build + tests + lint all green)

- `yarn workspace @quereus/quereus run build` — clean.
- Full `yarn test` (quereus, memory-vtab) — **3517 passing, 10 pending, 0 failing.** No regressions.
- `yarn lint` — clean.
- New cross tests cover: cross-branch recognition (modes `['cross','cross']`, joins collapse);
  local-only inert; cross lookup **not** wrapped in `CacheNode`; multiset equality vs the
  nested-loop chain (incl. inner-drop of empty branches); both guard trips; mixed
  `['atMostOne-left','cross']` chain shape + result equality.

## Findings recorded (per ticket TODO — don't re-derive these)

1. **Reference-graph loop detection is inert.** `ReferenceGraphBuilder` never originates a loop
   context — `TraversalContext.inLoop` starts `false` and is only ever *propagated*, never set
   `true` (`reference-graph.ts` `buildReferences`/`visitAllChildren`). So `RefStats.appearsInLoop`
   is effectively always `false`, and the advisory's Rule 6 (`materialization-advisory.ts:134`) is
   inert for **all** loop contexts (NLJ inners included), not just cross branches.
2. **Advisory Rule 3 already excludes correlated cross branches.** A cross branch's child is a
   `FilterNode` over the lookup referencing outer attributes, i.e. correlated; `isCorrelatedSubquery`
   returns true, so `adviseCaching` Rule 3 (`materialization-advisory.ts:99`) declines to cache it.
   Net: **no advisory / reference-graph change was needed for v1** — cross branches already
   re-execute per outer row, identical to NLJ inners. Confirmed observationally by the
   "not wrapped in a CacheNode" test.

## Known gaps / things for the reviewer to probe (tests are a floor, not a ceiling)

- **Guard-trip tests use a sub-zero cap (`maxCrossProduct/maxCrossBranchRows = -1`).** The synthetic
  memory-vtab fixtures resolve `estimatedRows` to **0** (no row count reaches the access plan — true
  even after `ANALYZE`, which writes `statistics.rowCount` but not `schema.estimatedRows`). With a
  0-valued product, only a negative cap deterministically trips the gate. The production trip path
  (real positive estimate > positive cap) is the *same* comparison but is **not exercised by an
  end-to-end test** — there is no in-tree vtab that surfaces a positive `estimatedRows` to the rule.
  A reviewer wanting stronger coverage could add a fixture module that reports a positive
  `estimatedRows`, or a focused unit test of a hand-built node (rule internals aren't exported).
- **Product guard is permissive on memory-vtab plans** (estimate 0, not `undefined`). The cost-gate's
  latency requirement is what actually keeps the rule inert on local plans; the product guard only
  bites against real positive estimates. This is consistent with the spec ("unknown" = `undefined`),
  but means the memory-safety guard is effectively dormant in the default in-tree test environment.
- **`cross` recognition broadens what previously bailed.** Any INNER/CROSS equi-lookup that is a
  clean AND-of-equalities but not FK→PK now becomes a cross branch (previously the whole chain
  bailed). This only changes plans when `expectedLatencyMs > 0` (remote-ish), so memory goldens are
  unaffected — but a reviewer should sanity-check there's no remote-vtab golden plan that silently
  flips shape.
- **Join-order dependence.** Recognition requires the outer (FK/equi source) to be the deepest
  `.left` of the spine. For the cross tests this holds because the tiny `p` outer + high-latency
  children make `p`-as-driver the cheapest QuickPick order; it is **not pinned** (no quickpick
  disable). If a future cost-model change reorders inner joins, the cross tests could go
  inert (assert `hasFanOut === false`) rather than fail loudly. Low risk, worth noting.
- **FD propagation stays conservative** — `FanOutLookupJoinNode.computePhysical` folds branches with
  empty equi-pair lists (inherited from the node ticket); cross branches don't tighten this. Correct,
  just imprecise. Tracked upstream.

## Out of scope (parked, per ticket open questions)

- `cross-left` mode for a replaced LEFT 1:n chain (nullable-widened) — future work; a LEFT 1:n
  chain currently bails to a nested-loop left join.
- Remote-rescan vs spill for re-executing a *remote* cross branch across outer rows — the unbounded
  remote case is what a future `'spill'` strategy would serve (`cache-node.ts`). Out of scope.
