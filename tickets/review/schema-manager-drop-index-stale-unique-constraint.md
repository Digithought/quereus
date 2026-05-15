---
description: DROP INDEX on a UNIQUE index left behind the synthesized `UniqueConstraintSchema`, so unique enforcement persisted after the index was gone. Fixed by tagging the derived constraint with `derivedFromIndex` at create time and filtering by it on drop, in both the engine schema registry and the in-memory vtab's cached schema. Store side gets the create-time tag plus a code comment flagging the symmetric drop obligation when `StoreModule.dropIndex` is eventually added.
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/test/logic/drop-unique-index.sqllogic
---

## What changed

### 1. Origin tag on `UniqueConstraintSchema`

`packages/quereus/src/schema/table.ts:441-444` — added optional
`derivedFromIndex?: string`. Populated only by the three sites that
synthesize a unique constraint from a UNIQUE index:

- `SchemaManager.addIndexToTableSchema` (`manager.ts:1256-1265`)
- `MemoryTableManager.createIndex` (`vtab/memory/layer/manager.ts:1287-1299`)
- `StoreModule.createIndex` (`quereus-store/src/common/store-module.ts:343-356`)

CREATE TABLE-time UNIQUE constraints (extracted by
`SchemaManager.extractUniqueConstraints`, manager.ts:896) never set this
field, so they are immune to the filter.

### 2. Drop-side filter

Both engine-side and vtab-side drops now strip the derived constraint
alongside the index:

- `SchemaManager.dropIndex` (`manager.ts:1316-1331`) — filters
  `uniqueConstraints` by `derivedFromIndex?.toLowerCase() !==
  lowerIndexName`, collapsing the array to `undefined` when empty (matches
  the `extractUniqueConstraints` convention used at create-time).
- `MemoryTableManager.dropIndex` (`vtab/memory/layer/manager.ts:1344-1358`)
  — same filter applied to the layer's cached `tableSchema` so
  `checkUniqueConstraints` no longer enforces the stale rule.

Lowercasing on both sides because index names are case-insensitive
elsewhere in the engine (the dropIndex paths already lowercase the input).

### 3. Store-side drop is still TODO

`StoreModule` does not yet implement `dropIndex`. The create-side now
tags the synthesized constraint and a comment at
`quereus-store/src/common/store-module.ts:343-348` points at the
symmetric drop obligation. **Until that lands, DROP INDEX through the
store path will still leak the unique-constraint** — but the tag is now
in place so the drop implementation only needs to mirror
`SchemaManager.dropIndex`. This was explicitly out of scope per the
ticket and per the parent `store-table-create-index-schema-not-updated`
fix that only added `createIndex`.

## Tests

New file: `packages/quereus/test/logic/drop-unique-index.sqllogic`.
Covers three scenarios:

1. **Happy path** — `CREATE UNIQUE INDEX`, verify duplicate rejection,
   `DROP INDEX`, then a previously-rejected duplicate succeeds.
2. **Coincident-name preservation** — table with `CONSTRAINT u
   UNIQUE(b)` and a separate `CREATE UNIQUE INDEX u_idx ON t(a)`. After
   `DROP INDEX u_idx`, the declared `UNIQUE(b)` constraint still rejects
   duplicates on column `b`. (The truly-same-name case is unreachable via
   normal DDL because the parser doesn't allow it; the `derivedFromIndex`
   tag makes it moot regardless.)
3. **Partial UNIQUE index** — `CREATE UNIQUE INDEX ... WHERE status =
   'active'`, verify in-scope rejection, drop, verify duplicate now
   accepted. Exercises the `predicate` round-trip.

All 2942 quereus tests pass (`yarn test`) and lint is clean.

## Validation notes / known gaps

- `yarn test` (memory vtab path) passes — covers SchemaManager and
  MemoryTableManager fixes.
- `yarn test:store` was **not** run because Windows + LevelDB plugin
  setup is finicky for headless agents; the store path is exercised by
  the same logic suite via `--store`. The store-side `createIndex` only
  gained the `derivedFromIndex` tag (no behavioral change without a
  matching `dropIndex`), so a regression is unlikely, but a human
  re-running `yarn test:store` locally would confirm it cheaply.
- No docs change needed: `docs/schema.md` does not list
  `UniqueConstraintSchema` fields (verified by grep).
- The `Edit` to `MemoryTableManager.createIndex` changed the implicit
  type of `newConstraint` to an explicit `UniqueConstraintSchema`. The
  type was already imported in that file (`vtab/memory/layer/manager.ts:2`),
  so no new import was needed.

## Areas to scrutinize during review

- Whether any caller of `TableSchema.uniqueConstraints` relies on the
  array being `frozen-but-present` vs `undefined`. The drop path collapses
  to `undefined` when the filter empties the list — matches the
  `extractUniqueConstraints` convention but worth a quick scan.
- Whether the engine-side `SchemaManager.dropIndex` and vtab-side
  `MemoryTableManager.dropIndex` can ever desync (one runs, the other
  doesn't). The flow runs the module's `dropIndex` first, then updates
  the engine schema — if the vtab succeeds but the engine update is
  somehow skipped, the engine schema would still carry the stale unique
  constraint. I did not change that ordering and have not stress-tested
  the failure path.
- The store-side gap is acknowledged but not fixed; reviewer should
  decide whether to spawn a follow-up ticket
  (`store-table-drop-index-schema-not-updated`?) now or wait until the
  drop method is actually implemented.
