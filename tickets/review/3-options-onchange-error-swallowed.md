description: DatabaseOptionsManager.setOption now propagates onChange errors and rolls back the stored value
dependencies: none
files:
  packages/quereus/src/core/database-options.ts
  packages/quereus/test/core-api-features.spec.ts
----
## Summary

`DatabaseOptionsManager.setOption()` was storing the new value before invoking the `onChange` listener, and `notifyListener()` was wrapping the listener call in a try-catch that swallowed errors. This allowed invalid values to persist silently when `onChange` handlers threw validation errors.

### Changes

**`packages/quereus/src/core/database-options.ts`**:
- `setOption()`: Added try-catch around `notifyListener()` call that rolls back `this.options.set(canonicalKey, oldValue)` on error, then re-throws.
- `notifyListener()`: Removed the internal try-catch so errors propagate naturally to `setOption`'s rollback handler.

### Test cases

**`packages/quereus/test/core-api-features.spec.ts`** — two new tests in `setOption() / getOption()`:
- `should reject invalid onChange value and roll back` — sets `default_column_nullability` to `'bogus'`, asserts `QuereusError` is thrown and the value remains `'not_null'`.
- `should accept valid onChange value` — sets `default_column_nullability` to `'nullable'`, confirms it sticks.

### Validation

- All 182 tests pass (1 pre-existing unrelated failure in `emit-missing-types.spec.ts`).
- The reproducing test fails before the fix and passes after.
