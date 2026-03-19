description: Parent-side FK check matches by table name only, ignoring schema
dependencies: none
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
----
In `buildParentSideFKChecks` (line 249), the FK matching logic compares only the
table name when looking for child FKs that reference the parent table:

```typescript
if (fk.referencedTable.toLowerCase() !== tableSchema.name.toLowerCase()) continue;
```

It does not check `fk.referencedSchema` against `tableSchema.schemaName`. If two tables
in different schemas share the same name, DELETE/UPDATE on one could incorrectly generate
constraint checks against child tables whose FK actually targets the other schema's table.

The subsequent `resolveReferencedColumns(fk, tableSchema)` would use the wrong parent schema's
columns, potentially producing incorrect column index mappings or spurious constraint failures.

### Impact

Triggers in multi-schema setups where identically-named tables exist in different schemas.
At worst produces spurious FK violation errors; at best generates unnecessary constraint checks.

### Fix

After the table name check, add a schema check:

```typescript
if (fk.referencedSchema &&
    fk.referencedSchema.toLowerCase() !== tableSchema.schemaName.toLowerCase()) continue;
```

Also consider the case where `fk.referencedSchema` is undefined (defaults to same schema
as child table) — compare against `childTable.schemaName` or the default schema.
