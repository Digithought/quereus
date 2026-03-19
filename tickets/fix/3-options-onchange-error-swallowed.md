description: DatabaseOptionsManager.setOption swallows onChange validation errors, allowing invalid values to persist
dependencies: none
files:
  packages/quereus/src/core/database-options.ts
  packages/quereus/src/core/database.ts
----
In `DatabaseOptionsManager.setOption()`, the value is stored via `this.options.set()` **before** the `onChange` listener is invoked. The `notifyListener()` method wraps the `onChange` call in a try-catch that logs and swallows errors.

This means validation logic placed in `onChange` handlers (e.g., the `default_column_nullability` handler at database.ts:226 which throws for invalid values) silently fails — the invalid value is already stored by the time the error is caught.

Example: `db.setOption('default_column_nullability', 'bogus')` succeeds silently despite the onChange handler explicitly throwing for values other than `'nullable'` or `'not_null'`.

Fix: let errors from `onChange` propagate and roll back the stored value on failure:

```typescript
setOption(key: string, value: unknown): void {
    // ... resolve key, convert, check equality ...
    this.options.set(canonicalKey, convertedValue);
    try {
        this.notifyListener(canonicalKey, oldValue, convertedValue);
    } catch (error) {
        // Rollback on listener failure
        this.options.set(canonicalKey, oldValue);
        throw error;
    }
}
```

And update `notifyListener` to not catch errors internally.

- TODO: Update `setOption` to roll back value on `onChange` error
- TODO: Remove try-catch from `notifyListener` (let errors propagate)
- TODO: Add test: setOption with invalid value is rejected and value remains unchanged
