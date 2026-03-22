description: remote-query emitter — add try/finally with disconnectVTable after executePlan
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

## Fix applied

- Replaced `yield*` delegation with explicit `for await...of` loop
- Wrapped in try/finally calling `await disconnectVTable(rctx, table)` — mirrors the pattern in `emitSeqScan`
- Added `disconnectVTable` import from `../utils.js`

## Test coverage

- `remote-query-disconnect.spec.ts` — two tests:
  - Verifies `disconnect()` is called after full iteration of a remote query
  - Verifies `disconnect()` is called on early break (partial consumption)
- `TestQueryModule` / `TestQueryTable` enhanced with `disconnectCount` tracker and `lastConnectedTable` reference for assertions
- Shared static data store added to `TestQueryTable` so data persists across `connect()` calls

## TODO

- Review that fix matches emitSeqScan pattern and passes all tests
- Verify no regressions in existing remote-query optimizer tests
