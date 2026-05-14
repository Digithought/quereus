---
description: `SchemaManager.dropIndex` removes the dropped index from `tableSchema.indexes` but does not remove the matching `UniqueConstraintSchema` entry that `addIndexToTableSchema` derived for UNIQUE indexes — leaving a stale uniqueness check that can no longer be backed by an index.
files:
  packages/quereus/src/schema/manager.ts
---

## Context

`SchemaManager.addIndexToTableSchema` (manager.ts:1250-1265) does two things
when creating a UNIQUE index:

1. Append to `tableSchema.indexes`.
2. Append a derived `UniqueConstraintSchema` (carrying `name`, `columns`,
   `predicate`) to `tableSchema.uniqueConstraints`.

`SchemaManager.dropIndex` (manager.ts:1316-1323) only does the inverse of step
1 — it filters `indexes`. The derived `uniqueConstraints` entry is left
behind. After DROP INDEX:

- Any future INSERT/UPDATE that would have violated the unique constraint
  still fails with a uniqueness error, even though the user dropped the
  enforcing index.
- If the constraint resolution finds no matching index (in modules that look
  one up by name/columns), it may fall back to a slow scan, producing
  surprising performance.

## Why latent today

`@quereus/store`'s `StoreModule` does not implement `dropIndex` — DROP INDEX
on a USING store table is currently a no-op at the storage layer. The
in-memory `MemoryTableManager` path also has its own constraint handling that
may mask the issue. This bug becomes user-visible whenever a vtab module
implements `dropIndex` and DDL-issued DROP INDEX is exercised.

## Discovery

Surfaced during review of `store-table-create-index-schema-not-updated`
(complete/), which fixed the symmetric *create* side: that fix added the
UNIQUE → uniqueConstraints derivation in `StoreModule.createIndex` to mirror
the engine. The drop side has the inverse omission in the engine itself.

## Expected behavior

`dropIndex` should compute the updated `uniqueConstraints` array by removing
any entry whose `name` matches the dropped index's name (since
`addIndexToTableSchema` uses the index name as the constraint name when
deriving from a UNIQUE index). This must NOT remove uniqueConstraints that
came from CREATE TABLE-level `UNIQUE` constraints — those have a name from
the AST or none at all, never the dropped-index's name.

Care: a CREATE TABLE-time UNIQUE constraint *might* by coincidence have the
same name as a later-dropped index. Safer: track derived-vs-declared origin
explicitly (e.g. add `derivedFromIndex?: string` to UniqueConstraintSchema
and only filter constraints whose `derivedFromIndex` matches). Decide during
plan stage.
