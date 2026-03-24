description: Replaced silent fallback in CREATE ASSERTION with loud error on expression stringify failure
files:
  packages/quereus/src/runtime/emit/create-assertion.ts
  packages/quereus/test/emit-create-assertion.spec.ts
  packages/quereus/test/logic/95-assertions.sqllogic
----

## What was built

In `emitCreateAssertion`, the catch block around `expressionToString(plan.checkExpression)` previously silently set `violationSql = 'select 1 where false'` — creating a no-op assertion that never fired. This was a data integrity risk.

The catch block now throws a `QuereusError(StatusCode.ERROR)` with the assertion name and the original error as `cause`, so CREATE ASSERTION fails loudly when expression stringification can't produce valid SQL.

## Testing

- **Unit test** (`emit-create-assertion.spec.ts`): Constructs a synthetic binary expression with null children that causes `expressionToString` to throw; verifies `emitCreateAssertion` wraps it in a `QuereusError` with correct message containing assertion name and failure reason.
- **Sqllogic tests** (`95-assertions.sqllogic`): 12 scenarios covering basic DDL, commit-time violations, single/multi-table assertions, aggregates, rollback, savepoints, IF EXISTS, duplicates, autocommit, unrelated tables, explain diagnostics, and multiple assertions.
- Full suite: 1013 passing, 0 failures.

## Review notes

- Error message is clear and actionable
- Original cause is preserved via `QuereusError` constructor's `cause` parameter
- `e instanceof Error ? e : undefined` guard correctly matches the typed `cause?: Error` parameter
- No other code quality issues found
