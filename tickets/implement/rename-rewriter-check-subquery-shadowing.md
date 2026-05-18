---
description: Fix the CHECK-aware rename rewriter so a subquery nested inside a CHECK doesn't rewrite an unqualified column ref that legitimately binds to a like-named column on the subquery's FROM. Plumb a schema-aware "does this source expose column X?" callback from `alter-table.ts` into `renameColumnInCheckExpression` and consult it when walking the scope stack — an inner frame whose FROM exposes the renamed column captures the unqualified ref and stops the walk before it reaches the CHECK-seed binding to the renamed table.
prereq:
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

# Fix CHECK-rename rewriter to respect inner-FROM shadowing of unqualified refs

## Problem (recap)

`renameColumnInCheckExpression`
(`packages/quereus/src/schema/rename-rewriter.ts:287-312`) seeds the
scope stack with a single frame `{ unaliased: { <renamedTable> } }`
so the CHECK's top-level unqualified refs (the CHECK has no FROM)
resolve to the owning table. A nested subquery pushes its own FROM
frame, but `isTableInUnaliasedScope` (lines 424-431) walks the
stack innermost-first and falls through past the subquery's frame
whenever that frame has neither the renamed table in `unaliased`
nor a same-name CTE in `ctesInScope`.

Reproducer:

```
create table t (id integer primary key, v integer,
                check ((select min(v) from u) > 0));
create table u (id integer primary key, v integer);
alter table t rename column v to vv;
-- before this fix: CHECK becomes `(select min(vv) from u) > 0`
--                  → broken at next plan time, `u` has no `vv`
```

The rewriter can't statically tell the inner `v` is `u.v` rather
than a correlated outer ref to `t.v` without schema info.

## Approach (option #1 from the fix ticket)

Thread a column-lookup callback through `renameColumnInCheckExpression`
(and the underlying `ColumnRewriteState`) so the rewriter can ask
"does table `<schema>.<name>` have a column named
`<state.oldCol>`?" while walking. When walking outward in
`isTableInUnaliasedScope`, the first frame whose FROM sources
expose the renamed column "captures" the unqualified ref — stop and
return `false`. The CHECK-seed frame is special: it represents the
renamed table itself (which by definition has `oldCol`), so the
seed legitimately captures the ref when no inner frame did.

The same callback can be plumbed through `renameColumnInAst` for
symmetry (option, not required to fix the reproducer) — the
non-CHECK entry path already lacks the seed problem, but the
inner-shadowing case applies there too whenever a top-level
statement has the renamed table in its FROM and a nested subquery
introduces a same-name column on a different source. Keeping the
fix isolated to `renameColumnInCheckExpression` is fine for this
ticket; mention in code comments that the rest of the rewriter has
the same latent issue.

## Design details

### Callback shape

```ts
/**
 * Returns whether the named source table has a column matching
 * `state.oldCol`. Implementation looks up the table in the catalog;
 * `undefined` schema means default schema. Used by the scope walk
 * to decide whether an inner FROM frame captures an unqualified
 * column ref before the walk reaches an outer binding to the
 * renamed table.
 */
type ResolveColumnInSource = (
  schemaName: string,
  tableName: string,
  columnName: string,
) => boolean;
```

Stored on `ColumnRewriteState` as an optional field
(`resolveColumnInSource?: ResolveColumnInSource`). When undefined,
the new walk falls back to current behavior (preserves the existing
top-level `renameColumnInAst` semantics until/unless we plumb a
callback there too).

### Capturing sources in `ScopeFrame`

`isTableInUnaliasedScope` currently only looks at `unaliased` and
`ctesInScope`. To consult the callback per frame, the frame needs
to remember which real-table sources contributed to it (with their
schema names). Add:

```ts
interface ScopeFrame {
  // … existing fields …
  /**
   * Real-table sources in this frame's FROM (schema name + table
   * name, lowercase). Aliased subqueries / function sources / CTE
   * shadowing sources are not listed — only sources we can ask the
   * callback about.
   */
  realSources: Array<{ schema: string; name: string }>;
}
```

`collectFromBindings` (`packages/quereus/src/schema/rename-rewriter.ts:342-395`)
populates `realSources` alongside `unaliased` / `aliasMap` for
every `table`-kind FROM item that resolves to a real table (i.e.
not a CTE-shadowed one). Both aliased (`from u as x`) and unaliased
(`from u`) real-table sources are recorded — for `from u as x`
asking the callback about `u`/`x` is the same question (does `u`
have column `v`?).

For the existing scope frames built by
`emptyFrame() → frame.unaliased.add(...)` (the seed frame in
`renameColumnInCheckExpression` and the synthetic UPDATE/DELETE
frames at lines 561-567, 585-592), no `realSources` entries are
added — they don't represent FROM sources, only the implicit
binding to the target table. Critically, the *seed* frame for the
CHECK rewriter must NOT participate in the "capturing" check below,
or it would unconditionally capture (the renamed table by
definition has `oldCol`). Mark seed/synthetic frames with a flag
(`isSeed: true`) or rely on `realSources.length === 0` — either
works; choose whichever reads cleaner.

### Updated `isTableInUnaliasedScope`

```ts
function isTableInUnaliasedScope(state: ColumnRewriteState): boolean {
  for (let i = state.scopeStack.length - 1; i >= 0; i--) {
    const frame = state.scopeStack[i];

    // Innermost CTE shadowing — closer CTE wins.
    if (frame.ctesInScope.has(state.tableName)) return false;

    // Capture check: if any real source in this frame exposes
    // oldCol, the unqualified ref binds there, not at an outer
    // frame. Skip for seed/synthetic frames that don't represent
    // a real FROM (realSources is empty for those by construction).
    if (state.resolveColumnInSource && frame.realSources.length > 0) {
      for (const src of frame.realSources) {
        if (src.name === state.tableName && src.schema === state.defaultSchema) {
          // The renamed table itself is in this frame — it definitely
          // exposes oldCol; the existing `unaliased` check below
          // will hit. Don't double-capture.
          continue;
        }
        if (state.resolveColumnInSource(src.schema, src.name, state.oldCol)) {
          return false;
        }
      }
    }

    if (frame.unaliased.has(state.tableName)) return true;
  }
  return false;
}
```

Order matters: CTE shadowing first (existing semantics), then the
new capture check, then the existing unaliased match. The
"skip the renamed table itself" branch keeps the behavior identical
when the inner frame *is* the renamed table (the existing path
hits `unaliased.has(state.tableName)` and returns `true`).

### Plumbing the callback in `alter-table.ts`

`rewriteTableForColumnRename`
(`packages/quereus/src/runtime/emit/alter-table.ts:964-1012`) is
the sole caller of `renameColumnInCheckExpression`. It runs inside
`propagateColumnRenameInSchema` (line 929-962) which takes a
`schema: Schema`. The full schema-manager lookup is needed (the
callback resolves arbitrary `<schema>.<table>` pairs, not just the
home schema), so pass a closure that consults `rctx.db.schemaManager`.

Lift the propagate functions to take the schemaManager (or a
narrowed accessor) so the closure can be built:

```ts
const resolveColumnInSource: ResolveColumnInSource = (s, t, col) => {
  const targetSchema = rctx.db.schemaManager.getSchema(s);
  const targetTable = targetSchema?.getTable(t);
  return targetTable?.columnIndexMap.has(col.toLowerCase()) ?? false;
};
```

Pass it into `renameColumnInCheckExpression(cc.expr, tableName,
oldCol, newCol, renamedSchemaLower, resolveColumnInSource)` at
line 980. Leave the non-CHECK call (`renameColumnInAst`) alone for
now — see "Out of scope" below.

### Edge cases the callback should handle

- **Cross-schema sources** (`from other_schema.u`): `collectFromBindings`
  records the qualified schema; the callback handles it via
  `schemaManager.getSchema(s)`.
- **Source = the renamed table** (correlated ref pattern):
  `(select min(v) from t where ...)` where `t` is the renamed
  table. The "skip the renamed table itself" branch above leaves
  the existing behavior — `unaliased.has(state.tableName)` matches
  and returns `true`, so the inner `v` rewrites correctly.
- **Source = a table without `oldCol`** (the correlated case from
  the original reproducer with a non-conflicting `u`):
  `resolveColumnInSource` returns `false`, walk continues outward,
  seed frame matches, ref rewrites — preserves the correct
  correlated behavior the fix-ticket worried about.
- **Source = aliased subquery / function source / mutating subquery /
  CTE-shadowed source**: not added to `realSources` (callback can't
  answer for these without recursive analysis). The walk falls
  through past them — same as today. A nested subquery source whose
  body projects a column named `oldCol` would still false-positive
  through the seed, but that case is rarer than the real-table case
  and is left as a known limitation (worth a backlog ticket if
  encountered).
- **Schema name capture in `collectFromBindings`**: existing code at
  line 374 already computes `schemaLower = (ts.table.schema ??
  state.defaultSchema).toLowerCase()` — use the same expression when
  populating `realSources`. The CTE-shadow branch (`isCteInScope`)
  must skip adding to `realSources` so the rewriter doesn't ask the
  callback about a CTE name.

## Test cases (sqllogic)

Add to
`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`,
following the section-15-onward numbering pattern. Each pins a
specific shadowing or correlation behavior so a future regression
trips a precise test.

- **15. CHECK subquery with like-named column on another table —
  unqualified.** The reproducer:
  ```
  create table t_chksub (id integer primary key, v integer,
                         check ((select min(v) from t_chksub_u) > 0));
  create table t_chksub_u (id integer primary key, v integer);
  insert into t_chksub_u values (1, 5);
  alter table t_chksub rename column v to vv;
  insert into t_chksub values (1, 10);  -- CHECK must still evaluate
  select count(*) from t_chksub;
  ```
  After the rename the CHECK must continue to enforce — the inner
  `v` should still resolve to `t_chksub_u.v`, not `t_chksub_u.vv`
  (which doesn't exist).

- **16. CHECK subquery with correlated outer ref — the column DOES
  belong to the renamed table.** The other table doesn't have the
  column, so unqualified `v` is a legitimate correlated ref:
  ```
  create table t_corr (id integer primary key, v integer,
                       check ((select count(*) from t_corr_u where t_corr_u.id < v) >= 0));
  create table t_corr_u (id integer primary key);  -- no `v` column
  alter table t_corr rename column v to vv;
  insert into t_corr values (1, 10);
  ```
  After rename the CHECK body must read `where t_corr_u.id < vv`.
  This pins the "walk continues past the inner frame and hits the
  seed" path.

- **17. CHECK subquery with same-name shadowing CTE.** Defensive —
  the CTE-in-scope path already handles this, but add coverage:
  ```
  create table t_chkcte (id integer primary key, v integer,
                         check ((with t_chkcte as (select 0 as v) select v from t_chkcte) >= 0));
  alter table t_chkcte rename column v to vv;
  insert into t_chkcte values (1, 1);
  ```
  The inner `v` against the CTE must NOT rewrite (CTE doesn't
  expose oldCol — there's no real `t_chkcte` source inside).

- **18. CHECK subquery with cross-schema source exposing oldCol.**
  Verifies the schema-aware path:
  ```
  -- assume an attachable schema or skip if test infra doesn't make
  -- this easy; otherwise rely on default schema and document that
  -- cross-schema is exercised by the callback's own unit-style
  -- check (see "Optional unit test" below).
  ```
  If a cross-schema fixture is awkward in sqllogic, drop this case
  and add a focused unit test in `packages/quereus/test/unit/` (or
  wherever the rename-rewriter has existing unit coverage — check
  `find_references` on `renameColumnInCheckExpression` after the
  patch lands).

## Update docstring

Rewrite the comment on `renameColumnInCheckExpression`
(`packages/quereus/src/schema/rename-rewriter.ts:268-286`) to
describe the new behavior: the helper accepts a schema-aware
column-lookup callback; when consulted at each scope frame, the
walk respects inner FROM sources that expose the renamed column,
so unqualified refs inside a subquery whose FROM has a like-named
column are no longer false-positively rewritten. Mention the
remaining limitation around aliased subquery / function-source
shadowing.

## Out of scope

- Plumbing the same callback into `renameColumnInAst` for non-CHECK
  paths. The fix ticket called this out as a symmetric issue but
  the CHECK path is the one with the user-visible reproducer (the
  seed frame is unique to CHECK). If the symmetric case surfaces,
  file a follow-up — the callback infrastructure will already exist.
- Aliased subquery / function-source / CTE-projection inner-FROM
  shadowing. Resolving these requires recursive column-set
  inference on the subquery body; defer to a backlog ticket if
  ever needed.
- The `cleanup` work to remove the multi-paragraph backlog-link
  comment block in `renameColumnInCheckExpression` — the rewrite
  in this ticket replaces it.

## TODO

- Add `ResolveColumnInSource` type alias and an optional
  `resolveColumnInSource` field on `ColumnRewriteState` in
  `rename-rewriter.ts`.
- Extend `ScopeFrame` with `realSources: Array<{ schema: string; name: string }>`;
  update `emptyFrame()` to seed it as `[]`.
- Update `collectFromBindings` to push into `realSources` for real-
  table sources (skip the CTE-shadowed branch). Capture
  `(ts.table.schema ?? state.defaultSchema).toLowerCase()` as the
  schema.
- Update `isTableInUnaliasedScope` per the "Updated …" section
  above: CTE shadowing check first, then capture check (gated on
  callback presence and skipping the renamed table itself), then
  unaliased match.
- Add an optional `resolveColumnInSource` parameter to
  `renameColumnInCheckExpression` and store it on the state.
- In `alter-table.ts → rewriteTableForColumnRename`, construct a
  closure that consults `rctx.db.schemaManager` and pass it through.
  This means lifting `rctx` (or just the schemaManager) into the
  `propagateColumnRenameInSchema` / `rewriteTableForColumnRename`
  signatures.
- Rewrite the docstring on `renameColumnInCheckExpression` to reflect
  the new behavior; drop the "see backlog ticket" sentence.
- Add sqllogic cases 15-17 (and optionally 18) to
  `41.3-alter-rename-propagation.sqllogic`.
- `yarn workspace @quereus/quereus run build` — confirm types.
- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/41.3.log` —
  verify the new cases pass and no existing ones regress. Stream
  output (see AGENTS.md § Build & Test).
- `yarn workspace @quereus/quereus run lint 2>&1 | tee /tmp/lint.log`
  — keep single-quoted globs on Windows.
- Skip `yarn test:store` unless changes here have any chance of
  affecting the store path (they don't — this is a pure-AST helper
  used during ALTER); document the skip in the review handoff.
