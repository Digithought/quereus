description: Replace silent fallback in CREATE ASSERTION with error when expression stringify fails
dependencies: none
files:
  packages/quereus/src/runtime/emit/create-assertion.ts
  packages/quereus/test/emit-create-assertion.spec.ts
  packages/quereus/test/logic/95-assertions.sqllogic
----

## Summary

In `emitCreateAssertion`, when `expressionToString(plan.checkExpression)` threw, the catch block silently set `violationSql = 'select 1 where false'` — creating an assertion that never detects violations. This is a data integrity risk: the user believes their constraint is enforced, but the assertion is a no-op.

## Fix Applied

Replaced the silent fallback with a `QuereusError` throw so the user is informed that their assertion could not be created:

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

- **New unit test** (`test/emit-create-assertion.spec.ts`): Constructs a synthetic expression with null children that causes `expressionToString` to throw, then verifies `emitCreateAssertion` wraps it in a `QuereusError` with message containing the assertion name and failure reason.
- **Existing tests** (`test/logic/95-assertions.sqllogic`): All passing — normal assertion creation unaffected.
- Full suite: 928 passing, 3 pending.

## TODO
- Review: verify error message is clear and actionable
- Review: confirm existing assertion sqllogic tests cover the happy paths adequately
