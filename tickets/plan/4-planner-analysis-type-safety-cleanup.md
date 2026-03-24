description: Reduce `any` usage and improve type safety in planner analysis/stats/scopes modules
dependencies: none
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/src/planner/scopes/registered.ts
  packages/quereus/src/planner/scopes/global.ts
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/src/planner/stats/histogram.ts
----
## Scope

Several planner modules have type safety issues or code smells that should be addressed as a
batch cleanup.

### 1. predicate-normalizer.ts — `as any` casts

`rebuildAssociative` (line 150) and `tryCollapseOrToIn` (line 193) declare `scope: any`.
Lines 131-132 use `(node as any).expression` and `(node as any).scope`. Since `scope` is on
the PlanNode base class, and `expression` exists on all scalar node subtypes, these can be
properly typed using the existing type hierarchy (e.g. `ScalarPlanNode & { expression: AST.Expression }`
or a shared interface).

### 2. registered.ts — duplicate methods

`registerSymbol()` (line 32) and `subscribeFactory()` (line 40) are identical in behavior.
One should delegate to the other, or one should be removed. Check callers to determine which
name is canonical.

### 3. global.ts — DRY violation

Lines 25-28 and 55-57 duplicate the scalarType resolution pattern:
```ts
const scalarType: ScalarType = isScalarFunctionSchema(func)
    ? func.returnType
    : { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true };
```
Extract to a helper like `getFunctionScalarType(func)`.

### 4. histogram.ts — String() for distinct counting

`buildHistogram` line 99 uses `String(sortedValues[j])` to count distinct values in buckets.
This conflates types: numeric `1` and string `"1"` produce the same key. Consider using a
composite key like `typeof val + ':' + String(val)` or storing `[type, stringValue]`.

### 5. catalog-stats.ts — eslint-disable for `any`

Lines 284-334 have a blanket `eslint-disable @typescript-eslint/no-explicit-any`. Once the
introspection helpers are fixed (see fix ticket), the `any` casts should be replaced with
proper typed access using concrete node type imports.

## TODO

- Audit `as any` casts in predicate-normalizer.ts and replace with proper types
- Consolidate `registerSymbol`/`subscribeFactory` in registered.ts
- Extract shared scalarType helper in global.ts
- Fix String() distinct counting in histogram.ts
- Remove eslint-disable in catalog-stats.ts after introspection fix
