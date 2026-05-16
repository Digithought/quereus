---
description: Pre-register recursive CTE names in scope before visiting their bodies so self-references aren't mistaken for the renamed table
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Summary

Fixes the recursive-CTE self-reference shadowing gap filed as a
follow-up from the review of
`alter-rename-propagation-cte-shadowing-renamed-table`.

In `pushWithFrame`, each CTE body was visited *before* its name was
added to `frame.ctesInScope`. That ordering is correct for
non-recursive WITH (a non-recursive body must not see itself), but for
`with recursive` the body must see itself — otherwise a
`from <cte-name>` inside the recursive step is treated as the renamed
real table, and column-rename rewriting corrupts the body.

## Change

`packages/quereus/src/schema/rename-rewriter.ts`:

- In `pushWithFrame`, when `withClause.recursive === true`, register the
  CTE's name in `frame.ctesInScope` *before* visiting its body.
  Non-recursive WITH keeps the existing ordering (name registered only
  after the body, so a non-recursive body does not see itself).
- `cteExposesRenamedColumn` is still called after the body has been
  visited — exposure analysis is unchanged.
- The duplicate `frame.ctesInScope.add(nameLower)` after the body visit
  is idempotent on the recursive path (Set semantics).
- Doc comment on `pushWithFrame` updated to call out the recursive
  vs. non-recursive ordering invariant.

`analyzeWithFrame` was **not** modified. It is only called from
`cteExposesRenamedColumn` to rebuild the inner WITH frame of a CTE
body's own `select.withClause` — that inner WITH is a *child* of the
CTE body's SELECT, not the outer recursive WITH that contains it.
When the recursive CTE under analysis is referenced from inside its
own body, `isCteInScope` walks the entire `state.scopeStack` and finds
the CTE in the outer with-frame (already populated by `pushWithFrame`),
so no change to `analyzeWithFrame` is needed.

## Tests

Added to `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`:

- **6j** — Recursive CTE named the same as the renamed table, **no
  explicit column list**, with a self-reference inside the recursive
  step. The body of the recursive step (`select k+1 from t_rec where
  k < 3`) must keep `k` as `k` (resolves to the CTE column), not
  rewrite to `kk`. Without the fix this hits `Column not found: kk` at
  plan time (confirmed by stash-and-rerun: see "Without-fix
  verification" below).

- **6k** — Same shape with an explicit column list (`t_rec_cl(k)`).
  This regression-guards the column-list short-circuit path. Worth
  noting: the column-list short-circuit only makes the CTE
  *non-exposing* — it does **not** skip body rewriting. Without the
  recursive-pre-registration fix this case also fails (the recursive
  step would be rewritten to `select kk+1 from t_rec_cl where kk < 3`,
  and the CTE has column `k`). The original ticket said 6k "already
  passes today"; that turns out to be incorrect — 6k fails without
  the fix too. Both 6j and 6k now exercise the same fix.

## Validation

- `yarn workspace @quereus/quereus run test` → 3167 passing, ~2m. No
  regressions in 41.3 (sections 1–11, plus new 6j/6k) or elsewhere.
- `yarn workspace @quereus/quereus run lint` → exit 0, silent.
- **Without-fix verification:** stashed only `rename-rewriter.ts` and
  re-ran the 41.3 file with the new tests present. Got
  `QuereusError: Column not found: kk` at
  `packages/quereus/src/planner/resolve.ts:64` for 6j — confirming the
  bug repro and that the fix is what makes 6j/6k pass. Then restored
  the stash.

## Reviewer notes / gaps to probe

- **`analyzeWithFrame` recursive flag (intentionally not changed):**
  see the rationale above. If a future case turns up where the inner
  rebuild needs to also pre-register for recursive nesting, the same
  one-line `if (withClause.recursive) frame.ctesInScope.add(...)` would
  apply.
- **No new test for `with recursive` *inside* an `update`/`delete`
  context** with a same-named target — both UPDATE/DELETE call
  `pushWithFrame`, so the fix carries over. No regression test added
  for that shape; consider whether one is warranted.
- **No test for sibling recursive CTEs** (e.g. `with recursive a as
  (...), t_sib as (... from t_sib ...)`). Sibling-shadow non-recursive
  is covered by 6i; sibling-shadow-with-recursive is not. The fix logic
  handles it (each iteration of the for-loop pre-registers the current
  CTE before visiting), but no explicit regression case exists.
- **The original ticket's 6k claim is stale:** it asserted the
  column-list short-circuit already protected this case. It does not —
  see Tests section above. Mentioned for the reviewer's awareness only;
  no action required, the fix handles both.

## End
