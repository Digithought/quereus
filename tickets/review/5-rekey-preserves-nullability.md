description: Fix for ALTER PRIMARY KEY shadow-table rebuild losing nullability and DEFAULT on non-MemoryTable modules. Release-blocking: caused "Database Initialization Error" in SiteCAD for every existing user when a declarative-schema change triggered a rekey on IndexedDB/LevelDB-backed tables.
dependencies: none
files:
  - packages/quereus/src/runtime/emit/alter-table.ts          (buildShadowTableDdl extracted + fixed)
  - packages/quereus/test/runtime/shadow-ddl.spec.ts          (new — direct DDL unit coverage)
  - packages/quereus/test/logic/41.1-alter-pk.sqllogic        (regression case 10a)
----

## What changed

`rebuildViaShadowTable` (`packages/quereus/src/runtime/emit/alter-table.ts`) used to emit `not null` only when the column had `notNull=true` and silently nothing for nullable columns. Quereus defaults columns to NOT NULL in the session, so re-parsing the emitted DDL promoted every nullable column to NOT NULL. Re-inserting pre-existing NULL values failed with `NOT NULL constraint failed`, aborting the upgrade transaction and leaving the app unusable.

DEFAULT expressions were also dropped in the shadow DDL.

The DDL-string construction was extracted into a pure exported helper so it can be unit-tested without a non-memory module:

```
export function buildShadowTableDdl(
  tableSchema, shadowName, survivingColumns, newPkDef,
): string
```

Fixes:
- Every column now gets an explicit `null` or `not null` annotation (mirrors the no-db branch of `generateTableDDL` in `schema/ddl-generator.ts:171` — safe under any session's `default_column_nullability`).
- `default <expr>` is emitted for any column with a default (uses `expressionToString` from `emit/ast-stringify.ts`, same path `ddl-generator.formatDefaultExpression` uses).
- `collate <name>` behavior is unchanged (only emitted when non-BINARY).

## How to validate

### Use cases
- Rekey a table whose non-PK columns include nullables with actual NULL values, on a non-MemoryTable module (IndexedDB/LevelDB). Before: throws `NOT NULL constraint failed`. After: row survives with its NULLs intact.
- Rekey a table with a `default <expr>` non-PK column. Before: default clause lost in shadow table. After: default preserved and visible via `table_info` / `schema()`.
- MemoryTable path is unaffected — it copies `ColumnSchema` objects directly via `module.create()` and never stringifies DDL.

### Automated coverage
- `packages/quereus/test/runtime/shadow-ddl.spec.ts` — eight cases covering `null`/`not null` emission, DEFAULT preservation, COLLATE passthrough, composite PK, empty PK, and a full re-execute/round-trip that rebuilds the table in a fresh DB and asserts nullability/default/collation are retained by the parser.
- `packages/quereus/test/logic/41.1-alter-pk.sqllogic` case 10a — a rekey over a populated table with a nullable column containing NULL and a defaulted column, asserting row survival, NULL preservation, and `notnull=0` via `table_info`.

### Commands run
- `yarn build` — clean
- `yarn test` — 2428 passing / 2 pending (pre-existing)
- `yarn lint` — 0 errors (274 pre-existing warnings, none from this change)

### Downstream verification (for reviewer)
Rebuild quereus, publish/link into SiteCAD, and confirm an upgrade from a pre-redesign IndexedDB state (schema change that adds nullable columns + triggers a rekey) no longer throws the "Database Initialization Error" screen. End-to-end coverage in quereus proper is not possible without a non-memory module fixture — see open gap below.

## Review notes and category gaps (read before signing off)

This bug existed because every `.sqllogic` test routes through `rebuildMemoryTable` (programmatic `ColumnSchema` copy), never `rebuildViaShadowTable` (DDL stringify). The direct `.spec.ts` closes the immediate gap, but the broader category exposure remains:

- No quereus-owned non-memory module fixture exists. Any future DDL-stringifier regression in shadow rebuild paths will again only reproduce downstream. A test-only module that forces the non-memory branch would let alter-table sqllogic tests run in both modes. Not done here — out of scope for a release-blocker fix — but worth a follow-up ticket.
- `quereus-plugin-indexeddb` and `quereus-isolation` have no alter-PK-with-NULL-data scenario in their own suites. Worth opening a downstream ticket to add one.
- Other shadow-DDL emitters (column drop/add fallbacks, future `ALTER COLUMN` variants) should get the same pure-helper treatment + unit test.

## Secondary issue (not addressed here)

SiteCAD observed `ALTER PRIMARY KEY ()` emitted when declared PK `()` = actual PK `()`. Investigation: `extractDeclaredPK` in `schema/schema-differ.ts:283` defaults to *all columns* when no explicit `primary key` clause is present (line 312–313), so a singleton table declared without any PK clause will be compared against an actual PK of `[]` and a diff emitted. If the declared DDL includes an explicit `primary key ()`, the constraint branch at line 289–294 returns `[]` and `pkSequencesEqual` matches — no ALTER emitted.

So the spurious ALTER only fires when the declared DDL omits the `primary key ()` clause but the actual table has `[]`. That's a schema-differ bug worth a follow-up ticket against `schema-differ.ts`, but it does not change the need for this fix — real PK changes also hit `rebuildViaShadowTable` and would fail identically. Not filed as a separate ticket yet; reviewer can open one if they want this chased.
