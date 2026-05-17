---
description: Review the removal of `OptimizationContext.withIncrementedDepth()` and the dead `depth` field, leaving `state.depthBudget` in `framework/pass.ts` as the single depth guard.
prereq:
files:
  - packages/quereus/src/planner/framework/context.ts
  - docs/optimizer.md
---

## What landed

Deleted dead depth-tracking from `OptimizationContext`. The pass-level
`state.depthBudget` in `framework/pass.ts:321-348` is now the single source
of truth for "maximum optimization depth"; the context no longer carries a
parallel (and unused) `depth` field with diverging semantics.

### `packages/quereus/src/planner/framework/context.ts`

- Removed `depth: number` from the `OptContext` interface.
- Removed the `public readonly depth: number = 0` constructor parameter
  from `OptimizationContext`. Constructor is now 5-arg
  (`optimizer, stats, tuning, phase, db`).
- Trimmed the constructor log line:
  `Created optimization context (phase: %s, depth: %d)` → `Created optimization context (phase: %s)`.
- Deleted `withIncrementedDepth()` entirely.
- Updated `withPhase` and `withContext` to drop the trailing `this.depth`
  argument they previously forwarded.
- Removed `'depth' in obj` from the `isOptContext` type-guard predicate.
- Dropped two now-unused imports: `StatusCode` from `../../common/types.js`
  and `quereusError` from `../../common/errors.js` (they were only
  referenced by the deleted depth-exceeded branch).

### `docs/optimizer.md` (≈line 1140)

Removed the `withIncrementedDepth()` example from the `class OptimizationContext`
illustration in the "Context Lifecycle" section. Replaced the inline NOTE
with a short paragraph below the code block pointing readers at the
pass-framework budget (`max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`
plus `maxRulesFired`) for the actual depth guard.

## Validation performed

- `yarn build` — clean across all packages.
- `yarn workspace @quereus/quereus run test` — **3175 passing** (≥ the
  3169 floor the ticket called out). No new failures.
- `grep -r withIncrementedDepth` returns only ticket files
  (active `implement/` ticket + archival `complete/optimizer-max-depth-wide-where.md`);
  no source code matches.
- `grep new OptimizationContext` returns only three callsites in
  `context.ts` itself, all matching the new 5-arg signature.

(The local code-search index reported stale hits because it had not
re-indexed the edits; verified via direct `grep` after the changes.)

## Things to confirm in review

- Imports: confirm `StatusCode` and `quereusError` are indeed unused in
  `context.ts` after the edit (no remaining `quereusError(...)` /
  `StatusCode.*` references). The lint pass during `yarn build` would have
  flagged unused symbols if any slipped through, but worth eyeballing.
- The `docs/optimizer.md` "Context Lifecycle" section: confirm the
  rewording still reads naturally and that the pointer to "Pass Framework"
  matches the section heading earlier in the doc (it does — see the
  pass-framework section above the "Multi-Pass" subheading).
- Archival ticket `tickets/complete/optimizer-max-depth-wide-where.md`
  still mentions `withIncrementedDepth`. Left untouched intentionally
  (completed tickets are historical record), but flagging in case the
  policy is otherwise.

## Known gaps

- I did not run `yarn test:store` or `yarn test:full` — the change is
  purely in the optimizer framework with no storage-layer interaction, so
  the default suite should be sufficient. Mentioning explicitly so the
  reviewer can decide.
- The code-search index was stale through my session; relied on `grep`
  for the final reference check. If the reviewer has a fresh index, a
  re-run of `find_references withIncrementedDepth` / `find_references .depth`
  scoped to `packages/quereus/src/planner/framework/%` is a worthwhile
  belt-and-suspenders confirmation.
