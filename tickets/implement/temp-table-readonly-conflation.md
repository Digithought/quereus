description: Fix `relationTypeFromTableSchema` so it stops marking TEMP TABLE relations as `isReadOnly`. The current disjunction conflates VIEW (genuinely read-only) with TEMP TABLE (a normal writable table with a different lifetime). Replace `tableSchema.isTemporary` with the explicit `tableSchema.isReadOnly` field that already exists on `TableSchema` (table.ts:64). Add a sqllogic test that creates a `CREATE TEMP TABLE`, inserts rows, updates and deletes — `08.1-view-edge-cases.sqllogic` exercises temp views but no test currently exercises a TEMP TABLE through the planner/runtime.
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/test/logic/08.1-view-edge-cases.sqllogic
----

## Change

`packages/quereus/src/planner/type-utils.ts:62` — replace

```ts
isReadOnly: !!(tableSchema.isView || tableSchema.isTemporary),
```

with

```ts
isReadOnly: !!(tableSchema.isView || tableSchema.isReadOnly),
```

`TableSchema.isReadOnly` (table.ts:64) already exists as the explicit flag. `TableSchema.isView` stays in the disjunction because views in this engine are not yet writable via INSTEAD OF triggers, so they remain read-only at the relation-type level regardless of how the schema-builder fills `isReadOnly`.

No DML builder (`insert.ts`, `update.ts`, `delete.ts`) currently inspects `RelationType.isReadOnly` to reject writes, so there is no observable runtime failure today — this is preventative. Confirmed via grep: only scalar-level `isReadOnly`s appear in those files.

## Test

Add a section to `packages/quereus/test/logic/08.1-view-edge-cases.sqllogic` (or a new top-level sqllogic file — see "Open question" below) exercising the full lifecycle of a temp table:

- `create temp table tt (id integer primary key, val integer)`
- insert a couple rows, `select` to verify
- `update` a row, `select` to verify
- `delete` a row, `select` to verify
- `drop table tt`

If a new file feels cleaner (the existing file is titled "view edge cases"), create `packages/quereus/test/logic/08.2-temp-table-edge-cases.sqllogic` and put the temp-table coverage there. Either is acceptable; pick whichever matches the project's existing naming style.

## Out of scope

Per-connection scoping of temp objects (whether two connections sharing a database see each other's temp tables) is a separate concern — file separately if needed.

## TODO

- Edit `packages/quereus/src/planner/type-utils.ts:62` per the diff above.
- Add the temp-table sqllogic coverage (extend `08.1-view-edge-cases.sqllogic` or create `08.2-temp-table-edge-cases.sqllogic`).
- Run `yarn test` from the repo root and confirm the new cases pass and no existing test regresses.
- Run `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows) to confirm no lint regressions.
