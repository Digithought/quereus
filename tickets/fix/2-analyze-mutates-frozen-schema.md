description: ANALYZE emitter directly mutates potentially frozen TableSchema objects
dependencies: none
files:
  packages/quereus/src/runtime/emit/analyze.ts
  packages/quereus/src/schema/table.ts
----
In `emitAnalyze`, statistics are assigned directly onto the `TableSchema` object via a cast:

```typescript
(tableSchema as { statistics?: typeof stats }).statistics = stats;
```

This bypasses TypeScript's readonly/frozen protections. If `TableSchema` objects are frozen (e.g., via `Object.freeze`), this mutation silently fails in non-strict mode or throws in strict mode.

Other DDL emitters (e.g., `add-constraint.ts`) correctly create new schema objects with spread syntax and replace them in the catalog. ANALYZE should follow the same pattern.

**Fix approach**: Create a new TableSchema with the statistics property and replace it in the schema catalog, consistent with how other DDL emitters update schema.

## TODO
- Replace direct mutation with immutable update pattern
- Register updated schema via `schema.addTable(updatedTableSchema)`
- Notify change listeners
