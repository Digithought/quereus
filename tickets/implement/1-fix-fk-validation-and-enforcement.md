description: FK validation/enforcement gaps — align CREATE-TABLE FK default action with ADD-COLUMN (`'restrict'`), always emit child-side EXISTS check, fail child INSERT/UPDATE when parent table is missing, validate child/parent column-count parity at CREATE, block DROP of an FK-referenced parent that still has children, and trim the obsolete 'ignore' parent-action.
prereq:
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41-fk-extended-targets.sqllogic
  packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic
  packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic
----

## Root causes

Investigation traced all seven gaps in `tickets/fix/1-fix-fk-validation-and-enforcement.md` to **four** underlying defects.

### 1. The default FK action is `'ignore'`, which silently disables enforcement

`schema/manager.ts:701,729` (table-level **and** column-level FK extraction inside `extractForeignKeys`) sets

```ts
onDelete: fk.onDelete ?? 'ignore',
onUpdate: fk.onUpdate ?? 'ignore',
```

…and `planner/building/foreign-key-builder.ts:137-138` opens `buildChildSideFKChecks` with

```ts
// Skip entirely-ignored FKs (both actions are 'ignore' = no enforcement)
if (fk.onDelete === 'ignore' && fk.onUpdate === 'ignore') continue;
```

Net effect: any FK declared without explicit `ON DELETE` / `ON UPDATE` clauses is **completely unenforced** — neither the child-side EXISTS check nor any parent-side action runs. `parseForeignKeyAction` (parser.ts:3698-3700) also maps `NO ACTION` → `'ignore'`, so even the explicit SQL spelling is silently informational. This single defect explains:

- **fix item 2** — `references no_such_parent(id)` (no actions) → both default to `'ignore'` → check skipped.
- **fix item 3** — `foreign key (x, y) references mp2(b, a)` (no actions) → both default to `'ignore'` → check skipped. The order-respecting wiring inside `synthesizeExistsCheck` is already correct (it pairs `parentColIndices[i]` with `fk.columns[i]`); it just never runs.
- **fix item 4** — `fc references fb` (no actions) → both default to `'ignore'`. When `update fa` cascades to `fb`, the parent-side path on `fb` (`foreign-key-builder.ts:276` `if (action !== 'restrict') continue;`) finds no RESTRICT and never raises. The cascade succeeds and `fc.b_id` orphans silently.
- **fix item 5** — `tree (foreign key (pid, tag) references tree(id, tag))` — bare FK → default `'ignore'` → skipped.
- **fix item 7** — `t2 (c integer null references t1 deferrable initially deferred, ...)` — bare FK → default `'ignore'` → skipped (deferrability is irrelevant when the check is never enqueued).

A previous ticket (`tickets/complete/1-fix-alter-add-column-constraint-enforcement.md`) already changed the **ADD COLUMN** path in `runtime/emit/alter-table.ts:295-296` to default to `'restrict'`. Its closing note explicitly defers aligning the CREATE-TABLE path to a separate ticket — this one.

### 2. Child/parent FK column-count parity is not validated at DDL time

`extractForeignKeys` resolves child columns to indices but never compares `con.columns.length` (table-level FK) or `[childColIndex]` (column-level FK) against `fk.columns.length`. The mismatch surfaces only in `foreign-key-builder.ts:151-154` and `runtime/foreign-key-actions.ts:61` as a silent `continue` once the parent is resolved. `fix item 1` (`foreign key (x) references mp(a, b)` with one child column referencing two parent columns) lands here.

Note: when `fk.columns` is *undefined* (no parent column list), arity is whatever the parent's PK arity turns out to be — that has to remain a runtime-resolution check, since the parent may not exist yet (and standard SQLite-style deferred resolution applies).

### 3. Missing parent table is treated as “check skipped” rather than “check fails on non-NULL key”

`buildChildSideFKChecks` short-circuits when the parent table is unresolved:

```ts
if (!parentSchema) {
    log(`FK check skipped: parent table '${fk.referencedTable}' not found`);
    continue;
}
```

MATCH SIMPLE allows the row when *any* FK column is NULL. Otherwise, with no parent table in existence, no parent row can match — the check **must** fail. The expression to emit in this case is just the null-guard chain `col1 IS NULL OR col2 IS NULL OR ...`, with no EXISTS subquery (which couldn't be built anyway). `fix item 2`.

### 4. `dropTable` does not check for outstanding child references

`schema/manager.ts:432-509` (`dropTable`) does not scan the schema for FKs whose `referencedTable`/`referencedSchema` matches the table being dropped, nor does it check whether such child tables still have non-NULL FK rows. SQLite (with `foreign_keys=ON`) rejects the DROP when extant children would be orphaned. `fix item 6`.

## Plan

A single coordinated change across schema, planner, parser, and runtime — all four root causes are tightly interlocked.

### Phase A — Make the default FK action enforce (root cause #1)

Pick `'restrict'` as the default for unspecified `ON DELETE` / `ON UPDATE`. This matches what ADD COLUMN already does (parity), is the simplest of the available semantics, and also serves the SQL `NO ACTION` cases in our test corpus correctly (the cascade-RESTRICT chain test only requires that the orphaning cascade *fails the statement*, which `'restrict'` does immediately and `'noAction'` would do at end-of-statement — both pass the test). Introducing a separate `'noAction'` value is deferred.

Concrete edits:

- `schema/manager.ts:701,729` — change `?? 'ignore'` → `?? 'restrict'` on both code paths in `extractForeignKeys`.
- `parser/parser.ts:3698-3700` — `parseForeignKeyAction` returns `'restrict'` (not `'ignore'`) for `NO ACTION`. After this, `'ignore'` is unreachable from SQL.
- `planner/building/foreign-key-builder.ts:137-138` — delete the `if (fk.onDelete === 'ignore' && fk.onUpdate === 'ignore') continue;` skip. The child-side EXISTS check should run for *every* declared FK regardless of parent-action settings; whether the parent row mutates differently is a parent-side concern.
- `runtime/foreign-key-actions.ts:58` — drop the `'ignore'` arm; condition becomes `if (action === 'restrict') continue;`.
- `parser/ast.ts:461` — remove `'ignore'` from `ForeignKeyAction` once nothing references it. Update `schema/table.ts:343,345` doc comments to say the default is `'restrict'`.
- `runtime/emit/alter-table.ts:285-296` — collapse the explanatory comment now that CREATE TABLE and ADD COLUMN agree.
- `test/logic/06.3.2-schema-foreign-keys.sqllogic:30` — expected output rewires from `"on_update":"ignore","on_delete":"ignore"` to `"on_update":"restrict","on_delete":"restrict"`. (The introspection test is the one place that pinned the old default.)

### Phase B — Validate FK arity at CREATE / ADD COLUMN (root cause #2)

In `extractForeignKeys` (and the analogous code path in `runtime/emit/alter-table.ts` used by ADD COLUMN), when `fk.columns` is provided, assert that its length matches the child column count. Throw `QuereusError(StatusCode.ERROR, ...)` with a message that names the constraint and both arities. When `fk.columns` is undefined, leave validation to enforcement time (parent PK arity isn't known yet).

Apply identically for both column-level FK (child arity is always 1) and table-level FK (child arity = `con.columns.length`).

### Phase C — Make missing-parent FK fail on non-NULL child rows (root cause #3)

In `buildChildSideFKChecks`, when `parentSchema` is null, **build a constraint expression** instead of skipping. Use only the existing null-guard chain (already constructed at lines 77-86):

```ts
return nullGuards.reduceRight<AST.Expression>(
  (acc, guard) => ({ type: 'binary', operator: 'OR', left: guard, right: acc } as AST.BinaryExpr),
  /* falsy sentinel */ { type: 'literal', value: 0 } as AST.LiteralExpr,
);
```

That is: the expression is `col1 IS NULL OR col2 IS NULL OR ... OR FALSE`. It evaluates to true exactly when MATCH SIMPLE allows the row, and false otherwise — at which point the synthetic constraint fails like any other. Reuse the rest of the existing scope/build path for the expression.

### Phase D — Block DROP TABLE while children reference the parent (root cause #4)

In `manager.ts:dropTable`, before mutating any state (and only when `foreign_keys` PRAGMA is on), iterate all schemas / tables and for each FK whose `referencedTable.toLowerCase() === tableName.toLowerCase()` and matching `referencedSchema`, run a quick existence query against the child table. The check is "any row whose FK columns are all non-NULL (MATCH SIMPLE → would have required a parent match)". If any such row exists, throw `QuereusError(StatusCode.CONSTRAINT, "FOREIGN KEY constraint failed: ... still has rows referencing ...")`.

Implementation note: the existing `executeForeignKeyActions` uses `db._execWithinTransaction(SQL, params)` to issue scoped DML; the same primitive isn't ideal here because we need a *result* (any row). The pragmatic approach is to call `db.eval`/`db.allRows` (whichever is the read-only read-without-mutex path) — match the pattern used by deferred-constraint evaluators in `runtime/deferred-constraint-queue.ts:runDeferredRows` if a similar read primitive exists. If a clean read primitive doesn't exist, document the limitation and gate this phase behind a follow-up — but verify first; the codebase already issues nested SELECTs in cascade actions, so a read-side equivalent should be reachable.

### Phase E — Verification

Uncomment all `-- TODO bug:` blocks in:

- `test/logic/41-fk-extended-targets.sqllogic` (lines 123-131, 137-148, 153-175)
- `test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic` (lines 48-74, 100-122, 128-141, 147-170)

Note that the **INSERT OR IGNORE** block (lines 11-38 of `41-fk-cascade-conflict-and-self-ref.sqllogic`) is a *separate* concern (`INSERT OR IGNORE` not skipping FK violations) — leave it commented; it’s not part of this ticket and warrants a different fix.

Run `yarn test` from the repo root. Spot-check via `yarn workspace quereus mocha test/runner.ts -- --grep "fk"` if the harness supports it; otherwise the full logic-test pass is fine. Do NOT run `yarn test:store` unless investigating a store-specific regression.

## Risks / things to watch

- Removing `'ignore'` from the type union may surface latent uses in tests, plugins, or sample data. Search for `'ignore'` literal in `packages/quereus/src` and `test/logic` after the type change and adjust.
- The introspection-test rewrite is the only fixture that pins the old `'ignore'` default; any other place that compares against the literal must be updated too. Grep `on_delete\|on_update` across `test/`.
- The DROP-table existence check needs to skip itself when the FK is self-referential and the parent **is** the table being dropped (a row in `tree` referencing itself isn't an externally orphaned row — it's going away with the table). For self-FK, treat the check as vacuous: if `child === parent`, ignore. Self-FK orphan detection happens at the row's own INSERT/UPDATE time, not at DROP.
- `_execWithinTransaction` runs the SQL inside the surrounding implicit/explicit transaction. The DROP-time check must NOT mutate state — use a read-only path. If your read path opens its own connection, ensure it sees the in-flight transaction.
- Phase A flips the surface behavior of every existing FK in user code. There's no migration path needed inside Quereus — no persisted FK action enums survive across versions of the engine — but tests written against the old behavior will surface as regressions. Address each concretely; do not paper over them by re-adding `'ignore'`.

## TODO

Phase A — defaults & enforcement:

- Change `extractForeignKeys` defaults in `schema/manager.ts` (lines ~701, ~729) from `'ignore'` to `'restrict'`.
- Change `parseForeignKeyAction` in `parser/parser.ts` (line ~3700) to return `'restrict'` for `NO ACTION`.
- Delete the both-`'ignore'` skip in `planner/building/foreign-key-builder.ts` (line ~138).
- Drop the `'ignore'` arm in `runtime/foreign-key-actions.ts` (line ~58).
- Remove `'ignore'` from `ForeignKeyAction` in `parser/ast.ts` (line ~461). Update doc comments in `schema/table.ts` (~343, ~345).
- Tighten / remove the explanatory comment in `runtime/emit/alter-table.ts` (~285-296).
- Update introspection-test expectations in `test/logic/06.3.2-schema-foreign-keys.sqllogic` (line ~30).

Phase B — CREATE-time arity validation:

- In `extractForeignKeys`, when `fk.columns` (parent column list) is provided, assert `fk.columns.length === childColIndices.length` (table-level) or `=== 1` (column-level). Throw with a clear message naming the constraint.
- Mirror the same check in the ADD-COLUMN FK extraction in `runtime/emit/alter-table.ts`.

Phase C — runtime check when parent table is missing:

- In `foreign-key-builder.ts:buildChildSideFKChecks`, replace the `if (!parentSchema) { ...; continue; }` early-out with: build the null-guard chain terminated by a `0` literal, package it as a `RowConstraintSchema`, and push it through the same constraint-build pipeline. Use the existing `qualifier` for child column references; no parent scope is needed.

Phase D — DROP TABLE child-existence check:

- In `manager.ts:dropTable`, before `removeConnectionsForTable`, when `foreign_keys` is on, scan `_getAllSchemas() → getAllTables() → foreignKeys` for matches against the table being dropped (skipping self-references). For each match, run a read-only existence query: `SELECT 1 FROM "<child>" WHERE <fk_col1> IS NOT NULL AND <fk_col2> IS NOT NULL ... LIMIT 1`. If any row, throw `QuereusError(StatusCode.CONSTRAINT, ...)`.
- Verify the same SQL primitive used by cascade actions (`db._execWithinTransaction` or its read-side counterpart) is appropriate; if not, locate a read primitive that runs without acquiring the mutex (we’re already inside one).

Phase E — verification:

- Uncomment all `-- TODO bug:` blocks (except the `INSERT OR IGNORE` block at the top of `41-fk-cascade-conflict-and-self-ref.sqllogic` lines 11-38, which is a separate concern).
- `yarn test` clean. Investigate and fix any regression that surfaces.
- Lint clean: `yarn workspace quereus lint`.
