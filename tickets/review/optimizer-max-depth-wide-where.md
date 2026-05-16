---
description: Scale the optimizer's per-pass depth budget with the input plan's measured depth so wide-WHERE / deep-CASE inputs no longer trip the depth guard; add a separate `maxRulesFired` budget that catches runaway rule rewrites independent of input shape.
prereq:
files:
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/optimizer/pass-manager.spec.ts
  - packages/quereus/test/planner/framework.spec.ts
  - packages/quereus/test/performance-sentinels.spec.ts
  - docs/optimizer.md
---

## What changed

Implemented **Option A** from the ticket: scale-by-input depth budget + separate rules-fired budget.

### Tuning (`optimizer-tuning.ts`)
Two new fields on `OptimizerTuning`:
- `optimizationDepthHeadroom: number` — extra depth allowance added on top of measured input depth (default **16**).
- `maxRulesFired: number` — per-pass cap on rule firings to catch runaway rewrites (default **100000**).

`maxOptimizationDepth` is preserved as a **floor** rather than the active ceiling — its doc-comment now says so.

### PassManager (`framework/pass.ts`)
- New `planInputDepth(plan)` — iterative DFS that returns the max depth of any leaf. Iterative (worklist) so we cannot stack-overflow on the very inputs we are trying to plan.
- New private `PassState { depthBudget, rulesFired, maxRulesFired }`. Carried alongside `OptContext` through `traverseTopDown` / `traverseBottomUp` / `applyPassRules`. Pass-local so it resets between passes (matches the per-pass `optimizedNodes.clear()`).
- `executeStandardPass` computes `depthBudget = max(tuning.maxOptimizationDepth, planInputDepth(plan) + tuning.optimizationDepthHeadroom)` once at pass entry.
- `assertOptimizationDepth(state, depth)` checks against `state.depthBudget` instead of `context.tuning.maxOptimizationDepth`.
- `applyPassRules` increments `state.rulesFired` after a successful rewrite and throws `Optimization pass <id> exceeded maxRulesFired (...)` when the budget is crossed.

### Test updates
- `test/optimizer/pass-manager.spec.ts`: the existing `enforces maxOptimizationDepth during pass traversal` test now passes `optimizationDepthHeadroom: 0` so the guard still triggers on the 20-deep chain (otherwise the new input-scaled budget would absorb it). Added two new tests: (a) a 200-deep chain plans cleanly under default tuning; (b) a non-converging rule on a 200-node chain trips `maxRulesFired: 50` with a `/maxRulesFired/` message.
- `test/planner/framework.spec.ts`: the analogous `throws when max optimization depth is exceeded` test was updated the same way (`optimizationDepthHeadroom: 0`).
- `test/performance-sentinels.spec.ts`: the previously-shrunk `25-column SELECT … under budget` test was restored to **50 conjuncts × 50 columns**, the original target. Threshold bumped from 5000 ms → 10000 ms for the larger workload; comment updated to point at `planInputDepth` rather than the old fixed-50 ceiling.

### Docs
- `docs/optimizer.md` § "Pass Framework" — the depth-safety bullet now describes the input-scaled budget formula and mentions `maxRulesFired`.

## How to validate

- `yarn build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — **3169 passing, 0 failing** on the quereus package.
- The two `yarn test` failures in `@quereus/sample-plugins` (`key_value_store virtual table > supports delete / supports update`) reproduce on `main` without these changes — they are **pre-existing and unrelated** to this ticket. Worth filing separately but out of scope here.
- Targeted greps that still pass under the new semantics:
  - `--grep "Performance sentinels"` → 16 passing (includes the restored 50×50 case).
  - `--grep "Planner Framework"` → 74 passing.
  - `--grep "PassManager"` → 15 passing (3 depth/rules-fired tests).

## Use cases / validation points for the reviewer

The reviewer should treat the following as the floor, not the ceiling:

1. **Restored sentinel (`Performance sentinels > Planning time > plans a 50-column SELECT…`)** — the canonical case the original symptom describes. It now plans 50 conjuncts × 50 columns × 50 iterations without throwing.
2. **New `depth budget scales with input plan depth` (pass-manager.spec)** — 200-deep chain under default tuning must not throw.
3. **New `maxRulesFired trips when total rule firings exceed the budget`** — verifies the secondary budget actually fires. Note: this test counts firings across distinct nodes in a long chain, because the existing `inheritVisitedRules` machinery breaks per-node A↔B cycles (visited-rule inheritance already converges them in O(1) firings). That's why the test uses a long chain rather than a tight ping-pong cycle.

## Known gaps / things to scrutinize

- **Default `maxRulesFired: 100000`** is a guess at "generous enough that real plans never trip it." I did **not** instrument real workloads to measure typical firings/pass. If the reviewer suspects a real plan could legitimately need >100k firings, raise it — the value should be empirical, not picked from thin air.
- **`maxRulesFired` semantics**: I count rule firings (i.e. successful rewrites that change identity). I do **not** count rule *attempts* (matches that returned `null` or `=== currentNode`). The ticket said "tracked in `OptContext` (or pass-local) and incremented in `applyPassRules`"; I chose pass-local. If you prefer cross-pass cumulative tracking (e.g. for a "total budget across all passes" guarantee), that's a different design.
- **`planInputDepth` runs once per pass.** For a 5-pass standard optimizer over the same plan, that's 5 walks of the input. The walks are O(n) and shape-only, but if you'd rather memoize on the optimization context (or hand the same number to all passes via the first pass that computes it), that's a follow-up. Probably not worth it — the absolute cost is small and the cleaner per-pass independence is worth more.
- **Naturally deepening rules**: if a rule wraps the plan in a new parent node (deepening the tree by 1), and the same rule fires N times in cascade across the children, the effective depth at the deepest visited node could exceed `planInputDepth + headroom`. The default `headroom: 16` is the budget for this; `maxRulesFired` is the backstop. Whether 16 is the right number depends on which rules are actually structural — I didn't audit them. If a reviewer can identify a deepening-by-K cascading rule, that's a real follow-up.
- **Existing depth-guard tests now require explicit `optimizationDepthHeadroom: 0`**. This is an intentional behaviour change — the *purpose* of the new design is that the old `maxOptimizationDepth` alone is no longer the ceiling. Reviewer should sanity-check that the existing-test edits read as "still testing the guard works" rather than "watered down".
- **No new optimizer rules** were touched. Only the framework. If the reviewer wants to actually plan/execute a 50-column / 50-conjunct query end-to-end (not just plan it), that path is exercised by the restored sentinel.

## Out of scope / NOT done

- I did **not** implement Option B (iterative AND-chain traversal). Option A subsumes the symptom and is structurally cleaner; the ticket explicitly says default to A. If reviewer thinks deep-CASE specifically still risks a real stack overflow under Option A's headroom regime, Option B (or just bumping headroom further / making it dynamic) could be layered on top.
- The pre-existing `OptimizationContext.withIncrementedDepth()` method (in `context.ts`) is unused outside that file. I left it alone — the same `maxOptimizationDepth` field is doing the same thing in two places, but reconciling them is not on-ticket.
