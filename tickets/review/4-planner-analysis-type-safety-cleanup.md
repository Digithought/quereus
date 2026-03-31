description: Reduce `any` usage and improve type safety in planner analysis/stats/scopes modules
dependencies: none
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/src/planner/scopes/registered.ts
  packages/quereus/src/planner/scopes/global.ts
  packages/quereus/src/planner/stats/histogram.ts
  packages/quereus/src/planner/building/constraint-builder.ts
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/planner/building/insert.ts
  docs/runtime.md
----

## Summary

### 1. predicate-normalizer.ts — Removed `as any` casts
- Added `import type { Scope }` and used it for `scope` parameters in `rebuildAssociative` and `tryCollapseOrToIn` (were `any`).
- Removed 7 `as any` casts that accessed `.expression` and `.scope` on `ScalarPlanNode` — the interface already has both properties (`.expression` directly, `.scope` inherited from `PlanNode`).

### 2. registered.ts — Removed duplicate `subscribeFactory`
- Removed the `subscribeFactory` method which was identical to `registerSymbol`.
- Updated 6 call sites across 3 files (constraint-builder.ts, foreign-key-builder.ts, insert.ts) to use `registerSymbol` instead.
- Updated docs/runtime.md code example accordingly.

### 3. global.ts — Extracted shared `getFunctionScalarType` helper
- Extracted duplicated 3-line `ScalarType` resolution into a module-level `getFunctionScalarType(func)` helper.
- Used in both `resolveSymbol` and `findUnqualifiedName`.

### 4. histogram.ts — Type-aware distinct counting
- Changed `String(val)` to `typeof val + ':' + String(val)` so numeric `1` and string `"1"` are counted as distinct values.

## Testing notes
- Build passes
- All tests pass
- No new lint issues introduced (pre-existing warnings in unrelated files unchanged)
- Key test areas: predicate normalization (OR-to-IN collapse), constraint building, foreign key constraints, inserts with mutation context, histogram building
