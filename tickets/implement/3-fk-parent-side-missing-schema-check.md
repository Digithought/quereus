description: Add schema comparison to parent-side FK matching in planner and runtime
dependencies: none
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/test/logic/41-fk-cross-schema.sqllogic  (reproducing test — already written)
----
## Bug

When iterating all schemas to find child tables whose FKs reference a parent table,
both `buildParentSideFKChecks` and `executeForeignKeyActions` compare only the table
name, ignoring the schema. If two schemas have identically-named tables, operations
on one incorrectly trigger FK constraint checks (or cascade actions) from children
that actually reference the other schema's table.

### Confirmed reproduction

Test file `test/logic/41-fk-cross-schema.sqllogic` reproduces the bug:
- `s1.items` (parent) ← `s1.orders` (child FK)
- `s2.items` (unrelated)
- `DELETE FROM s2.items` fails with `Table 'orders' not found in schema path: s2`
  because the planner incorrectly matches `s1.orders`' FK against `s2.items`.

Stack trace confirms the error originates at `buildParentSideFKChecks` →
`buildExpression` → `resolveTableSchema` when trying to resolve child table `orders`
in the wrong schema context.

## Fix

### Location 1: `foreign-key-builder.ts:249` — `buildParentSideFKChecks`

After the table name comparison, add a schema check. The FK's `referencedSchema`
field indicates which schema's table the FK targets. If set, compare it to
`tableSchema.schemaName`. If not set, the FK defaults to the child table's own
schema, so compare `childTable.schemaName` to `tableSchema.schemaName`.

```typescript
// existing line 249:
if (fk.referencedTable.toLowerCase() !== tableSchema.name.toLowerCase()) continue;

// add after:
const targetSchema = fk.referencedSchema ?? childTable.schemaName;
if (targetSchema.toLowerCase() !== tableSchema.schemaName.toLowerCase()) continue;
```

### Location 2: `foreign-key-actions.ts:50` — `executeForeignKeyActions`

Identical pattern — same fix:

```typescript
// existing line 50:
if (fk.referencedTable.toLowerCase() !== parentTable.name.toLowerCase()) continue;

// add after:
const targetSchema = fk.referencedSchema ?? childTable.schemaName;
if (targetSchema.toLowerCase() !== parentTable.schemaName.toLowerCase()) continue;
```

### Test

The reproducing test `test/logic/41-fk-cross-schema.sqllogic` is already written and
confirms the failure. After the fix it should pass, verifying:
- DELETE/UPDATE on `s2.items` succeeds (no FK references it)
- DELETE on `s1.items` with referenced rows still correctly fails (RESTRICT)

## TODO

- Apply the two-line schema check in `foreign-key-builder.ts:249`
- Apply the two-line schema check in `foreign-key-actions.ts:50`
- Run the test suite: `41-fk-cross-schema` passes, existing FK tests still pass
- Run full build + test to confirm no regressions
