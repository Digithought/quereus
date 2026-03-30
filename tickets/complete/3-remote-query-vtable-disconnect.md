description: remote-query emitter — vtable disconnect after executePlan
files:
  packages/quereus/src/runtime/emit/remote-query.ts
  packages/quereus/test/vtab/remote-query-disconnect.spec.ts
  packages/quereus/test/vtab/test-query-module.ts
----
## What was built

`emitRemoteQuery` previously called `vtabModule.connect()` but never called `disconnectVTable()`
after iterating `table.executePlan()`. If the consumer broke early or an error occurred, the vtable
connection leaked.

### Fix (`remote-query.ts`)
- Replaced `yield*` delegation with explicit `for await...of` loop
- Wrapped in `try/finally` calling `await disconnectVTable(rctx, table)` — mirrors the pattern in
  `emitSeqScan` (`scan.ts:88-92`) and `dml-executor.ts`

## Review fixes
- Fixed indentation in `test-query-module.ts` (tabs per `.editorconfig`)
- Added `TestQueryTable.resetSharedData()` to prevent static data pollution across tests
- Replaced `console.log` with `createLogger` in `TestQueryTable.executePlan`
- Removed unused type imports (`RowOp`, `ConflictResolution`)

## Testing
- `remote-query-disconnect.spec.ts` — 2 tests:
  - Full iteration: verifies `disconnect()` called after consuming all rows
  - Early break: verifies `disconnect()` called when consumer breaks after one row
- All 8 vtab-related tests pass
- Build clean
