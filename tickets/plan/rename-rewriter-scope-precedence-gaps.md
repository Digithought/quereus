---
description: rename-rewriter scope-resolution helpers don't respect shadowing for nested same-name CTEs/aliases
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Background

The rename-rewriter in `packages/quereus/src/schema/rename-rewriter.ts`
maintains a `scopeStack: ScopeFrame[]` while walking dependent SQL
during `ALTER TABLE … RENAME COLUMN`. Several helper predicates
inspect that stack to decide whether a qualifier or table name
resolves to the renamed real table:

- `isCteInScope(name)`
- `isCteExposingInScope(name)`
- `isTableInUnaliasedScope()`
- `aliasResolvesToTable(alias)`

All four walk the frames as an unordered OR (or, for
`aliasResolvesToTable`, outer-first with first-match-wins). The
shadowing-non-exposing fix added `isQualifierShadowedInScope`, which
*does* walk innermost-first with explicit precedence checks — but the
other four helpers still don't.

## Latent failure modes

These haven't been surfaced by tests yet, but follow straight from
the OR-walks. All assume `ALTER TABLE t RENAME COLUMN k TO kk`.

### A. Outer-exposing vs inner-non-exposing same-name CTE

```sql
create view v as
  with t as (select t.k from t)        -- outer CTE: exposes renamed column
  select x from (
    with t as (select 0 as k)          -- inner CTE: shadowing, non-exposing
    select t.k as x from t             -- t.k refers to INNER CTE
  );
```

In the inner SELECT's `collectFromBindings` for `from t`:

- `isCteInScope('t')` is true (correct).
- `isCteExposingInScope('t')` is also **true**, because it ORs over
  all frames — and the outer frame has `t` in `ctesExposingRenamed`.
- The exposing branch fires: `frame.unaliased.add(state.tableName)`
  and `frame.aliasMap.set('t', state.tableName)`.
- `t.k` is then treated as a `directHit` (or `viaAlias`) on the
  renamed real table → rewritten to `t.kk`, which the inner CTE
  doesn't expose. Saved view body breaks.

The fix is to walk these helpers innermost-first and stop at the
first frame whose `ctesInScope` (or `unaliased`) contains the name —
i.e., respect shadowing semantics.

### B. `isTableInUnaliasedScope` doesn't respect inner shadowing

```sql
update t set v = (
  with t as (select 0 as k)
  select k from t                 -- unqualified k → INNER CTE column
);
```

The outer UPDATE pushes a frame with `unaliased = {'t'}`. The inner
SELECT's FROM-frame doesn't add `t` to `unaliased` (the shadowing-
non-exposing branch deliberately skips it). But
`isTableInUnaliasedScope` ORs across all frames — it returns true
because the outer frame still has `t`. → unqualified `k` rewrites
to `kk`, even though it refers to the inner CTE.

Fix: walk innermost-first; stop when a closer frame has `t` in
`ctesInScope` (shadowing) regardless of whether the closer frame
puts `t` in `unaliased`.

### C. `aliasResolvesToTable` walks outer-first

```ts
for (const frame of state.scopeStack) {
  const target = frame.aliasMap.get(aliasLower);
  if (target !== undefined) return target === state.tableName;
}
```

Outer-first first-match-wins. If an outer frame binds alias `a` to
the renamed table and an inner frame rebinds `a` to something else,
the outer wins. Should be innermost-first.

In practice this is rare (most aliases are scope-local), but it's
the same class of bug.

## Proposed approach

Replace each helper's walk with an innermost-first scan that
considers shadowing:

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

`isCteInScope` is OK as a boolean OR (we only care whether the name
matches *some* CTE in scope when deciding that the unqualified
source binds to a CTE row source rather than a real table — the
nearest binding is always the relevant one because nested same-name
CTEs all qualify as "CTE in scope").

`collectFromBindings` currently calls `isCteInScope` and
`isCteExposingInScope` while building the same frame the helpers
look at. The helpers must continue to ignore the frame currently
being built (it isn't on `scopeStack` yet — `buildScopeFrame` adds it
after). Verify ordering remains correct.

## Tests to add

Append to `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`:

- Nested same-name CTEs where outer exposes and inner shadows
  non-exposing; assert inner refs (qualified and unqualified) don't
  rewrite. (Case A.)
- UPDATE with a same-name CTE in a subquery; assert the inner
  unqualified `k` doesn't rewrite. (Case B.)
- Nested aliases of the same name; assert innermost wins. (Case C —
  may be hard to express without contrivance.)

## Notes

- Surfaced during review of
  `alter-rename-column-qualified-ref-to-shadowing-cte`. Pre-existing;
  not introduced by either that fix or the earlier
  `alter-rename-recursive-cte-self-ref-shadowing` fix. The current
  test corpus does not cover these shapes, so the bugs are latent.
- All three issues are the same shape — OR/outer-first walks of a
  stack that should be innermost-first with explicit shadowing
  precedence. A single pass that audits every walk of `scopeStack`
  in `rename-rewriter.ts` is probably warranted.
