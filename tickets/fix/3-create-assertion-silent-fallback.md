description: CREATE ASSERTION silently creates non-functional assertion when expression stringify fails
dependencies: none
files:
  packages/quereus/src/runtime/emit/create-assertion.ts
  packages/quereus/src/emit/ast-stringify.ts
----
In `emitCreateAssertion`, when `expressionToString(plan.checkExpression)` throws (lines 22-29), the catch block sets `violationSql = 'select 1 where false'` — an assertion that never detects violations. The user gets a successfully created assertion that provides no protection.

This is a data integrity risk: the user believes their multi-table constraint is enforced, but the assertion is a no-op.

**Fix approach**: Throw an error instead of silently falling back. If the expression can't be stringified to SQL, the assertion can't work, and the user should be told.

```typescript
} catch (e) {
    throw new QuereusError(
        `Cannot create assertion '${plan.name}': failed to convert check expression to SQL`,
        StatusCode.ERROR,
        e instanceof Error ? e : undefined
    );
}
```

## TODO
- Replace silent fallback with QuereusError throw
- Add test for assertion creation with complex/unsupported expression
