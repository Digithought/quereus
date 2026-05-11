description: Expose metadata tags through schema introspection TVFs, and fill gaps for objects/columns/constraints that are not currently introspectable
files:
  - packages/quereus/src/func/builtins/schema.ts          # all introspection TVFs live here
  - packages/quereus/src/func/builtins/index.ts           # registration list — add new TVFs here
  - packages/quereus/src/schema/table.ts                  # TableSchema, IndexSchema, RowConstraintSchema, ForeignKeyConstraintSchema, UniqueConstraintSchema (all carry tags)
  - packages/quereus/src/schema/column.ts                 # ColumnSchema (carries tags, collation, generated info)
  - packages/quereus/src/schema/view.ts                   # ViewSchema (carries tags)
  - packages/quereus/src/schema/manager.ts                # getAllAssertions / _getAllSchemas iterators
  - packages/quereus/src/schema/schema.ts                 # getAllTables/Views/Assertions/_getAllFunctions
  - packages/quereus/test/logic/06.3-schema.sqllogic      # existing schema() tests — extend
  - packages/quereus/test/logic/50-metadata-tags.sqllogic # tag round-trip tests — extend
  - docs/functions.md                                     # introspection TVF reference — update
----

# Expose metadata tags (and other unexposed schema metadata) through introspection TVFs

## Background

Quereus accepts `WITH TAGS (key = value, ...)` clauses on tables, columns, views, indexes, and named CHECK / UNIQUE / FOREIGN KEY constraints. The parsed tags land on the corresponding schema objects (`TableSchema.tags`, `ColumnSchema.tags`, `ViewSchema.tags`, `IndexSchema.tags`, `RowConstraintSchema.tags`, `ForeignKeyConstraintSchema.tags`, `UniqueConstraintSchema.tags`). Tags are also threaded through `SchemaCatalog` for declarative-schema diffing — see `packages/quereus/src/schema/catalog.ts:21-55`.

However, **none of the schema introspection TVFs (`schema()`, `table_info()`, `foreign_key_info()`, `function_info()`) currently expose tags**. There is also no introspection of CHECK / UNIQUE constraints at all, no per-column collation/generated info, no assertion listing, and no per-index column listing. This makes tags effectively a write-only-then-rehash feature from the SQL layer.

The fix is to add `tags` columns where they belong on the existing TVFs and introduce a handful of new TVFs for the constraint shapes that have no representation today. Tags are encoded as JSON text so callers can `json_extract()` individual keys without us having to invent a multi-row tag schema. (We can layer a separate flat `tags()` TVF on top later if needed — out of scope here.)

## Architecture

### Tag encoding

Tags are `Readonly<Record<string, SqlValue>>` where values can be string/number/boolean/null/bigint. The natural and consistent representation in SQL is a JSON object, emitted as a `TEXT` column named `tags`. Rules:

- When the underlying object has no tags (`undefined` or empty `{}`), yield SQL `NULL` (not the literal `'{}'`) so `WHERE tags IS NULL` cleanly filters out untagged objects.
- Otherwise, emit `JSON.stringify(tags)` with `bigint` coerced to its JSON-safe form already used elsewhere in the engine (see how the schema-hasher / DDL generator handle tag values — match their conventions; do not invent a new encoder).
- Column type: `{ typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }`.

A small helper at the top of `schema.ts` keeps this DRY across every TVF that emits tags:

```ts
function tagsToJson(tags: Readonly<Record<string, SqlValue>> | undefined): string | null {
  if (!tags) return null;
  const keys = Object.keys(tags);
  if (keys.length === 0) return null;
  return JSON.stringify(tags);  // mirror existing tag serialization conventions
}
```

### Changes to existing TVFs

**`schema()`** — appends a `tags` column. Populated for `table`, `view`, and `index` rows from the corresponding schema object. `function` rows always yield `NULL` (functions don't carry tags).

**`table_info(table_name)`** — appends three columns:
- `tags` (TEXT?, JSON) — `ColumnSchema.tags`
- `collation` (TEXT) — `ColumnSchema.collation` (defaults to `'BINARY'`)
- `generated` (INTEGER, 0/1/2) — 0 = not generated, 1 = virtual generated, 2 = stored generated. Derived from `column.generated`, `column.generatedStored`.

(Default-value introspection is already covered by `dflt_value`. `defaultConflict` is intentionally left out to keep the column list bounded; it can land in a follow-up if needed.)

**`foreign_key_info(table_name)`** — appends a `tags` column. Same JSON value is repeated for each `seq` row of a multi-column FK.

**`function_info()`** — unchanged for tags (functions don't have tags) but the column count stays as-is.

### New TVFs

All new TVFs are integrated TVFs registered in `BUILTIN_FUNCTIONS` (`packages/quereus/src/func/builtins/index.ts`).

**`index_info(table_name)`** — one row per (index, indexed-column) pair, ordered by the column's position in the index.

| Column | Type | Notes |
|---|---|---|
| `index_name` | TEXT | |
| `seq` | INTEGER | 0-based position within the index |
| `column_name` | TEXT | resolved from `IndexColumnSchema.index` |
| `desc` | INTEGER | 0/1 |
| `collation` | TEXT? | nullable; defaults present if specified |
| `unique` | INTEGER | 0/1 — repeated on every row of the same index |
| `partial` | INTEGER | 1 if `IndexSchema.predicate` is set, else 0 |
| `tags` | TEXT? | JSON, repeated per row |

**`check_constraint_info(table_name)`** — one row per CHECK constraint (named or unnamed) on the table.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | array index |
| `name` | TEXT? | nullable for unnamed |
| `expr` | TEXT | stringified `RowConstraintSchema.expr` (use existing AST stringifier — `emit/ast-stringify.ts`) |
| `operations` | TEXT | comma-joined subset of `insert,update,delete` derived from the `RowOpMask`. Empty mask → emit `'insert,update,delete'` (default-all) so it round-trips cleanly. |
| `deferrable` | INTEGER | 0/1 |
| `initially_deferred` | INTEGER | 0/1 |
| `tags` | TEXT? | JSON |

**`unique_constraint_info(table_name)`** — one row per (UNIQUE-constraint, column) pair. Skip the primary key — that's already covered by `table_info.pk`. Each `UniqueConstraintSchema` contributes `columns.length` rows.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | constraint index |
| `name` | TEXT? | constraint name, nullable for unnamed |
| `seq` | INTEGER | 0-based column position within the constraint |
| `column_name` | TEXT | |
| `partial` | INTEGER | 1 if `predicate` is set |
| `tags` | TEXT? | JSON, repeated per row |

**`assertion_info()`** — zero-arg TVF listing CREATE ASSERTION objects. Uses `db.schemaManager.getAllAssertions()`.

| Column | Type | Notes |
|---|---|---|
| `name` | TEXT | |
| `violation_sql` | TEXT | the CHECK violation query |
| `deferrable` | INTEGER | 0/1 |
| `initially_deferred` | INTEGER | 0/1 |
| `dependent_tables` | TEXT | JSON array of `{relationKey, base}` from `dependentTables` |

(Assertions don't carry user tags today, but exposing them at all is a real gap — they exist in the schema yet are completely invisible to SQL.)

### Cross-cutting

- **Naming convention:** all introspection TVFs use `snake_case` and group by the parent object type. Existing names (`schema`, `table_info`, `foreign_key_info`, `function_info`) stay; new ones follow the same pattern (`index_info`, `check_constraint_info`, `unique_constraint_info`, `assertion_info`).
- **Error rows in `schema()`** — the existing TVF emits a 5-column error row when introspection fails. After adding `tags`, the error row must be widened to 6 columns (final `NULL`). Don't lose this fallback path.
- **No backwards-compat shims.** Per AGENTS.md, just add the columns / TVFs; downstream callers will adapt. `quoomb-cli`, `quoomb-web`, and `quereus-vscode` should be quickly scanned for `schema()` / `table_info()` / `foreign_key_info()` column-index assumptions — if anyone is unpacking rows positionally, fix at the same time.

### Tests

Mirror the existing `06.3-schema.sqllogic` style — sqllogic files with deterministic JSON assertions. Add a new `06.3.3-introspection-tags.sqllogic` that covers:

- `schema()` reports `tags` JSON for a tagged table, view, and index; `NULL` for an untagged one; `NULL` for functions.
- `table_info()` reports column-level tags, collation, and generated flag for virtual/stored generated columns.
- `foreign_key_info()` reports FK tags, repeated across multi-column FKs.
- `index_info()` returns the right column-by-column layout for ASC/DESC, named collation, partial index, and unique index — and surfaces tags.
- `check_constraint_info()` and `unique_constraint_info()` return named and unnamed cases, with tags where the constraint is named (per the existing parser rule that unnamed-constraint trailing `WITH TAGS` attaches to the column instead).
- `assertion_info()` returns assertions defined via `CREATE ASSERTION`.

Use `json_extract` in the assertions to keep them legible:
```sql
select name, json_extract(tags, '$.display_name') as display_name
  from schema() where type = 'table' and name = 'Orders';
```

Also extend `50-metadata-tags.sqllogic` Phases 1–5 with one-line "now query it back" assertions per phase so tag round-trip is checked alongside the parse path.

### Docs

Update `docs/functions.md` § "Schema introspection functions":
- Add the `tags` / `collation` / `generated` columns to the existing TVF tables.
- Add new subsections for `index_info`, `check_constraint_info`, `unique_constraint_info`, `assertion_info`.
- Add an example block showing `json_extract(tags, '$.audit')` style usage.

### Out of scope (parked)

These came up while scoping and are deliberately not part of this ticket — leave them for a future plan ticket if the user wants them:
- A flat `tags()` TVF with (object_type, object_name, key, value, value_type) rows. Useful if users need to scan tags without parsing JSON, but reduplicates everything we're already adding.
- Mutation-context introspection (`TableSchema.mutationContext`).
- Module / vtab argument introspection (`vtabModuleName`, `vtabArgs`).
- Schema list TVF (`attach`-ed schemas). `schema()` already groups by `schema` column but there's no standalone schemas TVF.
- `defaultConflict` exposure on columns / constraints.
- Statistics TVF (`TableSchema.statistics`).

## TODO

Phase 1 — tag exposure on existing TVFs
- Add `tagsToJson` helper to `packages/quereus/src/func/builtins/schema.ts` (match existing tag serialization conventions; don't invent encoding).
- Extend `schemaFunc` returnType with a `tags` TEXT? column; populate for table / view / index rows; emit `NULL` for `function` rows; widen the error-fallback row to match.
- Extend `tableInfoFunc` returnType with `tags`, `collation`, `generated` columns; emit per `ColumnSchema`.
- Extend `foreignKeyInfoFunc` returnType with `tags`; emit per FK (same JSON repeated across `seq` rows).

Phase 2 — new constraint / index introspection TVFs
- Implement `indexInfoFunc(table_name)` — one row per (index, column) pair.
- Implement `checkConstraintInfoFunc(table_name)` — one row per CHECK constraint; use existing AST stringifier for `expr`; derive `operations` from `RowOpMask`.
- Implement `uniqueConstraintInfoFunc(table_name)` — one row per (unique constraint, column).
- Implement `assertionInfoFunc()` — zero-arg, iterates `db.schemaManager.getAllAssertions()`.
- Register all four in `BUILTIN_FUNCTIONS` in `packages/quereus/src/func/builtins/index.ts`.

Phase 3 — tests and docs
- New `packages/quereus/test/logic/06.3.3-introspection-tags.sqllogic` covering every case in the Tests section above.
- Extend `packages/quereus/test/logic/50-metadata-tags.sqllogic` with round-trip introspection assertions per phase.
- Update `docs/functions.md` § Schema introspection: new columns + new TVF subsections + a `json_extract(tags, ...)` example.
- `yarn build && yarn test` clean (stream output via `Tee-Object` per AGENTS.md). The `tests:store` suite is not required for this change.

Phase 4 — downstream consumer sweep (read-only check, fix only if broken)
- `grep` for positional row-unpacking of `schema()` / `table_info()` / `foreign_key_info()` in `quoomb-cli`, `quoomb-web`, `quereus-vscode`. Most consumers use column-name access, but a positional consumer would silently break when the row width changes — fix at the same commit.
