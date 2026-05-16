---
description: `OptimizationContext.withIncrementedDepth()` is a second depth-guard mechanism using the same `tuning.maxOptimizationDepth` field as the pass framework, but with the old single-knob semantics. It is unused outside `context.ts` itself. Either delete it or reconcile it with the pass-level budget so `maxOptimizationDepth` has one meaning.
prereq:
files:
  - packages/quereus/src/planner/framework/context.ts
---

## Why

Surfaced during the review of `optimizer-max-depth-wide-where`. The new pass-level budget formula is
`max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`,
but `OptimizationContext.withIncrementedDepth()` (`framework/context.ts:106`) still throws on `this.depth >= this.tuning.maxOptimizationDepth` — i.e. the raw single-knob check the framework deprecated.

That method (and the `depth` field it tracks) appears to be unused outside `context.ts`:
- `withPhase` and `withContext` propagate `this.depth` mechanically.
- No external caller invokes `withIncrementedDepth()` in `src/` or `test/`.

So today it is dead weight — but it is also confusing dead weight, because a future reader looking at `maxOptimizationDepth` will see two competing implementations with different semantics.

## Options

1. **Delete.** Remove `withIncrementedDepth()`, the `depth` constructor parameter, and the `depth` field from `OptContext` / `OptimizationContext`. Adjust call sites in `withPhase` / `withContext` that thread `depth` through.

2. **Reconcile.** Keep the method but switch its check to a shared `effectiveDepthBudget(context, plan)` helper so both pass-level traversal and any future direct callers use the same budget. This only pays off if someone actually intends to use `withIncrementedDepth()`.

Default to option 1 unless a near-term consumer for `withIncrementedDepth()` exists.

## Validation

- `yarn build` clean.
- `yarn workspace @quereus/quereus run test` clean (3169+ passing).
- `grep -r withIncrementedDepth packages/quereus/src packages/quereus/test` returns only the definition site.
