---
description: fix rename-rewriter scope helpers to respect innermost-first shadowing precedence
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Background

The rename-rewriter walks dependent SQL during `ALTER TABLE … RENAME COLUMN`
maintaining a `scopeStack: ScopeFrame[]`. The existing
`isQualifierShadowedInScope` helper already walks innermost-first with
explicit shadowing precedence, but four sibling helpers still walk the stack
as an unordered OR (or outer-first first-match-wins). That produces three
latent miscompiles when nested same-name CTEs / aliases shadow each other:

- **Case A** — `isCteExposingInScope`: outer-exposing + inner-non-exposing
  same-name CTE. Inner refs incorrectly rewrite because the outer's
  exposing entry wins via OR.
- **Case B** — `isTableInUnaliasedScope`: same-name CTE in a subquery of an
  UPDATE/DELETE. The outer frame's `unaliased` entry wins via OR, so the
  inner unqualified column rewrites even though it refers to the inner CTE.
- **Case C** — `aliasResolvesToTable`: walks outer-first first-match-wins,
  so an outer alias that maps to the renamed table beats an inner rebinding.

All three are the same shape: OR / outer-first walks of a stack that should
be innermost-first with explicit shadowing precedence. See the plan ticket
of the same name in `tickets/complete/` for full case sketches.

## Approach

Replace the four helpers with innermost-first walks that honor shadowing.
`isCteInScope` stays as an OR (we only ask whether *some* CTE in scope owns
the name; the nearest such binding is always the relevant one).

```ts
function isTableInUnaliasedScope(state: ColumnRewriteState): boolean {
  for (let i = state.scopeStack.length - 1; i >= 0; i--) {
    const frame = state.scopeStack[i];
    if (frame.ctesInScope.has(state.tableName)) return false; // shadowed
    if (frame.unaliased.has(state.tableName)) return true;
  }
  return false;
}

function isCteExposingInScope(state, name): boolean {
  for (let i = state.scopeStack.length - 1; i >= 0; i--) {
    const frame = state.scopeStack[i];
    if (frame.ctesExposingRenamed.has(name)) return true;
    if (frame.ctesInScope.has(name)) return false; // inner non-exposing wins
  }
  return false;
}

function aliasResolvesToTable(state, alias): boolean {
  const aliasLower = alias.toLowerCase();
  for (let i = state.scopeStack.length - 1; i >= 0; i--) {
    const target = state.scopeStack[i].aliasMap.get(aliasLower);
    if (target !== undefined) return target === state.tableName;
  }
  return false;
}
```

### Invariant: helpers ignore frame-under-construction

`collectFromBindings` calls `isCteInScope` and `isCteExposingInScope` while
building the `from` frame. The helpers walk `state.scopeStack`, and the
new frame is not pushed until *after* `buildScopeFrame` returns, so the
helpers correctly see only the enclosing scopes. The same applies to
`pushWithFrame` (CTEs see the with-frame they are in, but the per-CTE
exposure analysis happens inside `cteExposesRenamedColumn`, which pushes
the body's own scopes). No call-site reordering is required — just verify
during implementation.

### Why `isCteInScope` stays OR

`isCteInScope` only gates whether `collectFromBindings`' "is this source a
CTE rather than a real table?" branch fires. If *any* enclosing scope has a
same-name CTE, an unqualified `from t` resolves to a CTE, not the renamed
table. The nearest matching CTE is the one that binds, but for this gate's
question (CTE-or-real-table?) any match suffices.

## Tests to add

Append to `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`
(after section 11):

- **Case A** — `create table t(k); create view v as with t as (select t.k
  from t) select x from (with t as (select 0 as k) select t.k as x from
  t)` then `alter table t rename column k to kk`. Assert the inner
  `select t.k as x from t` does NOT rewrite — the saved view body's inner
  `select t.k` stays as `t.k` (it references the inner non-exposing CTE).
- **Case B** — `create view v as select * from t where exists (with t as
  (select 0 as k) select k from t)`. After rename, the inner unqualified
  `k` must stay as `k`, not `kk`. (Or equivalently a subquery in a SELECT
  expression — pick whichever shape is easiest to express in
  sqllogic.)
- **Case C** — nested aliases of the same letter, inner rebinding to a
  different table. Express with `from t as a, (select 0 as k) as a` or
  similar to force an alias rebind. May be hard to express cleanly; if
  contrivance dominates, document the gap in a comment and skip the
  sqllogic case — the unit-test coverage from Cases A/B is the
  high-value bit.

Each test should:
  1. Build the schema and dependent object (view or check).
  2. Run `alter table … rename column …`.
  3. Query the dependent object and assert the result reflects that the
     inner reference was NOT rewritten (typically by checking that the
     view still returns the expected pre-rename data, or by inserting a
     value that would fail if the wrong column got renamed).

For the assertion, prefer end-to-end behavior (e.g. `select … from v;
→ [...]`) over inspecting the rewritten SQL — the existing tests in
41.3 already follow that pattern.

## TODO

- Replace `isTableInUnaliasedScope` with innermost-first walk that returns
  false on a closer `ctesInScope` hit.
- Replace `isCteExposingInScope` with innermost-first walk that stops on a
  closer `ctesInScope` hit when there's no exposing entry.
- Replace `aliasResolvesToTable` walk direction (outer-first → innermost-first).
- Audit every walk of `state.scopeStack` in `rename-rewriter.ts` once more
  to confirm no other OR/outer-first walks remain.
- Add the three (or two if Case C proves too contrived) sqllogic tests to
  `41.3-alter-rename-propagation.sqllogic`.
- Run `yarn workspace @quereus/quereus run test` and ensure the full
  41.3 file (plus any tests that reference rename-rewriter behavior) passes.
- Run `yarn workspace @quereus/quereus run lint` over `src/schema/`.
