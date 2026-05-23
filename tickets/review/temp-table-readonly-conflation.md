description: Review the fix for `relationTypeFromTableSchema` which previously marked TEMP TABLE relations as `isReadOnly`, conflating them with views. The disjunction now consults the explicit `tableSchema.isReadOnly` field instead of `tableSchema.isTemporary`. A new sqllogic test exercises the full DML lifecycle of a `CREATE TEMP TABLE`.
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/test/logic/08.2-temp-table-edge-cases.sqllogic
----

## Change

`packages/quereus/src/planner/type-utils.ts:62` — the OR disjunction now reads:

```ts
isReadOnly: !!(tableSchema.isView || tableSchema.isReadOnly),
```

`TableSchema.isView` stays in the disjunction because views in this engine are not yet writable through INSTEAD OF triggers, so the relation type still rejects writes at that level regardless of how the schema-builder fills `isReadOnly` for a view.

This is preventative: grep confirmed no DML builder (`insert.ts`, `update.ts`, `delete.ts`) inspects `RelationType.isReadOnly`, so there was no observable runtime failure today. The conflation would have surfaced once any planner pass started using that flag for write-gating.

## Test

New file `packages/quereus/test/logic/08.2-temp-table-edge-cases.sqllogic` exercises the full lifecycle of a temp table — `create temp table`, `insert`, `select`, `update`, `delete`, re-`insert`, and `drop`. The 08.2 slot was free; the 08.1 prefix is already double-used by `08.1-semi-anti-join.sqllogic` and `08.1-view-edge-cases.sqllogic`, so a new top-level file matches the project's existing pattern of giving the temp-table-edge-cases scenario its own file.

Verified with `yarn workspace @quereus/quereus run test --grep "08.2-temp-table-edge-cases"` → 1 passing. Full `yarn test` from repo root → 3413 passing, no regressions. Lint clean (exit 0).

## Known gaps / things a reviewer should poke at

- **No negative test for the read-only path.** The new sqllogic only confirms the writable path works for temp tables. If a reviewer wants belt-and-suspenders coverage, they could add an assertion that `RelationType.isReadOnly` is true for views and false for temp tables at the planner level — but no current code path reads that flag, so this would be testing internal state with no behavior wire-up.
- **`createBasicSchema` (table.ts:287)** still sets `isTemporary: false` and doesn't touch `isReadOnly`, which is correct (default-false is the intended state), but a reviewer might want to skim the schema builders that *do* set `isTemporary: true` to confirm none of them was relying on the old conflation to also flag the table as read-only. Quick grep target: `isTemporary: true` across the schema/ tree.
- **No coverage of temp-table cross-connection visibility.** The ticket explicitly punted per-connection scoping of temp objects as out-of-scope; if cross-connection temp visibility ever matters, file separately.

## Out of scope

Per-connection scoping of temp objects (whether two connections sharing a database see each other's temp tables) — punt to a separate ticket if it ever comes up.
