---
description: `maxOptimizationDepth = 50` rejects SELECTs whose WHERE has ~50+ conjuncts, because the left-associative AND tree is one level deeper than the conjunct count and the planner's traversal counts every AST descent. The user-visible bar is "a wide table with a wide WHERE should plan." Two fixes are viable; pick one.
prereq:
files:
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/performance-sentinels.spec.ts
---

## Symptom

`SELECT * FROM wide WHERE c0 < 1000 AND c1 < 1000 AND … AND c49 < 1000` (50 conjuncts) fails to plan with `Maximum optimization depth exceeded: 50` from `pass.ts:285`. The AND tree is left-associative with depth 49; the structural pass's top-down traversal descends one stack frame per AST level, and the guard at `pass.ts:298 / 335` trips.

Surfaced during the predicate-contradiction-detection ticket (`tickets/complete/2-optimizer-predicate-contradiction-detection.md` review finding #3) — the sentinel test had to be shrunk from 50 to 25 conjuncts to work around it.

## Why the current limit exists

`maxOptimizationDepth` (default `50`, `optimizer-tuning.ts:99`) guards against runaway rule rewrites that infinitely deepen the plan. The guard is in `PassManager.assertOptimizationDepth` and is incremented per recursive call in `traverseTopDown` / `traverseBottomUp` (`pass.ts:283-335`). Crucially, the recursion follows every `getChildren()` call, including AND-tree descents on the scalar predicate, so input shape (not just rewrite depth) drives the counter.

## Approach options

Pick one — both are defensible; document the tradeoff in the implement work.

### Option A (recommended): scale-by-input + rules-fired budget

The depth ceiling protects against two distinct hazards: (1) genuinely runaway rewrites that recursively wrap the plan, and (2) deep input AST tunnels (wide AND trees, deep CASE chains, etc.). Conflating them in one constant is the root cause.

- Compute an initial depth budget at pass-execute time: `max(tuning.maxOptimizationDepth, planInputDepth(plan) + tuning.optimizationDepthHeadroom)`. `planInputDepth` is a cheap one-shot walk over the plan to find the deepest path; a small headroom (e.g. `+16`) absorbs rewrite-introduced wrapping.
- Add a separate `maxRulesFired` budget tracked in `OptContext` (or pass-local) and incremented in `applyPassRules`. This catches runaway rewrites independently of input shape. A generous default (e.g. 100× the plan's node count) is fine — the goal is "fail loudly on a stuck rule," not a tight bound.
- Surface both budgets in `optimizer-tuning.ts` so they can be tuned per workload.

### Option B (simpler): iterative AND-chain traversal

The scalar walker descends into both arms of every AND with shallow work per node. An explicit stack avoids using the call stack for shape-only descent.

- Wherever `traverseTopDown` / `traverseBottomUp` descends into a node whose `nodeType` is a logical AND (or any scalar BinaryOpNode with chain-shape behavior), unroll the descent into a loop over a worklist. Apply rules at each unrolled level without incrementing the depth counter for the chain itself.
- Risk: the depth guard still fires on legitimate deep-CASE or deep-relational trees. This option is narrower; Option A is structurally cleaner.

## Tests

- Add a plan-time test (in `test/optimizer/` or extend `performance-sentinels.spec.ts`): a 50-conjunct WHERE on a 50-column CHECK-constrained table must plan successfully. Today this throws.
- The existing 25-conjunct sentinel can be restored to 50 conjuncts × 50 columns after the fix; update its comment to match.
- Targeted: add a unit test that constructs a deeply-nested AND tree (depth ~200) and asserts the traversal completes without throwing, while a synthetic always-rewrite test rule with no convergence trips the `maxRulesFired` budget instead (Option A only).

## TODO

- Decide between Option A and Option B (default to A unless implementation surprise pushes toward B).
- For Option A:
  - Add `planInputDepth(plan)` walker (cheap; one pass; no rule application).
  - Add `optimizationDepthHeadroom` and `maxRulesFired` to `OptimizerTuning` (`optimizer-tuning.ts`), with defaults.
  - Update `PassManager.executeStandardPass` to compute the effective depth budget at pass start.
  - Track `rulesFired` in the pass and assert against `maxRulesFired` inside `applyPassRules`.
- For Option B:
  - Identify scalar AND-chain shapes in `pass.ts` traversal; convert to iterative stack-based descent.
- Restore the 50×50 sentinel test and adjust its budget comment.
- `yarn build && yarn lint && yarn test` — full suite clean.
