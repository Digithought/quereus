description: findOrRangeMatch uses unsafe `as any` cast to access ranges property
dependencies: none
files:
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/vtab/best-access-plan.ts
  packages/quereus/src/planner/analysis/constraint-extractor.ts
----
In `MemoryTableModule.findOrRangeMatch()` (module.ts:383), the code accesses `(filter as any).ranges`
because the vtab-level `PredicateConstraint` type does not include the `ranges` field. The `ranges`
field exists only on the planner's extended `ExtractedConstraint` type (constraint-extractor.ts:49).

This works at runtime because the planner passes the extended constraint objects through, but
bypasses type safety. If the planner ever sends a plain `PredicateConstraint` for an OR_RANGE op,
`ranges` would be `undefined` and `rangeCount` would default to 2 — silently wrong.

Options:
1. Add an optional `ranges?: RangeSpec[]` field to the vtab `PredicateConstraint` interface
2. Create a discriminated union type for OR_RANGE constraints
3. Import the extended type directly (tighter coupling to planner)

## TODO
- Choose approach and add `ranges` to the vtab-level PredicateConstraint (option 1 is simplest)
- Remove the `as any` cast in findOrRangeMatch
- Add a type guard or runtime check for the ranges property
