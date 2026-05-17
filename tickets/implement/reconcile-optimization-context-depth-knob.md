---
description: Delete the unused `OptimizationContext.withIncrementedDepth()` / `depth` field that duplicates `tuning.maxOptimizationDepth` semantics. The live budget is the pass-level `state.depthBudget` (`framework/pass.ts:321-348`), so the context-level depth machinery is dead code that confuses readers about what `maxOptimizationDepth` means.
prereq:
files:
  - packages/quereus/src/planner/framework/context.ts
---

## Background

Two depth-guard mechanisms read `tuning.maxOptimizationDepth`:

1. **Pass-level (live)** — `OptPassRunner.traversePass` computes
   `depthBudget = max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`
   and asserts against `state.depthBudget` per worklist frame
   (`framework/pass.ts:321-348`, `assertOptimizationDepth` and the iterative
   top-down / bottom-up traversals).

2. **Context-level (dead)** — `OptimizationContext.withIncrementedDepth()`
   throws on `this.depth >= this.tuning.maxOptimizationDepth`
   (`framework/context.ts:106-109`). This is the old single-knob check; it
   ignores the headroom formula and is **not invoked anywhere** outside
   `context.ts` itself.

Confirmed via `find_references withIncrementedDepth` (only the definition
site matches) and `find_references .depth` scoped to `packages/quereus/%`
(only `context.ts` reads/writes `OptContext.depth`; `pass.ts` uses its own
frame-local `depth`, unrelated to the context field).

Leaving the dead path in place means a reader sees two different
implementations of "max optimization depth" with different semantics. Delete
it so the pass-level budget is the single source of truth.

## Changes — `packages/quereus/src/planner/framework/context.ts`

- Remove `depth: number` from the `OptContext` interface.
- Remove the `public readonly depth: number = 0` constructor parameter from
  `OptimizationContext`.
- Drop `depth` from the log line in the constructor
  (`log('Created optimization context (phase: %s, depth: %d)', ...)` →
  `log('Created optimization context (phase: %s)', phase)`).
- Delete `withIncrementedDepth()` entirely.
- In `withPhase` and `withContext`, drop the trailing `this.depth` argument
  passed to the inner `new OptimizationContext(...)` calls (the parameter
  itself is gone).
- In `isOptContext`, remove the `'depth' in obj` clause.

No other files should need edits — `find_references` confirms nothing else
reads or constructs against the `depth` field.

## Validation

- `yarn build` clean.
- `yarn workspace @quereus/quereus run test` clean (3169+ passing — match
  the count on `main` for this branch; new failures must be investigated,
  not normalized away).
- `find_references withIncrementedDepth` returns zero hits after the edit.
- `find_references` for `.depth` scoped to
  `packages/quereus/src/planner/framework/%` shows only the unrelated
  `frame.depth` / `state.depthBudget` uses in `pass.ts`.

## TODO

- Edit `packages/quereus/src/planner/framework/context.ts` per the
  "Changes" section above.
- Run `yarn build` from the repo root; fix any TypeScript fallout (there
  should be none — the field is private to this file in practice, but
  TypeScript will catch any straggler).
- Run `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/ctxdepth-test.log`
  and confirm green.
- Re-verify via `find_references` that `withIncrementedDepth` and
  `OptContext.depth` have no surviving consumers.
