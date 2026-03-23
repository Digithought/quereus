description: Removed dead WindowFunctionSchema from function.ts union, fixed classifyFunction to use window registry
dependencies: none
files:
  packages/quereus/src/schema/function.ts
  packages/quereus/src/schema/window-function.ts
  packages/quereus/src/func/builtins/schema.ts
  packages/quereus/test/function-type-guards.spec.ts
----
## Summary

The `WindowFunctionSchema` interface in `function.ts` was runtime-indistinguishable from `ScalarFunctionSchema` (both have `implementation: function` and `returnType.typeClass === 'scalar'`), making `isWindowFunctionSchema` always return `false`. A separate, actively-used `WindowFunctionSchema` in `window-function.ts` serves the actual window function system via a global registry.

## Changes

- **Removed** (prior pass) the unused `WindowFunctionSchema` interface, its union membership, and broken `isWindowFunctionSchema` type guard from `function.ts`
- **Added** `isWindowFunction` import from `window-function.ts` to `func/builtins/schema.ts`
- **Fixed** `classifyFunction` to check the window function registry first: `if (isWindowFunction(funcSchema.name)) return 'window'`
- **Exported** `classifyFunction` for testability
- **Added** `classifyFunction` tests verifying scalar, TVF, aggregate, and window classification (window test registers a function in the window registry and confirms it's classified as `'window'`)

## Testing notes

- `function-type-guards.spec.ts`: 8 passing tests — 4 type guard tests + 4 classifyFunction tests
- TypeScript type check passes clean
- Full test suite: 329 passing (1 pre-existing unrelated failure in `10.1-ddl-lifecycle.sqllogic`)

## Use cases for validation

- Create each function schema type (scalar, TVF, aggregate) and verify `classifyFunction` returns the correct string
- Register a function name in the window registry and verify `classifyFunction` returns `'window'` even when the schema is scalar-shaped
- Verify each type guard matches exactly one function type (no cross-matches)
- The `window-function.ts` registry (`resolveWindowFunction`/`isWindowFunction`) is unaffected
