---
description: Rename detection in `diff schema` / `apply schema` driven by `with tags` hints (`quereus.id`, `quereus.previous_name`) instead of dropping + creating.
prereq:
files:
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic
  packages/quereus/test/schema-differ.spec.ts
  packages/quereus/test/schema-manager.spec.ts
  docs/sql.md
  docs/schema.md

---

## Summary

Implements rename detection for `diff schema` / `apply schema`. Renames are driven by reserved metadata tags `quereus.id` (stable identifier, authoritative) and `quereus.previous_name` (one or comma-separated old names). When the differ can resolve a declared object's missing name to an actual object via either hint, it emits a rename instead of a drop + create.

Scope: tables, views, indexes, named (table-level) constraints, and columns. Tables and columns rename via existing `ALTER TABLE ... RENAME` primitives (which already invoke the rename rewriter for dependents); views, indexes, and named-constraint renames currently fall through to drop + recreate via the standard buckets.

A new `OPTIONS (rename_policy = 'allow' | 'require-hint' | 'deny')` knob controls strictness. `'allow'` (default) uses hints when present and falls through. `'require-hint'` rejects any unhinted name change (drops + creates of the same kind both present after rename matching). `'deny'` ignores hints entirely.

A conflict — declared name and a hint resolving to two distinct existing actuals — is always an error regardless of policy beyond `'deny'`.

## Code paths

- AST + parser: `ApplySchemaStmt.options.renamePolicy` widened to `'allow' | 'require-hint' | 'deny'`; parser validates the literal at parse time and rejects unknown values.
- `CatalogTable` / `CatalogView` / `CatalogIndex` and per-column entries now carry `tags`; `CatalogTable.namedConstraints` surfaces named CHECK / UNIQUE / FK constraints with their tags.
- `computeSchemaDiff(declared, actual, policy?)` now takes a third `RenamePolicy` argument (default `'allow'`). A generic `resolveRenames<D, A>` helper handles tables, views, indexes, columns, and named constraints uniformly.
- `SchemaDiff.renames: RenameOp[]` is new; `TableAlterDiff.columnsToRename` and `TableAlterDiff.constraintsToRename` are new.
- `generateMigrationDDL` emits `ALTER TABLE old RENAME TO new` for table renames before drops/creates, and `ALTER TABLE t RENAME COLUMN old TO new` first within each per-table alter block.
- `emitApplySchema` threads `applyStmt.options?.renamePolicy ?? 'allow'` into `computeSchemaDiff`. `emitDiffSchema` keeps `'allow'`.
- Parser fix: trailing `WITH TAGS` after an *unnamed* inline column constraint now attaches to the **column** rather than the constraint. Named constraints (`CONSTRAINT <name> ...`) still capture their own tags. Without this fix, the docs example `customer_id integer primary key with tags ("quereus.previous_name" = ...)` would not have parsed the way the spec describes (rename hints would have ended up on the PK constraint, where the differ doesn't read them).

## Reserved tag namespace

- `"quereus.id"` — stable string identifier. Wins over `previous_name` when both could match.
- `"quereus.previous_name"` — old name(s); comma-separated when more than one.
- Unrecognized `quereus.*` keys log a soft warning via `schema:differ:warn`. Future versions can add new keys without breaking older parsers.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 2704 passing, 0 failing, 2 pending (the 2 pending tests are pre-existing).
- `yarn build` (full monorepo) — clean.

## Use cases / test coverage

`packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic` covers (numbered as in the test file):

1. Table rename via `quereus.previous_name` — diff yields one `ALTER TABLE old RENAME TO new`; apply preserves rows; round-trip diff is empty.
2. Table rename via `quereus.id` (id wins over a non-matching `previous_name`).
3. Column rename inside an otherwise-unchanged table — diff yields `ALTER TABLE t RENAME COLUMN`; data preserved.
4. Multi-step `previous_name = 'a, b'` resolves to whichever of `a` or `b` actually exists.
5. Conflict: declared name and `previous_name` both resolve to existing distinct actuals → `Rename conflict for table 'foo'` error.
6. `rename_policy = 'require-hint'` rejects an unhinted name change with a clear error.
7. `rename_policy = 'deny'` produces drop+create even when hints are present (data loss demonstrated).
8. Combined: table rename + column rename + new column add in one apply, with FK from a child table to the renamed parent preserved (FK enforcement still fires).

Schema-hash stability with/without rename-hint tags is already covered by `test/schema/catalog.spec.ts` (`stripTagsFromDeclaredSchema` unit tests). Tags are stripped from canonical DDL before hashing.

## Reviewer focus

- The generic `resolveRenames<D, A>` helper. Confirm:
  - Conflict detection fires when both name and hint resolve to distinct existing actuals.
  - Under `'deny'`, only name matches are produced; no hints are read.
  - Under `'require-hint'`, an unhinted name change throws *after* rename matching, so name-matched objects don't trip the policy check.
- DDL emission order in `generateMigrationDDL`: renames → drops → creates → alters; within an alter block, RENAME COLUMN precedes ADD/ALTER/DROP COLUMN.
- The parser fix in `columnConstraint`: only consume trailing `WITH TAGS` for **named** column constraints. Confirm no test regressions from this change. (`test/schema-manager.spec.ts` updated to reflect the corrected behavior — unnamed-constraint trailing tags now attach to the column.)
- `CatalogTable.namedConstraints` is populated only for entries with a `name`; cross-schema FKs and self-FKs are excluded from `referencedTables` (unchanged behavior).
- `quereus.previous_name` parses comma-separated lists with whitespace tolerance and case-insensitive name matching.

## Deferrals (out of scope, noted in plan)

- View / index / constraint rename primitives — currently drop+recreate when hinted. File a follow-up if profiling shows this matters.
- Heuristic rename matching without hints (column type/positional similarity) — explicitly out of scope; always require a hint.
- The `diff schema` statement does not yet accept an OPTIONS clause; its policy is fixed at `'allow'` for v1. `apply schema` is where the knob lives.

## End
