description: FK parent-side checks and cascade actions now respect schema boundaries
dependencies: none
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/utils.ts
  packages/quereus/src/vtab/memory/table.ts
  packages/quereus/test/logic/41-fk-cross-schema.sqllogic
----
## What was built

### Fix 1: FK schema comparison (primary ticket fix)

Added schema comparison after table name comparison in two locations:

- `foreign-key-builder.ts` — `buildParentSideFKChecks`: after matching `fk.referencedTable` to `tableSchema.name`, compares `fk.referencedSchema ?? childTable.schemaName` to `tableSchema.schemaName`. Prevents planner from generating parent-side FK constraint checks against tables in the wrong schema.

- `foreign-key-actions.ts` — `executeForeignKeyActions`: identical schema comparison. Prevents runtime cascade actions from firing against tables in the wrong schema.

### Fix 2: Cross-schema connection isolation (blocking issue discovered during implementation)

The reproducing test also exposed a separate bug: `VirtualTableConnection` lookups used unqualified table names, causing two schemas with identically-named tables to share the same connection/storage. This made `DELETE FROM s2.items WHERE id = 3` corrupt data.

- `runtime/utils.ts` — `getVTableConnection()` and `getVTable()`: now use schema-qualified names (`schema.table`) for connection lookup instead of bare table names.

- `vtab/memory/table.ts` — `ensureConnection()`, `createConnection()`, `getConnection()`: register connections with schema-qualified `tableName`. Also added a `tableManager` identity check before reusing existing connections — previously a connection from a different schema's table could be silently reused even when managers didn't match.

### Fix 3: Test annotation

Fixed the test file's `-- error` annotation to use the correct `-- error: constraint failed` format expected by the sqllogic test runner.

## Testing / validation

Test file `41-fk-cross-schema.sqllogic` verifies:
- DELETE/UPDATE on `s2.items` succeeds (no FK references it)
- DELETE on `s1.items` with referenced rows correctly fails (RESTRICT)
- Row counts are preserved correctly across schemas

Full test suite: 298 passing (1 pre-existing failure in `03.7-bigint-mixed-arithmetic`).
Build passes clean.
