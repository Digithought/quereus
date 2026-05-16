---
description: Convert `PassManager.traverseTopDown` / `traverseBottomUp` to iterative (worklist) traversal so plans deeper than V8's JS stack don't crash the engine. Pre-existing risk, now reachable since the depth budget can scale up to match input depth.
prereq:
files:
  - packages/quereus/src/planner/framework/pass.ts
---

## Why

`framework/pass.ts` traversal is recursive JavaScript. The old hard cap of `maxOptimizationDepth = 50` made this safe in practice — any input deeper than 50 was rejected with a clear error before the call stack could grow. The recent input-scaled-budget change (ticket `optimizer-max-depth-wide-where`) lifted that ceiling: the per-pass budget is now `max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`, so a 10,000-deep input plan now happily descends 10,000 recursive frames.

V8's default JS stack is typically ~10–20k frames. A pathological or adversarial input (very deep nested CASE, deep recursive CTE shape, machine-generated boolean trees) can therefore now hit a `RangeError: Maximum call stack size exceeded` instead of a clean depth-budget error.

This is rare in practice — real plans rarely exceed a few hundred frames — but it is a hard crash rather than a controlled error when it does happen.

## What

Convert `traverseTopDown` and `traverseBottomUp` to iterative worklist algorithms (the same shape `planInputDepth` already uses for shape-only measurement). Rules still need to fire at each visited node, and the bottom-up variant needs the "process-children-first" ordering, so this is non-trivial but mechanical.

Once iterative, the depth-budget check can stay as-is (compared against the worklist's tracked depth), but the protection becomes about runaway *budget* rather than blowing the JS stack.

## Validation

- All existing pass-manager and framework tests continue to pass.
- A new targeted test: plan a 50,000-deep chain (well past V8's stack limit) under generous tuning — must complete without `RangeError` or stack overflow.
