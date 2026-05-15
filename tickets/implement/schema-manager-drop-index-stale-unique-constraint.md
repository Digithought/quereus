---
description: DROP INDEX leaves behind a stale `UniqueConstraintSchema` synthesized when the UNIQUE index was created. Fix by tagging the derived constraint with `derivedFromIndex` and filtering by it on drop. Applies to `SchemaManager` (engine schema registry) and `MemoryTableManager` (in-memory vtab's cached schema). Store path is noted but currently has no `dropIndex` implementation to update.
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/test/logic/
---

## Architecture

### Origin tracking via `derivedFromIndex`

`UniqueConstraintSchema` today carries `name`, `columns`, `predicate`, etc.
The ticket's "Care" note flags the risk of filtering by name on drop: a
CREATE TABLE-time UNIQUE constraint could coincidentally share its name
with a later-dropped index. The fix tracks origin explicitly.

Add an optional field to `UniqueConstraintSchema` in
`packages/quereus/src/schema/table.ts`:

```ts
/** When set, this constraint was synthesized from a UNIQUE index of the
 *  given name (see SchemaManager.addIndexToTableSchema). DROP INDEX of that
 *  index removes this constraint. Unset for constraints declared at
 *  CREATE TABLE time. */
derivedFromIndex?: string;
```

Populated by the three create-side sites that already derive constraints
from a UNIQUE index:

| Site | File | Line (approx) |
|---|---|---|
| Engine schema registry | `packages/quereus/src/schema/manager.ts` | 1256-1264 |
| Memory vtab's cached schema | `packages/quereus/src/vtab/memory/layer/manager.ts` | 1287-1297 |
| Store vtab's cached schema | `packages/quereus-store/src/common/store-module.ts` | 343-352 |

Each appends `derivedFromIndex: indexSchema.name` to the synthesized entry.

### Drop-side cleanup

Two drop paths exist; both must filter out the derived entry:

- `SchemaManager.dropIndex` (manager.ts:1316-1323) — updates engine schema.
- `MemoryTableManager.dropIndex` (memory/layer/manager.ts:1344-1347) —
  updates the memory-table's local cached schema.

After filtering `indexes`, compute:

```ts
const updatedUniqueConstraints = (table.uniqueConstraints ?? []).filter(
    uc => uc.derivedFromIndex?.toLowerCase() !== lowerIndexName
);
```

and include `uniqueConstraints: updatedUniqueConstraints.length > 0
? Object.freeze(updatedUniqueConstraints) : undefined` in the new
TableSchema. Preserve the existing field when unchanged.

`StoreModule` currently has no `dropIndex` method (only `createIndex` was
added by the prior `store-table-create-index-schema-not-updated` fix). When
it is implemented, it must mirror this same filter — but that is out of
scope for this ticket. Leave a brief code comment on the `createIndex`
derivation pointing at the symmetric obligation, so the next contributor
sees it.

### Why this is safe vs. name-matching

- CREATE TABLE-time UNIQUE constraints are produced by
  `extractUniqueConstraints` (manager.ts:896). That path never sets
  `derivedFromIndex`, so it is immune to accidental removal even when its
  `name` happens to match the dropped index.
- The field is optional, so existing serialized schemas and external
  consumers that construct `UniqueConstraintSchema` directly remain valid.

### Test surface

Add a sqllogic test file (`packages/quereus/test/logic/drop-unique-index.sqllogic` —
or extend an existing index-related logic file if one is a clean fit) covering:

1. **Happy path** — `CREATE TABLE t(a INT, b INT)`; `CREATE UNIQUE INDEX u
   ON t(a)`; `INSERT 1; INSERT 1` fails; `DROP INDEX u`; `INSERT 1`
   succeeds (no stale uniqueness check).
2. **Coincident name preservation** — `CREATE TABLE t(a INT, b INT,
   CONSTRAINT u UNIQUE(b))`; `CREATE UNIQUE INDEX u_idx ON t(a)`; `DROP
   INDEX u_idx`; `INSERT (1, 2); INSERT (3, 2)` still fails because the
   declared UNIQUE(b) constraint survives. (Picks distinct names; the more
   adversarial same-name case is unreachable via normal DDL because index
   and constraint namespaces overlap — `derivedFromIndex` makes this moot
   either way.)
3. **Partial unique index** — exercise the `predicate` round-trip: drop
   should still remove the synthesized partial constraint.

Existing tests under `packages/quereus/test/logic/` for UNIQUE indexes
should keep passing — the change is additive on the type and behavior is
unchanged until DROP INDEX is exercised.

## Open considerations (decided)

- **Origin tracking vs. name match** — chose origin tracking
  (`derivedFromIndex`) per the ticket's "Safer" note. Trivially small
  payload, removes the name-collision footgun forever.
- **Lowercasing on filter** — index/constraint names are
  case-insensitive elsewhere in the engine
  (`dropIndex` already lowercases). Compare with `.toLowerCase()` on
  both sides.
- **Memory-table parity** — the memory vtab maintains its own cached
  `tableSchema` separate from the engine registry. Both must be
  patched; otherwise the engine sees a clean schema while the vtab's
  layer manager keeps enforcing the stale constraint via
  `checkUniqueConstraints` (memory/layer/manager.ts:81-88, 711-712,
  741-743).
- **Store-side dropIndex** — out of scope per ticket; the parent fix
  `store-table-create-index-schema-not-updated` only addressed
  `createIndex`. Leave a code comment near the store's createIndex
  derivation noting the symmetric obligation when dropIndex is added.

## TODO

- Add `derivedFromIndex?: string` to `UniqueConstraintSchema` in
  `packages/quereus/src/schema/table.ts` with the docstring above.
- Set `derivedFromIndex: indexSchema.name` on the synthesized constraint
  in:
  - `SchemaManager.addIndexToTableSchema` (manager.ts:1256-1264)
  - `MemoryTableManager` createIndex synthesis (memory/layer/manager.ts:1287-1297)
  - `StoreModule.createIndex` (store-module.ts:343-352) plus a comment
    referencing the symmetric drop obligation when a `dropIndex`
    implementation is added.
- In `SchemaManager.dropIndex` (manager.ts:1316-1323): after filtering
  `indexes`, also filter `uniqueConstraints` by
  `uc.derivedFromIndex?.toLowerCase() !== lowerIndexName`; include the
  result in the new `TableSchema` (collapse to `undefined` when empty to
  match the create-side convention at manager.ts:926).
- In `MemoryTableManager.dropIndex` (memory/layer/manager.ts:1328-1360):
  same filter against `this.tableSchema.uniqueConstraints` before building
  `finalNewTableSchema`.
- Add sqllogic test coverage for the three scenarios listed above.
- Run `yarn test` (memory vtab path); the symmetric `yarn test:store` will
  exercise the store-side once `StoreModule.dropIndex` exists — note this
  in the implement handoff but do not gate on it.
- Update `docs/schema.md` if it documents `UniqueConstraintSchema` fields.
