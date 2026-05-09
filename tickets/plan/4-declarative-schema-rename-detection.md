---
description: Rename detection in `diff schema` / `apply schema` driven by `with tags` hints, instead of dropping + creating.
prereq: declarative-schema-enhancements
files:
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/schema/rename-rewriter.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/planner/building/alter-table.ts
  docs/sql.md
  docs/schema.md
  packages/quereus/test/logic/

---

## Problem

`computeSchemaDiff` matches declared and actual objects by lowercased name. A rename therefore looks like a drop of the old name plus a create of the new name. Under FK enforcement and seed/data assumptions this is destructive and surprising — and it can fail outright when the dropped table has dependents.

The original `4-declarative-schema-enhancements` backlog mentioned this work; it's split out here so it can move on its own.

## Approach

Use the existing `with tags` feature (see `tickets/complete/3-metadata-tags.md`) to carry rename metadata declaratively, so the source of truth lives inside the schema declaration and round-trips through DDL/stringify like any other tag. Tags are already attached to tables, columns, constraints, views, and indexes; they're informational and excluded from schema hashing — exactly the contract rename hints need.

Two recognized hint shapes, both under a reserved namespace so they don't collide with user tags:

1. **`previous_name`** — single string, comma-separated when more than one prior name exists. Matches by old-name lookup in the actual catalog. Use when a stable id wasn't introduced before the first rename.
2. **`id`** — opaque stable key chosen by the schema author. The differ keeps a side index of `(stable_id → object)` for both declared and actual sides; when ids match across sides, it's the same object regardless of name. `id` wins over `previous_name` when both could match.

Both are *hints*, not authoritative — if the resolved old object doesn't exist, fall through to normal create. If both `previous_name` resolution and the new declared name match different existing objects, that's a conflict (error or `rename_policy`-gated, see below).

### Scope

Apply to: tables (highest value), views, indexes, columns, named constraints. Columns inherit table renames implicitly; per-column `previous_name` is needed for column renames inside an unrenamed table.

### Diff representation

Add to `SchemaDiff`:

```ts
interface RenameOp {
  kind: 'table' | 'view' | 'index' | 'column' | 'constraint';
  parentTable?: string;   // for column/constraint
  oldName: string;
  newName: string;
}
interface SchemaDiff {
  // existing fields...
  renames: RenameOp[];
}
```

Resolution order inside `computeSchemaDiff`:

1. Build `(stable_id → declared)` and `(stable_id → actual)` maps from `tags.id`.
2. For each declared object whose name is **not** present in actual:
   a. If `tags.id` matches an actual id whose name differs → emit rename, mark actual as consumed.
   b. Else if `tags.previous_name` resolves to an unconsumed actual whose name differs → emit rename, mark actual as consumed.
   c. Else → create.
3. After matching, the existing "actual not in declared" loop only proposes drops for objects that weren't consumed by a rename.
4. Column/constraint renames are surfaced as additional ops on the same `TableAlterDiff`; they emit before `columnsToAdd`/`columnsToDrop` so add/drop see the post-rename column set.

### DDL emission

Renames emit before creates and before drops in `generateMigrationDDL`, using the existing primitives:
- Table: `ALTER TABLE old RENAME TO new`
- Column: `ALTER TABLE t RENAME COLUMN old TO new`
- View: drop + create (no `RENAME` primitive yet — flag this in the ticket; a follow-up can add `ALTER VIEW RENAME` if needed).
- Index: drop + create (same caveat).
- Constraint: depends on what the engine supports today; if no primitive exists, fall back to drop+recreate of the constraint.

The existing `rename-rewriter.ts` propagates references through dependent objects — the apply path reuses it via the standard `ALTER TABLE ... RENAME` pipeline.

### Safety / policy

Add an `apply schema ... options (rename_policy = 'allow' | 'require-hint' | 'deny')` knob (parser scaffolding for the options block already appears in `docs/sql.md` examples):

- `allow` (default for now): use hints when present; fall through to create+drop otherwise.
- `require-hint`: any name change without a matching hint is an error rather than a drop+create.
- `deny`: ignore hints and always drop+create (escape hatch for testing the destructive path).

This composes with the planned `allow_destructive` gate from the parent ticket — `require-hint` plus `allow_destructive=false` is the safe migration default.

### Tag namespace

Reserve a dotted prefix to avoid colliding with user tags. Proposed: `quereus.previous_name`, `quereus.id`. Tag keys today are identifiers — confirm dotted keys parse, or fall back to underscore form (`q_previous_name`, `q_id`). Either way, document the reserved set in `docs/sql.md §2.6.3` and `docs/schema.md`.

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

Against an actual catalog containing `client(client_id, name)` this should diff to two `RENAME COLUMN` plus one `RENAME TABLE`, no drops or creates.

## Open questions

- Tag-key syntax for the reserved namespace (dotted vs. underscored) — needs a parser check, not a design decision.
- How aggressive should column-rename matching be when both `id` and `previous_name` are absent but column types/positions strongly suggest a rename? Default: do nothing; require a hint. Heuristic matching is out of scope.
- View/index rename primitives — accept drop+recreate for v1, file a follow-up if profiling shows it matters.

## Tests (sketch)

`packages/quereus/test/logic/` (new sqllogic file):

- table rename with `previous_name` → exactly one `RENAME TABLE` row from `diff schema`; `apply schema` preserves data.
- table rename with `id` (different `previous_name`) → still renames; `id` is authoritative.
- column rename inside otherwise-unchanged table.
- multi-step history: declared `previous_name = 'a, b'` matches an actual named `a` *or* `b`.
- conflict: declared name and `previous_name` both resolve to existing different actual objects → error.
- `rename_policy = 'require-hint'` rejects an unhinted name change.
- `rename_policy = 'deny'` produces drop+create even when hints are present.
- schema hash is unchanged whether tags are present or absent (regression on the metadata-tags hashing rule).
