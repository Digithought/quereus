---
description: Review boundary validation strengthening at public API entry points
dependencies: none
---

## Summary

Strengthened validation at all public API boundary entry points so internal code can trust data without re-checking. All registration methods and parameter binding now validate inputs eagerly with clear `MisuseError` messages.

## Changes

### New utility (`common/types.ts`)
- `isSqlValue(value: unknown): value is SqlValue` — runtime type guard for SqlValue
- `describeSqlValueViolation(value: unknown): string` — descriptive label for error messages

### `Database.registerModule()` (`core/database.ts`)
- Validates `name` is a non-empty string
- Validates `module` is an object with `create`, `connect`, `destroy` as functions

### `Database.registerFunction()` (`core/database.ts`)
- Validates `schema` is an object
- Validates `schema.name` is a non-empty string
- Validates `schema.numArgs` is an integer >= -1
- Validates appropriate implementation functions exist (scalar/TVF: `implementation`; aggregate: `stepFunction` + `finalizeFunction`)

### `Database.registerCollation()` (`core/database.ts`)
- Validates `name` is a non-empty string
- Validates `func` is a function

### `Database.registerType()` (`core/database.ts`)
- Validates `name` is a non-empty string
- Validates `definition` is an object with non-empty `name`
- Validates `definition.physicalType` is a valid PhysicalType enum value (0-5)

### `Statement.bind()` and `Statement.bindAll()` (`core/statement.ts`)
- Validates each bound value is a valid SqlValue (null, string, number, bigint, boolean, Uint8Array)
- Rejects objects, functions, symbols, undefined with clear error messages

### Exports (`index.ts`)
- Exported `isSqlValue` for consumer use

## Testing

34 new tests in `test/boundary-validation.spec.ts` covering:
- Each registration method: bad name, null/missing module, missing methods, bad types
- `bind()`: object, function, symbol, undefined rejection; all valid SqlValue types accepted
- `bindAll()`: array and named-param variants with invalid and valid values

Full suite: 718 passing, 0 failures.

## Validation

- `tsc --noEmit` passes
- `npm run build` passes
- `npm test` — 718 passing, 7 pending (pre-existing), 0 failures
