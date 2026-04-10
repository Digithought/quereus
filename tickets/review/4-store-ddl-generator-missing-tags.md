description: Added WITH TAGS emission to quereus-store DDL generator for table, column, and index tags
files:
  - packages/quereus-store/src/common/ddl-generator.ts
  - packages/quereus-store/test/ddl-generator.spec.ts
---

# Store DDL Generator — WITH TAGS Emission

## What was done

The store's `generateTableDDL()` and `generateIndexDDL()` in `ddl-generator.ts` now emit `WITH TAGS` clauses, fixing a round-trip bug where tags were silently dropped during persist/restore via the `__catalog__` KV store.

### Changes to `ddl-generator.ts`

- Imported `SqlValue` type from `@quereus/quereus`
- Added `formatTagValue()` — formats tag values as SQL literals (booleans as TRUE/FALSE, unlike `formatArgValue` which uses 1/0)
- Added `formatTagsClause()` — formats a tags record as `WITH TAGS (key = value, ...)`
- Emit column-level `WITH TAGS` after default value in the column definition loop
- Emit table-level `WITH TAGS` after USING clause
- Emit index-level `WITH TAGS` after columns list

## Testing

14 tests pass in `ddl-generator.spec.ts` (11 existing + 3 new):

- **"emits table-level WITH TAGS"** — `TableSchema.tags` with `display_name` (string) and `audit` (boolean TRUE)
- **"emits column-level WITH TAGS"** — `ColumnSchema.tags` with `display_name` (string) and `searchable` (boolean)
- **"emits index-level WITH TAGS"** — `IndexSchema.tags` with `label` (string) and `priority` (number)
- **"does not emit WITH TAGS when tags are empty"** — verifies no spurious output for empty tag objects

Run: `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/ddl-generator.spec.ts" --reporter min --colors`

## Scope note

Constraint-level tags (CHECK, FOREIGN KEY, UNIQUE) cannot be emitted because those constraint types themselves are not yet emitted by the DDL generator. That is a separate parity issue.
