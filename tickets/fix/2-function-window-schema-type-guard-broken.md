description: isWindowFunctionSchema type guard can never return true; duplicate WindowFunctionSchema types
dependencies: none
files:
  packages/quereus/src/schema/function.ts
  packages/quereus/src/schema/window-function.ts
----
## Problem

### 1. Broken type guard (function.ts:164-166)

`isWindowFunctionSchema` can never return `true` because `isScalarFunctionSchema` matches the same runtime shape:

```typescript
// ScalarFunctionSchema has: implementation (function), returnType.typeClass === 'scalar'
// WindowFunctionSchema has: implementation (function), returnType.typeClass === 'scalar'
// At runtime these are indistinguishable

isScalarFunctionSchema(schema)  // returns true for WindowFunctionSchema too
isWindowFunctionSchema(schema)  // always false because !isScalarFunctionSchema is false
```

Any `WindowFunctionSchema` (from function.ts) passed to the type guards will be classified as a `ScalarFunctionSchema`.

### 2. Duplicate WindowFunctionSchema types

Two different interfaces named `WindowFunctionSchema` exist:

- **function.ts**: `extends BaseFunctionSchema` with `implementation` field — part of the `FunctionSchema` union
- **window-function.ts**: standalone with `argCount`, `requiresOrderBy`, `kind`, `step`, `final` fields — uses a separate global registry

These serve different purposes but share a name, causing confusion.

## Impact

If code ever creates a `WindowFunctionSchema` (function.ts variant) and tries to identify it via the type guards, it will be misclassified as scalar. Currently the impact may be latent if no code uses the function.ts variant.

## TODO

- [ ] Determine if `WindowFunctionSchema` in function.ts is actually used anywhere
- [ ] If used: add a discriminator field (e.g., `kind: 'window'`) to distinguish from scalar
- [ ] If unused: remove from the `FunctionSchema` union and the broken type guard
- [ ] Rename one of the two `WindowFunctionSchema` types to avoid confusion
- [ ] Add test coverage for function type guard correctness
