description: ANALYZE emitter now uses immutable update pattern instead of mutating frozen TableSchema
dependencies: none
files:
  packages/quereus/src/runtime/emit/analyze.ts
  packages/quereus/test/optimizer/statistics.spec.ts
----

## Summary

The `emitAnalyze` emitter was directly mutating `TableSchema` objects via a cast:
```typescript
(tableSchema as { statistics?: typeof stats }).statistics = stats;
```

This bypasses TypeScript's readonly protections and throws in strict mode (ES modules) when the `TableSchema` is frozen — e.g., after ALTER TABLE ADD COLUMN, which produces `Object.freeze()`-d schemas via the memory module.

The consequence: ANALYZE silently fails (caught by the catch block) and produces no output for any table with a frozen schema. Statistics are never persisted.

## Fix

Replaced direct mutation with the immutable spread + `schema.addTable()` pattern used by all other DDL emitters (add-constraint, alter-table, create-index, etc.):

1. Collect statistics from VTab or scan
2. Create new `TableSchema` via `{ ...tableSchema, statistics: stats }`
3. Register via `schema.addTable(updatedTableSchema)` (overwrites existing entry)
4. Notify change listeners via `schemaManager.getChangeNotifier().notifyChange()`

## Tests

Two new tests added to `packages/quereus/test/optimizer/statistics.spec.ts`:

- **"ANALYZE persists statistics on the catalog schema"**: Verifies that after ANALYZE, `db.schemaManager.findTable()` returns a schema with `statistics` populated
- **"ANALYZE works on frozen schema objects (e.g. after ALTER TABLE)"**: Creates a table, does ALTER TABLE ADD COLUMN (which freezes the schema), then runs ANALYZE and verifies statistics are correctly persisted despite the frozen schema

## Validation

- All 37 statistics tests pass
- Build passes with no type errors
- The one pre-existing test failure (`renameTable` stringifier) is unrelated
