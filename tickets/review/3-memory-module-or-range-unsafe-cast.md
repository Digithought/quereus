description: Remove unsafe `as any` cast for ranges in MemoryTableModule.findOrRangeMatch
dependencies: none
files:
  packages/quereus/src/vtab/best-access-plan.ts
  packages/quereus/src/planner/analysis/constraint-extractor.ts
  packages/quereus/src/vtab/memory/module.ts
----
## Summary

The vtab-level `PredicateConstraint` interface in `best-access-plan.ts` lacked a `ranges` field,
forcing `findOrRangeMatch` in `module.ts` to use `(filter as any).ranges` to access range data
from OR_RANGE constraints. This bypassed type safety — if the planner ever sent a plain
`PredicateConstraint` without ranges, the code would silently default to `rangeCount = 2`.

## Changes

1. **best-access-plan.ts** — Added vtab-level `RangeSpec` interface (with `lower`/`upper` bounds
   using `op` and `value` only, no planner-specific `valueExpr`) and added optional `ranges?: RangeSpec[]`
   to `PredicateConstraint`.

2. **constraint-extractor.ts** — The planner's `RangeSpec` now extends the vtab `VtabRangeSpec`,
   adding the `valueExpr` field for planner use. This maintains the type hierarchy cleanly.

3. **module.ts** — Removed the `as any` cast. `findOrRangeMatch` now accesses `filter.ranges`
   directly with full type safety.

## Testing

- OR_RANGE queries exercise this path at runtime; existing tests pass.
- The 1 failing test (`emit-missing-types.spec.ts:30`) is pre-existing and unrelated.
- Type safety is now enforced at compile time — if `ranges` is absent on an OR_RANGE constraint,
  the default `rangeCount = 2` still applies, but the type system now makes this explicit.
