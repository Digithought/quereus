---
description: Strengthen validation at system boundary entry points
dependencies: Type system (types/validation.ts, types/logical-type.ts), core API (core/database.ts, core/statement.ts)
---

## Goal

Ensure all public API entry points validate incoming data thoroughly and consistently, so internal code can trust data without re-checking. This is the "validate at the edge" half of the boundary-validation strategy.

## Boundary Points & Current State

### 1. Database.registerModule() — `core/database.ts:569`
**Current:** Only calls `checkOpen()`. No validation of `name` (empty string? special chars?) or `module` shape.
**Action:** Validate `name` is a non-empty string. Validate `module` has required methods (`create`, `connect`, `destroy`) as functions. Throw `MisuseError` on violations.

### 2. Database.registerFunction() — `core/database.ts:864`
**Current:** Only calls `checkOpen()`. The `FunctionSchema` is trusted blindly.
**Action:** Validate `schema.name` is a non-empty string. Validate `schema.numArgs` is an integer >= -1. Validate that the appropriate implementation function(s) exist (`implementation` for scalar/TVF, `stepFunction`+`finalizeFunction` for aggregates). Throw `MisuseError` on violations.

### 3. Database.registerCollation() — `core/database.ts:974`
**Current:** Calls `checkOpen()`, delegates to `registerCollation()` in comparison.ts. No validation that `name` is non-empty or that `func` is actually a function.
**Action:** Validate `name` is a non-empty string. Validate `func` is a function. Throw `MisuseError` on violations.

### 4. Database.registerType() — `core/database.ts:1006`
**Current:** Validates name matches `definition.name`. No validation of `definition.physicalType` or that required methods exist.
**Action:** Validate `definition.physicalType` is a valid `PhysicalType` enum value. Validate `definition.name` is a non-empty string. These are cheap checks that prevent confusing downstream errors.

### 5. Database.setOption() — `core/database.ts:937`
**Current:** Delegates to `DatabaseOptionsManager.setOption()` which validates against definitions. Adequate.
**No action needed.**

### 6. Statement.bind() — `core/statement.ts:213`
**Current:** Validates index >= 1, key type is string or number. Good.
**Action:** Add SqlValue type validation — reject values that aren't `null | string | number | bigint | boolean | Uint8Array`. This catches objects, functions, symbols, etc. that would produce confusing errors later. This is a boundary-only check that protects all downstream code.

### 7. Statement.bindAll() — `core/statement.ts:230`
**Current:** Validates input is array or object. Good structure.
**Action:** Same SqlValue validation as bind() — validate each value in the collection. Add a shared `assertSqlValue()` helper.

### 8. Plugin loading — `plugin-loader/src/plugin-loader.ts`
**Current:** `validatePluginUrl()` checks protocol and extension. `assertValidPluginModule()` checks default export is a function. Adequate.
**No action needed.**

### 9. registerPlugin() — `util/plugin-helper.ts:76`
**Current:** Calls individual registration methods. Those methods need strengthening (items 1-4 above).
**No action needed** beyond what's covered by items 1-4.

## Implementation Approach

Create a shared `assertSqlValue(value: unknown, context: string): asserts value is SqlValue` utility in `common/types.ts` or a new `common/assertions.ts`. Use it in `bind()` and `bindAll()`. Keep individual validation in each `register*` method to give clear error messages.

## TODO

- Add `assertSqlValue()` helper in `common/types.ts` or `common/assertions.ts`
- Validate `name` + `module` shape in `registerModule()`
- Validate `schema` shape in `registerFunction()`
- Validate `name` + `func` type in `registerCollation()`
- Validate `definition.physicalType` in `registerType()`
- Validate values in `bind()` and `bindAll()` using `assertSqlValue()`
- Add tests for each boundary validation (bad name, bad type, non-SqlValue, etc.)
