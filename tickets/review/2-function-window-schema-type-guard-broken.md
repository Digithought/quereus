description: Removed dead WindowFunctionSchema from function.ts FunctionSchema union and broken isWindowFunctionSchema type guard
dependencies: none
files:
  packages/quereus/src/schema/function.ts
  packages/quereus/src/func/builtins/schema.ts
  packages/quereus/test/function-type-guards.spec.ts
----
## Summary

The `WindowFunctionSchema` interface in `function.ts` was marked "for future use" and was runtime-indistinguishable from `ScalarFunctionSchema` (both have `implementation: function` and `returnType.typeClass === 'scalar'`). This made the `isWindowFunctionSchema` type guard always return `false`.

A separate, actively-used `WindowFunctionSchema` in `window-function.ts` (with `kind`, `step`, `final`, `argCount` fields) serves the actual window function system — it was never part of the `FunctionSchema` union and was unaffected.

## Changes

- **Removed** the unused `WindowFunctionSchema` interface from `function.ts`
- **Removed** it from the `FunctionSchema` union (now: `ScalarFunctionSchema | TableValuedFunctionSchema | AggregateFunctionSchema`)
- **Removed** the broken `isWindowFunctionSchema` type guard
- **Updated** `schema.ts` builtins `classifyFunction` to remove the dead `isWindowFunctionSchema` call
- **Updated** `function-type-guards.spec.ts` — removed the bug-documenting test, added an "each function matches exactly one type guard" coverage test

## Testing notes

- `function-type-guards.spec.ts`: 4 passing tests verifying each type guard correctly identifies its type and no cross-matches occur
- Full test suite: 182 passing (1 pre-existing unrelated failure in `emit-missing-types.spec.ts`)
- Build passes clean

## Use cases for validation

- Create each function schema type (scalar, TVF, aggregate) and verify the correct type guard returns true
- Verify no function matches more than one type guard
- The `window-function.ts` `WindowFunctionSchema` (the real one) continues to work via its own `resolveWindowFunction`/`isWindowFunction` registry — completely independent of the `FunctionSchema` union
