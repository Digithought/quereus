description: remote-query emitter missing vtable disconnect after executePlan — resource leak
dependencies: none
files:
  packages/quereus/src/runtime/emit/remote-query.ts
  packages/quereus/src/runtime/emit/scan.ts (reference pattern)
  packages/quereus/src/runtime/utils.ts (disconnectVTable)
----
## Defect

`emitRemoteQuery` calls `vtabModule.connect()` to obtain a table instance, then delegates row production to `table.executePlan()` via `yield*`. The vtable instance is never disconnected afterward.

Contrast with `emitSeqScan`, which wraps its yield loop in try/finally and calls `await disconnectVTable(runtimeCtx, vtabInstance)` in the finally block.

If the consumer breaks out of the async iterator early or an error occurs, the vtable connection leaks.

## Fix

Wrap the `yield*` in a try/finally and call `disconnectVTable` in the finally block. The `yield*` delegation needs to be replaced with an explicit `for await...of` to allow the try/finally pattern:

```typescript
async function* run(rctx: RuntimeContext): AsyncIterable<Row> {
    // ... existing connect logic ...
    try {
        for await (const row of table.executePlan(rctx.db, plan.source, plan.moduleCtx)) {
            yield row;
        }
    } finally {
        await disconnectVTable(rctx, table);
    }
}
```

## TODO

- Add try/finally with disconnectVTable in remote-query emitter
- Verify test coverage for remote query path
