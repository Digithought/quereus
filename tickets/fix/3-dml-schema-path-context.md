description: DML builders use wrong planning context for schema path resolution
dependencies: none
files:
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
----
Two DML builders pass the base `ctx` instead of `contextWithSchemaPath` in schema-path-sensitive codepaths.

### insert.ts:528 — Row expansion uses base ctx

`createRowExpansionProjection(ctx, ...)` should receive `contextWithSchemaPath`.
When `stmt.schemaPath` is set, default expressions that reference tables via implicit
schema resolution will fail because the schema path is not propagated to the default
expression builder.

### update.ts:68 — Source scan uses base ctx

The second `buildTableReference` call that builds the source scan uses `ctx` instead of
`contextWithSchemaPath`. If the table relies on implicit schema resolution via `schemaPath`
rather than an explicit `stmt.table.schema`, the source scan resolves against the wrong schema.
(Compare with delete.ts which reuses the single `tableRetrieve` and avoids this issue.)

### Impact

Only triggers when `stmt.schemaPath` is set and the target table or its defaults rely on
implicit schema resolution (no explicit schema qualifier). Low probability but could produce
incorrect results or resolution errors.

### Fix

- insert.ts: Pass `contextWithSchemaPath` to `createRowExpansionProjection` instead of `ctx`.
- update.ts: Use `contextWithSchemaPath` for the second `buildTableReference` call on line 68.
