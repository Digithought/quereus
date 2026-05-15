---
description: Three small follow-ups surfaced by reviewing the predicate-contradiction rule. None of them is a regression; each is a sharp edge worth filing so they aren't lost.
prereq:
files:
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/src/planner/analysis/sat-checker.ts
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts
---

## 1. `maxOptimizationDepth = 50` is too tight for wide WHERE clauses

Symptom: a SELECT with ~50+ conjuncts in WHERE (left-associative AND tree depth ≥ 49) fails to plan with `Maximum optimization depth exceeded: 50` from `pass.ts:285`. Reproduces today with a wide CHECK-constrained table and one conjunct per column; surfaced while fixing the predicate-contradiction sentinel test (see `tickets/complete/2-optimizer-predicate-contradiction-detection.md` review findings #2/#3).

Two candidate fixes:
- Iterative traversal for AND-chains — the scalar walker descends into both arms of every AND, but the work per node is shallow. An explicit stack avoids using the call stack for shape-only descent.
- Or: scale the depth ceiling by input size, with a separate "rules-fired" budget to catch runaway rewrites independently of input depth.

User-visible bar: a wide table with a wide WHERE should plan.

## 2. `x IN ()` should fold to `unsat` rather than `unknown`

`analysis/sat-checker.ts` absorbs `InNode` and bails to `markUnknownForColumns` when `conj.values` is empty (with a comment that the parser usually rejects this). `IN ()` is provably empty *iff* the parser ever produces it. Tighten the bail-out to `return 'unsat'` (or push an empty `allowedValues` and let the existing decision step decide) so we don't leave that fold on the table if it ever shows up.

Also worth pinning a unit test for IN-list with NULL entries while in the neighborhood (`x IN (1, NULL)` → `[1]` after NULL filtering, which is the correct SQL semantics under three-valued logic, but not currently covered).

## 3. `Filter(_, lit-null)` is not folded

`rule-filter-contradiction.ts:44` short-circuits when the predicate is `LiteralNode` with `value === false`. A literal `NULL` predicate is also provably empty under SQL three-valued logic (filter treats NULL as FALSE), but falls through to the checker, which sees no column refs and returns `sat`. Either:
- Extend the guard to `value === false || value === null` and let the cascade collapse via the empty-folding rule's `Filter(_, false)` path, or
- Emit `EmptyRelationNode` directly from this rule for both shapes.

Either approach is a couple of lines.

## End
