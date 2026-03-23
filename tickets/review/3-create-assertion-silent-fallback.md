description: Replace silent fallback in CREATE ASSERTION with error when expression stringify fails
dependencies: none
files:
  packages/quereus/src/runtime/emit/create-assertion.ts
  packages/quereus/test/emit-create-assertion.spec.ts
  packages/quereus/test/logic/95-assertions.sqllogic
----

## Summary

In `emitCreateAssertion`, the catch block around `expressionToString(plan.checkExpression)` previously silently set `violationSql = 'select 1 where false'` — creating a no-op assertion that never fires. This was a data integrity risk: users believed their constraint was enforced when it wasn't.

## Fix

The catch block now throws a `QuereusError` with `StatusCode.ERROR`, including the assertion name and the original error as `cause`. This ensures CREATE ASSERTION fails loudly when expression stringification can't produce valid SQL.

Key code (`create-assertion.ts:25-31`):
```typescript
} catch (e) {
    throw new QuereusError(
        `Cannot create assertion '${plan.name}': failed to convert check expression to SQL`,
        StatusCode.ERROR,
        e instanceof Error ? e : undefined
    );
}
```

## Testing

- **Unit test** (`test/emit-create-assertion.spec.ts`): Constructs a synthetic expression with null children that causes `expressionToString` to throw, then verifies `emitCreateAssertion` wraps it in a `QuereusError` with message containing the assertion name and failure reason.
- **Sqllogic tests** (`test/logic/95-assertions.sqllogic`): Happy-path assertion creation and violation detection — all passing.
- Full suite: 182 passing, 1 pre-existing failure (unrelated `emit-missing-types` test).

## Review checklist
- Verify error message is clear and actionable
- Confirm existing assertion sqllogic tests cover happy paths adequately
- Check that the error preserves the original cause for debugging
