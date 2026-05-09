---
description: Rename detection in `diff schema` / `apply schema` driven by `with tags` hints (`quereus.id`, `quereus.previous_name`) instead of dropping + creating.
prereq:
files:
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/schema/rename-rewriter.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/schema/ddl-generator.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/view.ts
  docs/sql.md
  docs/schema.md
  packages/quereus/test/logic/

---

## Problem

`computeSchemaDiff` matches declared and actual objects by lowercased name. A rename therefore looks like a drop of the old name plus a create of the new name. Under FK enforcement and seed/data assumptions this is destructive and surprising — and it can fail outright when the dropped table has dependents.

## Approach

Use the existing `WITH TAGS` feature (see `tickets/complete/3-metadata-tags.md`) to carry rename metadata declaratively. Tags are already attached to tables, columns, constraints, views, and indexes; they're informational and excluded from schema hashing — exactly the contract rename hints need.

Two recognized hint shapes, both under a reserved dotted namespace `quereus.*` (parses fine via double-quoted identifier — the lexer at `packages/quereus/src/parser/lexer.ts:547` strips the quotes and keeps the dot literal):

1. **`quereus.previous_name`** — string. Single old name, or a comma-separated list when more than one prior name exists. Matches by old-name lookup in the actual catalog.
2. **`quereus.id`** — opaque stable key chosen by the schema author. The differ keeps a side index of `(stable_id → object)` for both declared and actual sides; when ids match across sides, it's the same object regardless of name. `id` wins over `previous_name` when both could match.

Both are *hints*, not authoritative — if the resolved old object doesn't exist, fall through to normal create. If both `previous_name` resolution and the new declared name match different existing objects, it's a conflict (error, gated by `rename_policy`).

### Scope

Apply to: tables, views, indexes, columns, named constraints. Columns inherit table renames implicitly; per-column `previous_name` is needed for column renames inside an unrenamed table.

### Diff representation

Add to `SchemaDiff` (in `packages/quereus/src/schema/schema-differ.ts`):

```ts
interface RenameOp {
  kind: 'table' | 'view' | 'index' | 'constraint';
  oldName: string;
  newName: string;
}
interface ColumnRenameOp {
  oldName: string;
  newName: string;
}
interface SchemaDiff {
  // existing fields...
  renames: RenameOp[];
}
interface TableAlterDiff {
  // existing fields...
  columnsToRename: ColumnRenameOp[];     // applied before columnsToAdd / columnsToDrop
  constraintsToRename?: ColumnRenameOp[]; // applied before constraint adds (if engine supports)
}
```

Resolution order inside `computeSchemaDiff`:

1. Build `(stable_id → declared)` and `(stable_id → actual)` maps from `quereus.id` tags.
2. For each declared object whose name is **not** present in actual:
   a. If `quereus.id` matches an actual id whose name differs → emit rename, mark actual as consumed.
   b. Else if `quereus.previous_name` (each comma-separated entry, lowercased and trimmed) resolves to an unconsumed actual whose name differs → emit rename, mark actual as consumed.
   c. Else → create.
3. After matching, the existing "actual not in declared" loop only proposes drops for objects that weren't consumed by a rename.
4. Column/constraint renames are surfaced on the same `TableAlterDiff`. The same id/previous_name resolution runs over `declared.tableStmt.columns` vs `actual.columns` for the surviving (post-rename) table identity.

### DDL emission

In `generateMigrationDDL`, renames emit before creates and before drops, before per-table column renames within `tablesToAlter`:

- Table rename: `ALTER TABLE old RENAME TO new`
- Column rename: `ALTER TABLE t RENAME COLUMN old TO new` — emit before `columnsToAdd` / `columnsToAlter` / PK change / `columnsToDrop` so subsequent ops see the post-rename column set.
- View rename: drop + recreate (no `RENAME VIEW` primitive yet — record TODO follow-up).
- Index rename: drop + recreate (same).
- Constraint rename: if a primitive doesn't exist, drop + recreate of the constraint.

The existing `rename-rewriter.ts` propagates references through dependent objects — the apply path reuses it via the standard `ALTER TABLE ... RENAME` pipeline, which already wires the rewriter in.

### Safety / policy

`apply schema ... options (rename_policy = 'allow' | 'require-hint' | 'deny')`:

- `allow` (default): use hints when present; fall through to create+drop otherwise.
- `require-hint`: any name change without a matching hint is an error rather than a drop+create.
- `deny`: ignore hints and always drop+create (escape hatch / regression on the destructive path).

The parser already accepts `rename_policy = '<string>'` in the OPTIONS clause (`packages/quereus/src/parser/parser.ts:3019`), but the AST type currently restricts the literal to `'require-hint' | 'infer-id'`. **Update the type to `'allow' | 'require-hint' | 'deny'`** in `packages/quereus/src/parser/ast.ts:633` and `packages/quereus/src/parser/parser.ts:3021`. Also update `packages/quereus/src/emit/ast-stringify.ts:114` (which already round-trips the value).

`computeSchemaDiff` must accept a `policy` parameter (default `'allow'`) so `emitDiffSchema` and `emitApplySchema` (`packages/quereus/src/runtime/emit/schema-declarative.ts`) can thread it through. `diff schema` doesn't have an OPTIONS clause yet; its policy is always `'allow'` for v1.

This composes with the future `allow_destructive` gate — `require-hint` plus `allow_destructive=false` is the safe migration default.

### Tag namespace

Reserved keys: `quereus.id`, `quereus.previous_name`. Keys in this namespace must use the quoted-identifier form (`"quereus.id"`). Any unrecognized `quereus.*` key is a soft warning (logged via the schema-differ logger) — do not error, future versions may add new keys.

Document the reserved set in `docs/sql.md §2.6.3` (the WITH TAGS subsection) and in `docs/schema.md`.

### Catalog plumbing

The differ today operates on `CatalogTable`/`CatalogView`/`CatalogIndex` (in `packages/quereus/src/schema/catalog.ts`). Tags live on `TableSchema`/`ColumnSchema`/etc. but aren't projected into the catalog snapshot. Add `tags?: Readonly<Record<string, SqlValue>>` to:

- `CatalogTable` — populated from `TableSchema.tags` in `tableSchemaToCatalog`.
- Each entry of `CatalogTable.columns` — populated from `ColumnSchema.tags`.
- `CatalogView` — populated from `ViewSchema.tags`.
- `CatalogIndex` — populated from `IndexSchema.tags`.
- `CatalogTable.namedConstraints` — new field listing named constraints with their tags (for constraint rename detection).

### Example

```sql
declare schema main {
  table customer with tags (
    "quereus.id" = 'tbl-customer',
    "quereus.previous_name" = 'client'
  ) {
    customer_id integer primary key with tags ("quereus.previous_name" = 'client_id'),
    full_name text not null with tags ("quereus.previous_name" = 'name')
  }
}
```

Against an actual catalog containing `client(client_id, name)` this should diff to one `RENAME TABLE` plus two `RENAME COLUMN`, no drops or creates.

## Open questions / deferrals

- View/index rename primitives: accept drop+recreate for v1; file a follow-up if profiling shows it matters.
- Heuristic column-rename matching (no hints, types/positions strongly suggest a rename): out of scope. Always require a hint.

## Tests (new sqllogic file: `packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic`)

- Table rename via `quereus.previous_name` → diff yields one `ALTER TABLE old RENAME TO new`; apply preserves rows.
- Table rename via `quereus.id` (with a non-matching `quereus.previous_name`) → still renames; `id` is authoritative.
- Column rename inside an otherwise-unchanged table.
- Multi-step history: declared `quereus.previous_name = 'a, b'` matches an actual named `a` *or* `b`.
- Conflict: declared name and `quereus.previous_name` both resolve to existing different actual objects → error under `rename_policy = 'allow'` (per spec — conflict is always an error, not a fall-through).
- `rename_policy = 'require-hint'` rejects an unhinted name change with a clear error.
- `rename_policy = 'deny'` produces drop+create even when hints are present.
- Schema hash unchanged whether rename hint tags are present or absent (regression on the metadata-tags hashing rule, `packages/quereus/src/schema/schema-hasher.ts`).
- Combined: table rename + column rename + new column add in one apply, FK to the renamed table preserved.

## TODO

### Phase 1 — AST/parser/types

- Update `ApplySchemaStmt.options.renamePolicy` to `'allow' | 'require-hint' | 'deny'` in `packages/quereus/src/parser/ast.ts`.
- Update the cast in `packages/quereus/src/parser/parser.ts:3021` and validate the string against the allowed set (throw a parse error on unknown values, default to `'allow'` when unspecified).
- Verify `ast-stringify.ts` round-trips the new values (no change should be needed; spot-check).

### Phase 2 — Catalog

- Add `tags` to `CatalogTable`, `CatalogView`, `CatalogIndex`, and to each `CatalogTable.columns` entry, in `packages/quereus/src/schema/catalog.ts`.
- Add `namedConstraints: Array<{ name: string; tags?: Readonly<Record<string, SqlValue>> }>` to `CatalogTable`, populated from `tableSchema.checkConstraints`, `uniqueConstraints`, `foreignKeys` (only entries with a `name`).
- Wire population in `tableSchemaToCatalog`, `viewSchemaToCatalog`, and the index loop in `collectSchemaCatalog`.

### Phase 3 — Differ

- Add helper `readQuereusHint(tags, key)` in `schema-differ.ts` that pulls `quereus.<key>` from a tag bag and returns it (case-sensitive key, value lowercased for name lookups).
- Add `RenameOp` and `ColumnRenameOp` types; add `renames: RenameOp[]` to `SchemaDiff` and `columnsToRename: ColumnRenameOp[]` (and optional `constraintsToRename`) to `TableAlterDiff`.
- Refactor the four "create vs alter" loops (tables, views, indexes, named constraints) into a small generic resolver that takes `{declared, actual, getTags(declared), getTags(actual), getName(...)}` and emits `RenameOp` + a `consumed` Set, returning the surviving (matched) pairs for downstream alter analysis.
- Run constraint/column rename detection inside `computeTableAlterDiff` against the table identity that survived rename matching (use the *actual* table that was matched to the declared one, by id/previous_name, not by name).
- Conflict detection: if both the declared name and a hint-resolved old name point to distinct existing actuals, throw `QuereusError` ('Rename conflict for `<kind> <new>`: declared name and `previous_name`/`id` resolve to different existing objects').
- Plumb a `policy: RenamePolicy` argument through `computeSchemaDiff` (default `'allow'`). On `'require-hint'`, any unhinted "declared not in actual but actual has an unmatched object" pair → error. On `'deny'`, skip the rename resolver entirely.

### Phase 4 — DDL generation

- In `generateMigrationDDL`:
  - Emit table renames first (before drops, creates, alters).
  - For views/indexes/constraints in the `renames` list with no engine primitive, expand into a drop + create pair injected into the existing buckets (so the topo-ordering of drops still applies).
  - Inside each `TableAlterDiff`, emit `ALTER TABLE t RENAME COLUMN old TO new` *before* `ADD COLUMN`, `ALTER COLUMN`, `ALTER PRIMARY KEY`, and `DROP COLUMN`.

### Phase 5 — Runtime wiring

- In `packages/quereus/src/runtime/emit/schema-declarative.ts`, thread `applyStmt.options?.renamePolicy ?? 'allow'` into the `computeSchemaDiff` call inside `emitApplySchema`. `emitDiffSchema` keeps `'allow'` (no OPTIONS clause yet).
- No changes expected to `rename-rewriter.ts` — the existing `ALTER TABLE ... RENAME` plumbing already invokes it.

### Phase 6 — Docs & tests

- Update `docs/sql.md §2.6.3` (WITH TAGS subsection) with the reserved namespace and rename example.
- Update `docs/schema.md` "Schema Diffing" / "Migration Application" sections with the rename behavior and `rename_policy` knob.
- Add new sqllogic test `packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic` covering the cases listed under "Tests" above.
- Run `yarn workspace @quereus/quereus run test` and `yarn workspace @quereus/quereus run lint`. Fix any breakages.
- (Skip `yarn test:store` — store-mode is for release/store-specific diagnosis only.)
