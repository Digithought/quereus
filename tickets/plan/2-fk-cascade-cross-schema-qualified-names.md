description: FK CASCADE/SET NULL/SET DEFAULT actions use unqualified table names, breaking cross-schema scenarios
dependencies: none
files:
  packages/quereus/src/runtime/foreign-key-actions.ts
----
## Problem

`executeSingleFKAction` in `foreign-key-actions.ts` generates SQL with unqualified table names:

```typescript
const sql = `DELETE FROM "${childTable.name}" WHERE ${whereClause}`;
```

When the child table is in a different schema than the current default schema, this would target the wrong table or fail to find it. The same issue applies to CASCADE UPDATE, SET NULL, and SET DEFAULT actions.

## Expected behavior

Generated SQL should use schema-qualified table names:
```sql
DELETE FROM "schemaName"."tableName" WHERE ...
```

## Scope

Lines 102, 114, 125, 138 in `foreign-key-actions.ts` — all SQL template strings in `executeSingleFKAction`.

## Testing notes

Extend `41-fk-cross-schema.sqllogic` or add a new test with CASCADE/SET NULL actions across schemas to verify correct table targeting.
