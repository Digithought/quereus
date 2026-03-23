description: remote-query emitter — vtable disconnect after executePlan
dependencies: none
files:
  packages/quereus/src/runtime/emit/remote-query.ts
  packages/quereus/test/vtab/remote-query-disconnect.spec.ts
  packages/quereus/test/vtab/test-query-module.ts
----
## Summary

`emitRemoteQuery` called `vtabModule.connect()` but never called `disconnectVTable()` after
`yield*` of `table.executePlan()`. If the consumer breaks early or an error occurs, the vtable
connection leaks.

## Fix

- Replaced `yield*` delegation with explicit `for await...of` loop
- Wrapped in `try/finally` calling `await disconnectVTable(rctx, table)` — mirrors the pattern in `emitSeqScan` (`scan.ts:88-92`)
- `disconnectVTable` import was already present

## Test coverage

- `remote-query-disconnect.spec.ts` — two tests:
  - Full iteration: verifies `disconnect()` is called after consuming all rows
  - Early break: verifies `disconnect()` is called when consumer breaks after one row
- `TestQueryModule.lastConnectedTable` tracks the most recent table instance for assertions
- `TestQueryTable.disconnectCount` tracks how many times `disconnect()` was called
- Shared static data store in `TestQueryTable` ensures data persists across `connect()` calls

## Validation

- 2 new disconnect tests pass
- 8 vtab-related tests pass
- 298/299 full suite pass (1 pre-existing failure in `03.7-bigint-mixed-arithmetic.sqllogic`, unrelated)
- No regressions in existing remote-query optimizer tests
