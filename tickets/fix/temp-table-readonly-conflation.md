description: `type-utils.ts:relationTypeFromTable` sets `RelationType.isReadOnly = true` for any `tableSchema.isTemporary` table, conflating VIEW (naturally read-only) with TEMP TABLE (normally writable). Before `fix-create-temp-dispatch` landed, the parser pinned `isTemporary` to `false` so this branch was dead; now that `CREATE TEMP TABLE` produces `isTemporary: true`, the relation-type `isReadOnly` propagates through plan nodes (join-utils, project, sequencing, window, scalar) and could trip up optimizer rules that gate on it. No INSERT/UPDATE/DELETE builder currently checks `RelationType.isReadOnly` to reject writes, so there's no hard failure today — but the semantic conflation should be untangled before something starts depending on it.
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
----

## Background

In `type-utils.ts:62`:

```ts
isReadOnly: !!(tableSchema.isView || tableSchema.isTemporary),
```

A view is conceptually read-only (no INSTEAD OF triggers in this engine yet). A temp table is just a regular table with a different lifetime — it should be writable.

## Suggested direction

Drop `tableSchema.isTemporary` from the disjunction. Only `tableSchema.isView` (and any future explicit `tableSchema.isReadOnly`) should set the relation-type's `isReadOnly`.

While in the area, add an integration test (sqllogic) that creates a `CREATE TEMP TABLE`, inserts rows, updates and deletes — `08.1-view-edge-cases.sqllogic` only exercises temp views right now, and the parser-level unit tests don't reach planner/runtime.

## Out of scope

Per-connection scoping of temp objects (whether two connections sharing a database see each other's temp tables) is a separate concern — covered by SQLite semantics but not necessarily by Quereus's schema manager. File separately if needed.
