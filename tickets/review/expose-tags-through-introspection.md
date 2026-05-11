description: Review tag/metadata exposure through introspection TVFs
files:
  - packages/quereus/src/func/builtins/schema.ts        # All schema TVFs (existing + 4 new) live here
  - packages/quereus/src/func/builtins/index.ts         # New TVFs registered in BUILTIN_FUNCTIONS
  - packages/quereus/test/logic/06.3.3-introspection-tags.sqllogic  # New: dedicated tag-exposure tests
  - packages/quereus/test/logic/50-metadata-tags.sqllogic           # Extended with round-trip assertions
  - docs/functions.md                                   # New TVF subsections + tags doc
----

# Tag exposure through schema introspection — review

## What landed

Schema introspection now surfaces every kind of metadata that was previously write-only or untrappable from SQL.

### Existing TVFs gained columns

- **`schema()`** — appended `tags` (TEXT, JSON object or NULL). Populated for `table` / `view` / `index` rows; always NULL for `function` rows. The error-fallback row was widened to 6 columns.
- **`table_info(table_name)`** — appended `tags` (column tags), `collation` (declared collation, defaults to `'BINARY'`), and `generated` (0 = not generated, 1 = virtual generated, 2 = stored generated).
- **`foreign_key_info(table_name)`** — appended `tags` (FK tags, repeated across all `seq` rows of a multi-column FK).

### New TVFs

- **`index_info(table_name)`** — one row per (index, column) pair. Columns: `index_name`, `seq`, `column_name`, `desc`, `collation`, `unique`, `partial`, `tags`.
- **`check_constraint_info(table_name)`** — one row per CHECK constraint. Columns: `id`, `name`, `expr`, `operations`, `deferrable`, `initially_deferred`, `tags`. The `expr` text is produced by `expressionToString` from the same AST stringifier that emits DDL. `operations` is a comma-joined subset of `insert,update,delete`; an empty/default mask emits the canonical `'insert,update,delete'` string.
- **`unique_constraint_info(table_name)`** — one row per (UNIQUE constraint, column) pair. Excludes the primary key (already covered by `table_info.pk`). UNIQUE constraints synthesized from `CREATE UNIQUE INDEX` appear here too.
- **`assertion_info()`** — zero-arg TVF listing `CREATE ASSERTION` objects. Columns: `name`, `violation_sql`, `deferrable`, `initially_deferred`, `dependent_tables` (JSON array of `{relationKey, base}`).

### Tag encoding

Tags are emitted as a JSON object (TEXT). When the underlying object has no tags (either undefined or an empty record), the column yields SQL NULL so `WHERE tags IS NULL` cleanly filters untagged objects. BigInt values are coerced to JSON-safe numbers/strings via the existing `jsonStringify` helper in `src/util/serialization.ts`.

A small `tagsToJson` helper at the top of `schema.ts` keeps the encoding DRY across every TVF.

### Reserved-word column names

`generated`, `desc`, `unique`, and `deferrable` are SQL reserved keywords. Users must double-quote them when selecting from the TVFs:

```sql
select name, "generated" from table_info('t');
select index_name, "desc", "unique" from index_info('t');
select name, "deferrable" from check_constraint_info('t');
```

## Validation summary

- `yarn workspace @quereus/quereus run typecheck` → clean.
- `yarn workspace @quereus/quereus run lint` → clean.
- `yarn test` (full repo) → 2705 quereus tests + every other package pass.
- `06.3.3-introspection-tags.sqllogic` covers tagged + untagged tables, views, indexes; column tags + collation + virtual/stored generated columns; tagged + untagged FKs (single and composite); index_info layout (ASC/DESC, partial, unique, tagged); check_constraint_info (named with tags, unnamed without, `expr` round-trip); unique_constraint_info (named multi-column, partial-via-unique-index); assertion_info (deferred-by-default semantics, JSON dependent_tables).
- `50-metadata-tags.sqllogic` Phases 1–5 each now round-trip the tags they create through the corresponding introspection TVF.
- `tests:store` not required for this change.

## Notes for the reviewer

- `assertion_info().deferrable` and `assertion_info().initially_deferred` both yield 1 because `CREATE ASSERTION` constructs schemas with `deferrable: true, initiallyDeferred: true` (see `src/runtime/emit/create-assertion.ts:37-38`). The test asserts this rather than the parsed AST values.
- `dependent_tables` may be an empty JSON array (`'[]'`) if best-effort discovery fails; the test only asserts `json_valid()` to avoid coupling to internal discovery timing.
- No backwards-compat shims. Downstream consumers (`quoomb-cli`, `quoomb-web`, `quereus-vscode`, `shared-ui`) were swept — none unpack rows positionally, so the added columns are non-breaking.
- Things parked in a future ticket per the original plan: flat `tags()` TVF, mutation-context introspection, vtab-arg introspection, schemas list TVF, `defaultConflict` exposure, statistics TVF.

## Suggested review focus

- Sanity-check the column types on each new TVF in `src/func/builtins/schema.ts`.
- Sanity-check the JSON shape of `tags` and `dependent_tables` against an in-memory call (handful of `select` examples in `docs/functions.md`).
- Spot-check `expressionToString(cc.expr)` output for a non-trivial CHECK constraint — does the rendered SQL parse back cleanly?
- Confirm `unique_constraint_info` correctly skips the primary key and correctly surfaces the partial-unique constraint synthesized by `addIndexToTableSchema`.
- Confirm `index_info` ordering matches the index-column declaration order, not column-index order in the parent table.
