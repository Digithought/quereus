description: DatabaseOptionsManager.setOption propagates onChange errors and rolls back the stored value
files:
  packages/quereus/src/core/database-options.ts
  packages/quereus/test/core-api-features.spec.ts
  packages/quereus/test/logic/43-default-nullability.sqllogic
----
## What was built

`setOption()` in `DatabaseOptionsManager` now wraps the `notifyListener()` call in a try-catch that rolls back `this.options.set(canonicalKey, oldValue)` on error, then re-throws. The internal try-catch in `notifyListener()` was removed so errors propagate naturally.

## Review notes

- During review, moved the log statement after the try-catch so the "changed" message only fires on successful notifications (avoids misleading log on rollback).
- The rollback only covers the options map; if an onChange handler has partial side-effects before throwing, those are the handler's responsibility. This is the correct boundary.

## Tests

- `core-api-features.spec.ts` — "should reject invalid onChange value and roll back": sets `default_column_nullability` to `'bogus'`, asserts `QuereusError` thrown and value remains `'not_null'`.
- `core-api-features.spec.ts` — "should accept valid onChange value": sets `default_column_nullability` to `'nullable'`, confirms it sticks.
- `43-default-nullability.sqllogic` — exercises the pragma end-to-end including switching modes.
- 329/329 passing (1 pre-existing unrelated failure in DDL lifecycle test).
