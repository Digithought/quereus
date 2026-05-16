---
description: Review fix that suppresses directHit column rewrite when the qualifier resolves to a non-exposing shadowing CTE
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Summary

When `ALTER TABLE t RENAME COLUMN k TO kk` ran against a view body
shaped like

```sql
with t as (select 0 as k) select t.k from t
```

the rewriter previously rewrote the qualified `t.k` to `t.kk` because
the qualifier text matched the renamed real table (`directHit`) — even
though scope binds `from t` to the non-exposing CTE, not the real
table. Result: the saved view body referenced a non-existent CTE
column.

## Fix

`packages/quereus/src/schema/rename-rewriter.ts`:

- Extended `ScopeFrame` with `ctesShadowingSource: Set<string>`,
  initialized in `emptyFrame()`.
- In `collectFromBindings`, the shadowing-non-exposing branch now
  records the unaliased source name in `frame.ctesShadowingSource`
  (aliased shadowing sources can only be qualified via their alias,
  which `aliasResolvesToTable` already handles correctly).
- New `isQualifierShadowedInScope(state, qualifier)` walks the scope
  stack innermost-first. It returns true if it finds a shadowing entry
  for the qualifier first; a closer rebind to the renamed real table
  (alias or unaliased) wins and returns false.
- The `column` case in `visitColumnRename` now gates `directHit` on
  `!isQualifierShadowedInScope(state, qualifierLower)`.

## Behavior changes

Only qualified column refs whose qualifier resolves (in the nearest
enclosing scope) to a non-exposing shadowing CTE are now suppressed.
All other paths are unchanged:

- Aliased shadowing CTE (`from t_shadow2 as a` + `a.k`) — unchanged;
  `directHit` was already false because the qualifier is the alias.
- Unqualified refs against a shadowing CTE — unchanged; the non-exposing
  branch already avoids adding the source to `frame.unaliased`.
- Outer scope binds the renamed real table while an inner scope
  shadows it — the innermost-first walk picks the inner shadow only
  for refs inside the inner scope; outer refs still rewrite.

## Tests

Added sections 6m, 6n, 6o to
`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`:

- **6m** Unaliased qualified ref against a non-exposing shadowing CTE:
  `select t_shadow3.k from t_shadow3` inside a `with t_shadow3 as (...)`.
- **6n** Sibling shadowing CTE inside a multi-WITH; qualified ref
  against the shadowing sibling's name.
- **6o** Recursive shadowing CTE; qualified self-reference
  (`t_rec2.k`) inside the recursive step.

All three would have failed before the fix (the saved view body would
reference `kk`, which the shadowing CTE doesn't expose). Now all three
return the CTE-projected rows, leaving the real table's column rename
unaffected.

## Validation

- `yarn workspace @quereus/quereus run test` — **3172 passing**.
  All of 6a–6l (existing scenarios), 6m–6o (new), and the rest of the
  suite pass.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0, no
  warnings).
- `yarn test:store` not run — the fix touches only the AST rewriter
  in `src/schema/`; no store-specific code path is involved. The
  ticket explicitly notes `yarn test` suffices.

## Reviewer focus / known gaps

- The fix targets qualified refs whose qualifier textually matches the
  renamed table name. Qualified refs whose qualifier matches an *alias*
  (`a.k` where `a` was an alias for the shadowing CTE) were already
  handled correctly by the existing `aliasResolvesToTable` path —
  worth confirming this is still true.
- `isQualifierShadowedInScope` early-returns on a closer rebind to the
  renamed real table. The reasoning for the precedence (innermost
  binding wins) is documented in the helper's comment; please sanity-
  check the nesting interactions (e.g. inner SELECT shadows but outer
  SELECT binds the real table — only the inner ref should be
  suppressed).
- Pre-existing latent bug — not introduced by the prior
  recursive-CTE-self-ref fix. The new tests intentionally use fresh
  table names (`t_shadow3`, `t_sib2`, `t_rec2`) to keep them
  independent of 6g–6l.
- No change to schema, runtime, or planner — only the rename-time AST
  rewriter and its sqllogic tests.

## Notes

- No docs touched: `docs/schema.md` covers ALTER propagation at a high
  level and doesn't enumerate shadowing-CTE edge cases.
- The new scope-frame field is initialized everywhere via
  `emptyFrame()`, so no other call sites needed updating.
