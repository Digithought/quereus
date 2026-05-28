---
description: Review the side-effect audit safety net — registry guardrail, per-rule fixes, hasSideEffects propagation, and FROM-position DML write-target propagation in ChangeScope.
prereq: query-expr-ast-parser-unification
files:
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/analysis/change-scope.ts
  - packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  - packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts
  - packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts
  - packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts
  - packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts
  - packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts
  - packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts
  - packages/quereus/test/optimizer/side-effect-audit.spec.ts
  - packages/quereus/test/optimizer/change-scope-analyzer.spec.ts
  - packages/quereus/test/optimizer/pass-manager.spec.ts
  - packages/quereus/test/planner/framework.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
  - docs/change-scope.md
---

## Summary

Lands the side-effect awareness safety net for the optimizer. Three pieces:

1. **Registry guardrail.** Every rule registration via `addRuleToPass` or
   `registerRule` must declare `sideEffectMode: 'safe' | 'aware'`. The
   validation fires at registration time (both paths) and rejects rules
   that fail to declare. Every existing rule is annotated inline at its
   `addRuleToPass(...)` call in `src/planner/optimizer.ts` with a short
   rationale.

2. **Per-rule fixes.** Rules that move, duplicate, drop, or merge a
   subtree now consult `PlanNodeCharacteristics.subtreeHasSideEffects`
   and refuse when any participating subtree carries a write. See the
   list under *Audit fixtures* below.

3. **`ChangeScope` write-target propagation.** `analyzeChangeScope` now
   walks both `getChildren()` and `getRelations()` so DML write targets
   (`Insert.table` / `Update.table` / `Delete.table`, which sit outside
   `getChildren`) surface in the outer statement's `ChangeScope` when the
   DML is in FROM position.

## Usage / behavioral impact

- **No user-visible feature change.** The safety net is mostly inert
  today because DML still appears only at the statement root or in FROM
  position (a CTE-or-subquery source). Once `dml-in-expression-position`
  (parallel ticket 3) lifts the planning-time gate, the aware rules will
  start refusing on the new shapes.
- **FROM-position DML in a SELECT** (e.g.
  `select * from (insert into t (id, x) values (1, 99) returning id) z`)
  now correctly reports `t` in `Statement.getChangeScope().watches`.
  Watchers subscribed via `Database.watch` with a scope that includes
  `t` will see the write on commit (the runtime side already logged the
  change; this change makes the *static* scope reflect that).
- **Registration-time validation** rejects any rule handle without
  `sideEffectMode`. Plugin authors registering custom rules will now get
  an explicit error rather than a silent admission.

## Audit fixtures

Per-rule guards added in this ticket (each refuses when the relevant
subtree carries a side effect):

- `ruleFilterFoldEmpty` — `Filter(x, lit-false) → Empty` (refuses if `x` writes).
- `ruleFilterContradiction` — UNSAT folding to Empty (same source guard).
- `ruleJoinFoldEmpty` — refuses when the dropped (non-empty) side writes.
- `ruleAntiJoinFkEmpty` — refuses on impure L or R.
- `ruleSemiJoinFkTrivial` — refuses when dropping a side-effect-bearing R.
- `ruleJoinElimination` / `ruleJoinEliminationUnderAggregate` — refuses
  to drop the FK side when it writes (gate inside `tryEliminate`).
- `ruleJoinGreedyCommute` — refuses on side-effect-bearing side.
- `ruleJoinPhysicalSelection` — refuses to swap build/probe of inner
  hash join when either side writes.
- `ruleQuickPickJoinEnumeration` — refuses when any participating
  relation writes.
- `ruleSubqueryDecorrelation` — refuses on impure inner subquery.
- `rulePredicatePushdown` — refuses to push past a child whose subtree
  writes.
- `ruleAggregatePredicatePushdown` — refuses when aggregate source writes.
- `rulePredicateInferenceEquivalence` — refuses branch injection above a
  side-effect-bearing join side.
- `ruleProjectionPruning` — refuses to drop a projection whose scalar
  expression writes.
- `ruleScalarCSE` — collector skips `readonly === false` expressions;
  replacer also gates on `readonly !== false`.
- `ruleAsyncGatherUnionAll` / `ruleAsyncGatherZipByKey` /
  `ruleEagerPrefetchProbe` / `ruleFanOutLookupJoin` /
  `ruleFanOutBatchedOuter` — refuse when any concurrently-driven branch
  (or outer) writes.

The propagation through `PlanNode.physical.readonly` (AND-of-children
in the `get physical()` defaults) already does the heavy lifting; the
new `PlanNodeCharacteristics.subtreeHasSideEffects(node)` helper is a
defensive belt for rules that want to express the intent and survive a
broken `computePhysical` override.

## Testing

Pinned in two new spec files:

- `test/optimizer/side-effect-audit.spec.ts` — negative cases via
  FROM-position DML (already runnable post-ticket-1):
  - `Filter(InsertReturning, false)` does NOT fold to `EmptyRelation`.
  - Cross-join with empty side does NOT fold when the other side writes.
  - `PassManager.addRuleToPass` rejects an unannotated rule; accepts
    `'safe'` and `'aware'` declarations.
  - `subtreeHasSideEffects` returns true on a subtree whose deep
    descendant writes (including the "lying wrapper" case where the
    local node's `readonly` flag was overridden to true but a child
    still writes).

- `test/optimizer/change-scope-analyzer.spec.ts` (new section *DML
  write-target propagation*) — `select * from (insert into t … returning
  id) z` reports `main.t` in `scope.watches`.

Existing tests in `test/planner/framework.spec.ts` and
`test/optimizer/pass-manager.spec.ts` were updated to declare
`sideEffectMode: 'safe'` on their synthetic test rules (registry
validation now applies there too).

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (root) — **3659 passing, 0 failing in `@quereus/quereus`,
  full multi-package suite green, Done in 2m 45s**. Type-check via
  `tsc --noEmit` also clean.

## Known gaps the reviewer should weigh

- **Audit coverage is per-rule, not exhaustive.** Categorization
  treated the following as `'safe'` because the rule's structural shape
  preserves side-effects: `ruleSelectAccessPath`, `ruleMonotonicMergeJoin`,
  `ruleAggregatePhysical`, `ruleAsofStrategySelect`,
  `ruleLateralTop1Asof`, `ruleMonotonicLimitPushdown`,
  `ruleMonotonicRangeAccess`, `ruleMonotonicWindow`,
  `ruleDistinctElimination`, `ruleOrderByFdPruning`,
  `ruleGroupByFdSimplification`, `ruleSargableRangeRewrite`,
  `ruleFilterMerge`, `ruleGrowRetrieve`, `ruleJoinKeyInference`,
  `ruleProjectFoldEmpty` / `Sort` / `Limit` / `Distinct` (sources are
  EmptyRelation leaves). Each rationale is inline next to the
  `addRuleToPass` call. The reviewer should sanity-check those
  classifications — if any do drop/move/dedup an impure subtree under
  some shape I missed, flip them to `'aware'` and add the consultation.
- **`rule-cte-optimization` is `'aware'`** because wrapping a CTE
  source in `CacheNode` changes a per-reference re-execution to a
  run-once memoize. That is *sound* for side effects (one write instead
  of N), but the order-change is observable, so I marked it aware
  rather than safe. The rule does not currently consult
  `hasSideEffects` (CacheNode itself is the run-once fence). A
  reviewer could argue this should explicitly refuse on impure CTE
  sources until `dml-in-expression-position` is in (to match the rest
  of the audit's "refuse" posture); I left it as a deliberate
  weaken-not-refuse so the run-once semantics already implicit in
  CacheNode aren't lost when DML in CTEs becomes commonplace.
- **`rule-materialization-advisory` is `'aware'`** because the underlying
  `CachingAnalysis.isCacheable` already gates side-effect-bearing
  subtrees ("only cache if expensive + repeated"). That gate is not
  enforced by the *audit* helper; the reviewer should confirm the
  advisory's gate is enough.
- **`subtreeHasSideEffects` is O(plan size).** Every aware rule that
  calls it walks the candidate subtree. The existing
  `PlanNode.hasSideEffects` (local-only) could substitute in cases
  where `physical.readonly` propagation is *known* to be correct (it
  always is, in tree-shaped plans). I kept the deeper walk as the
  defensive default; if profiling shows it matters, switch the hot
  rules back to the local-only check.
- **DML write-target propagation in `analyzeChangeScope`** is
  implemented by adding `getRelations()` to the walker's traversal.
  `analyzeRowSpecific` already walked both via
  `createTableInfosFromPlan`, so this is a one-line extension. The
  test pins the FROM-position case; `INSERT INTO t (id, x) VALUES ...`
  (no FROM-wrapping) at the root still goes through
  `isDmlWithoutReturning → watches=[]`, matching prior behavior. If the
  reviewer wants the write target captured for ROOT-level DML too,
  that's a separate decision (and would need a new field on
  `ChangeScope` — "writes" — rather than the existing read-side
  `watches`).
- **No runtime test of `Database.watch` firing on a wrapped DML.** The
  ticket mentions "watch fires correctly with no further work" once
  the scope is right; the change-scope analyzer test confirms the
  scope is right. End-to-end watcher-firing tests exist in
  `database-watchers.spec.ts` for non-wrapped DML; extending them to
  the wrapped case is a small addition the reviewer could either fold
  in here or land separately.

## Out of scope (deferred)

- Runtime emitter changes — `dml-in-expression-position`.
- Lifting the planning-time DML-in-expression-position gate —
  `dml-in-expression-position`.
- Parallel-track refusal — `query-expr-parallel-track-refusal`.
- Adding a separate `writes` field to `ChangeScope`. Today, a wrapped
  DML's write target appears in `watches` as a full read scope, which
  is sound (over-reports rather than under-reports) but doesn't
  distinguish write-only from read-and-write. If a future consumer
  needs the distinction, that's a separate ticket.
