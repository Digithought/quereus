description: Review — fan-out lookup join now also clusters correlated scalar-aggregate subqueries (SELECT-list) as atMostOne-left branches alongside FK→PK join-spine branches. No new node mode or emitter path.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, docs/optimizer.md, tickets/backlog/parallel-fanout-aggregate-branch-wrapped-subquery.md
----

## What landed

`ruleFanOutLookupJoin` (Structural pass, priority 23) now recognizes **two**
kinds of at-most-one per-outer-row branches and combines them into one
`FanOutLookupJoinNode`:

1. **Join-spine branches** (pre-existing) — FK→PK LEFT/INNER lookups along the
   `.left` spine.
2. **Subquery branches** (new) — correlated scalar-aggregate `ScalarSubqueryNode`
   projections with no `GROUP BY`.

No new `FanOutBranchMode`, no emitter changes, no runtime changes. The recognition
emits `atMostOne-left` branches the existing v1 node/emitter already handles.

### Key implementation decisions (and a deviation from the ticket)

- **Recognition is direct in `ruleFanOutLookupJoin`** (not generic decorrelation),
  per the ticket's resolved open question.
- **Source-walk restructure:** hitting a non-Join/non-wrapper bottom is no longer
  a bail — it becomes the outer with zero spine branches (enables pure-subquery
  clusters). `extractTableSchema(outer)` is gated to `spineBranches.length > 0`.
- **DEVIATION — branch child is a wrapping `ProjectNode`, not the subquery root
  verbatim.** The ticket said to use `scalarSubquery.subquery` verbatim with
  `outputAttrs = subquery.getAttributes()`. That breaks: a no-`GROUP-BY`
  aggregate is the logical `AggregateNode` (1 output attr) at recognition time,
  but its physical `StreamAggregateNode` *also exposes the source columns* (for
  HAVING access). So after the rule runs, the optimizer rebuilds the FanOut via
  `withChildren` with a 4-attr physical child while `outputAttrs` was captured as
  1 — tripping `FanOutLookupJoinNode`'s `outputAttrs`-vs-child validation
  (`branch 0 outputAttrs length (1) does not match child attributes (4)`).
  **Fix:** wrap the subquery root in a stable single-column `ProjectNode`
  selecting the column-0 (scalar value) attribute, with `attributeId =
  valueAttr.id` so the branch output attribute stays identical to what the outer
  projection's rewritten `ColumnReferenceNode` targets. This Project survives
  project-elimination (selecting 1 of N columns is not an identity projection).
  Verified in the plan dump: `FanOutLookupJoin → Project → StreamAggregate →
  Filter → IndexScan` per branch. **Reviewer: confirm this wrapping is the right
  call vs. an alternative (e.g. teaching the node to take only column 0).**
- **Cost gate / `minBranches`** apply to the **combined** branch count; the gate
  reads `expectedLatencyMs` (propagated `max(children)` up through the aggregate),
  so it stays inert on local memory-vtab plans.

## How to validate

- Focused spec: `node --import ./packages/quereus/register.mjs
  node_modules/mocha/bin/mocha.js "packages/quereus/test/optimizer/parallel-fanout.spec.ts"`
  (run from repo root). 17 passing.
- Strict-fork: prefix `QUEREUS_FORK_STRICT=1` — execution-path cases skip via the
  `forkExecTest` guard, recognition cases pass (13 passing, 4 pending).
- Full suite: `node packages/quereus/test-runner.mjs` → 3468 passing, 10 pending,
  no regressions.
- `npx tsc --noEmit` clean; eslint clean on the two touched source/test files.

## Test coverage added (`test/optimizer/parallel-fanout.spec.ts`,
   `describe('correlated scalar-aggregate subquery branches')`)

A nested `beforeEach` drops `tuning.parallel.concurrency` to 1 so the 2-branch
cases clear the cost gate (`(N−cap)×latency` is 0 at N=cap; with cap=1, N=2 it is
`25 > 2×branchSetupCost`). Cases:

- **pure subquery cluster fires** — 2 correlated scalar aggregates → FANOUTLOOKUPJOIN
  with 2 `atMostOne-left` branches; an Aggregate node survives under the fan-out.
- **mixed cluster** — 1 FK→PK LEFT join + 1 subquery → 1 fan-out, 2 branches,
  `joinCount == 0` (join collapsed).
- **result correctness (enabled vs disabled)** — identical rows; the empty-children
  outer row (k=3) yields `count → 0` (NOT NULL — confirms the at-most-one zero-row
  NULL-fill path does not fire); k=1 yields `count → 2`. `forkExecTest`.
- **attribute-ID stability** — identical output column shape enabled vs disabled.
  `forkExecTest`.
- **inert in-tree** — plain `memory` vtab (latency 0) → no fan-out.
- **GROUP BY subquery rejected** — group-by subquery is not routed in; drops below
  `minBranches`, no fan-out.
- **non-correlated subquery not clustered** — `(select count(*) from a)` not routed.

## Known gaps / things a reviewer should probe

- **Correlation target not constrained to the outer.** Recognition uses
  `isCorrelatedSubquery` (any external reference), per the ticket. A subquery that
  correlates to a *spine branch* attribute (rather than the outer table) is not
  what the motivating queries do, but is not explicitly rejected — at runtime its
  `ColumnReferenceNode` would resolve against the outer descriptor only. Worth a
  guard or a documented rejection if the reviewer deems it a real risk. (No test
  exercises this; the motivating queries all correlate to the outer table.)
- **Wrapped subqueries deferred** — `coalesce((subq),0)`, `json((subq))`, etc. are
  not recognized (projection must *be* a `ScalarSubqueryNode`). Filed as backlog
  `parallel-fanout-aggregate-branch-wrapped-subquery`.
- **2-branch test cap=1 is degenerate** for "concurrency" — the recognition is
  what's tested, not actual parallel speedup. The 3-branch spine tests (cap=2)
  cover real concurrency; an analogous 3-subquery case was not added.
- **Runtime correctness of subquery branches** is exercised only through the
  enabled-vs-disabled equivalence test (skipped under strict-fork). There is no
  dedicated `test/runtime/` case for a subquery-branch fan-out; the enabled run is
  the floor.
- The wide-row `columnIndex` on the rewritten `ColumnReferenceNode` is computed
  (outer + Σ preceding branch outputs) but correctness rides on attribute-ID
  resolution; the index value itself is not independently asserted.

## Out of scope (unchanged from ticket)

No new `FanOutBranchMode`; the relational 1:n product case is
`parallel-fanout-lookup-join-cross-mode`.
