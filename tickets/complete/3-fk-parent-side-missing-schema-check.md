description: FK parent-side checks and cascade actions now respect schema boundaries
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/utils.ts
  packages/quereus/src/vtab/memory/table.ts
  packages/quereus/test/logic/41-fk-cross-schema.sqllogic
----
## Summary

Three related cross-schema FK bugs fixed:

1. **FK schema comparison** — `buildParentSideFKChecks` (planner) and `executeForeignKeyActions` (runtime) now compare `fk.referencedSchema ?? childTable.schemaName` against the parent table's schema, preventing FK checks/actions from firing against same-named tables in the wrong schema.

2. **Connection isolation** — `getVTableConnection()`, `getVTable()`, `ensureConnection()`, `createConnection()`, `getConnection()` all use schema-qualified names (`schema.table`) for connection lookup/registration. Prevents identically-named tables in different schemas from sharing connections/storage. Includes `tableManager` identity check to reject stale connections.

3. **Review fix** — Corrected indentation on schema comparison line in `foreign-key-builder.ts`.

## Testing

Test: `41-fk-cross-schema.sqllogic` — two schemas with identically-named `items` tables, FK only in `s1`:
- DELETE/UPDATE on `s2.items` succeeds (no FK references it)
- DELETE on `s1.items` with referenced rows fails (RESTRICT)
- Row counts preserved correctly across schemas

Full suite: 1013 passing, build clean.

## Known follow-up

`executeSingleFKAction` generates CASCADE/SET NULL/SET DEFAULT SQL with unqualified table names (e.g., `DELETE FROM "childTable"`). This would target the wrong table for cross-schema CASCADE actions. Filed as separate plan ticket.
