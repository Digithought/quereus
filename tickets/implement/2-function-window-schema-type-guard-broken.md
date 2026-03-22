description: Remove dead WindowFunctionSchema from function.ts union and fix type guards
dependencies: none
files:
  packages/quereus/src/schema/function.ts
  packages/quereus/src/schema/window-function.ts
  packages/quereus/src/func/builtins/schema.ts
  packages/quereus/test/function-type-guards.spec.ts
----

## Context

Two interfaces named `WindowFunctionSchema` exist:

- **function.ts** (lines 134-138): `extends BaseFunctionSchema` with `implementation` — placeholder, never instantiated, part of the `FunctionSchema` union
- **window-function.ts** (lines 4-16): standalone with `kind`, `step`, `final`, `argCount` — actively used via the global window registry

The `isWindowFunctionSchema` type guard (function.ts:164-166) can never return true because `isScalarFunctionSchema` matches the same runtime shape first. This is confirmed by a reproducing test at `test/function-type-guards.spec.ts`.

No code creates or registers instances of the function.ts variant. All window functions use `registerWindowFunction()` from window-function.ts. No creation helper (like `createWindowFunction`) exists in `func/registration.ts`.

## Fix

Remove the dead function.ts `WindowFunctionSchema` and its broken type guard. The window-function.ts `WindowFunctionSchema` stays as-is — it's the real one.

## TODO

- [ ] Phase 1: Remove dead code from function.ts
  - Remove `WindowFunctionSchema` interface (lines 134-138)
  - Remove it from the `FunctionSchema` union (line 147)
  - Remove `isWindowFunctionSchema` type guard (lines 164-166)
- [ ] Phase 2: Fix classifyFunction in schema.ts builtins
  - Remove import of `isWindowFunctionSchema` from `func/builtins/schema.ts` (line 8)
  - In `classifyFunction` (line 191), replace `isWindowFunctionSchema(funcSchema)` with a check against the window-function.ts registry: `isWindowFunction(funcSchema.name)` — import from `../../schema/window-function.js`
- [ ] Phase 3: Update the reproducing test
  - Remove the bug-documenting test case
  - Keep/add tests for the remaining three type guards (scalar, TVF, aggregate)
  - Add a test verifying that `classifyFunction` correctly classifies window functions via the registry
- [ ] Phase 4: Build and test
  - Run `yarn build` and `yarn test` to verify no regressions
  - Run typecheck to confirm no type errors from union change
