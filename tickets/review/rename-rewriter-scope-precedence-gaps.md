---
description: review innermost-first shadowing fixes to rename-rewriter scope helpers
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## What landed

Three sibling helpers in
`packages/quereus/src/schema/rename-rewriter.ts` were converted from
OR / outer-first first-match-wins walks to innermost-first walks that
honor shadowing precedence. The fourth helper (`isCteInScope`) is
intentionally left as OR with a comment explaining why.

- `isCteExposingInScope` — innermost-first. Returns `true` on an
  exposing entry; returns `false` on a closer non-exposing
  `ctesInScope` hit (an inner non-exposing same-name CTE shadows an
  outer exposing one).
- `isTableInUnaliasedScope` — innermost-first. Returns `false` on a
  closer `ctesInScope.has(state.tableName)` hit (an inner same-name
  CTE shadows an outer unaliased real-table binding); returns `true`
  only on the closest `unaliased` hit when no shadowing intervenes.
- `aliasResolvesToTable` — innermost-first (was outer-first). The
  closest alias binding wins; this matches standard SQL alias
  shadowing for nested scopes.
- `isCteInScope` — left as OR. Documented inline: this helper only
  gates "is this source a CTE rather than a real table?", a question
  for which *any* enclosing CTE suffices.

`isQualifierShadowedInScope` (added in the prior ticket) was already
innermost-first and is unchanged.

No call-site reordering was needed. `cteExposesRenamedColumn` →
`analyzeWithFrame` → `buildScopeFrame` → `collectFromBindings` →
`isCteInScope` / `isCteExposingInScope` all still see only the
intended enclosing scopes; the frame-under-construction invariant
documented in the plan was verified during implementation.

### Tests added

Three sqllogic scenarios appended to
`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`
as sections 12, 13, 14:

- **§12 — Case A (`isCteExposingInScope`)**: outer WITH declares an
  exposing same-name CTE; a nested subquery's own WITH declares a
  non-exposing same-name CTE; the subquery's `from t_nest` must bind
  to the inner non-exposing CTE, and the inner `t_nest.k` must NOT
  rewrite to `t_nest.kk`. Pre-fix the outer-exposing entry wins via
  OR, the inner source is bound as the renamed real table, and the
  inner `t_nest.k` rewrites incorrectly — the saved view body then
  evaluates to an error at view-eval time (inner CTE has no `kk`
  column). Post-fix, `select * from v_nest` returns `[{"x":0}]`.

- **§13 — Case B (`isTableInUnaliasedScope`)**: outer SELECT's FROM
  has the renamed real table (so the outer from-frame has it in
  `unaliased`); a nested derived-table subquery (CROSS JOIN'd to the
  outer table because Quereus doesn't accept comma joins) introduces
  a same-name non-exposing CTE in its WITH; the inner unqualified
  `k` must resolve to the inner CTE row source, not to the outer
  real-table binding. Pre-fix the outer `unaliased.has('t_exb')`
  wins via OR and the inner `k` rewrites to `kk`. Post-fix,
  `select * from v_exb` returns `[{"outer_k":50,"inner_k":0}]`.

- **§14 — Case C (`aliasResolvesToTable`)**: outer `from t_alia as a`
  binds alias `a` to the renamed table; a scalar subquery in the
  SELECT list does `from t_alia_other as a`, rebinding `a` to a
  different table. The subquery's `a.k` must refer to t_alia_other.
  Pre-fix the outer-first walk finds the outer `a → t_alia`
  (= state.tableName) first and rewrites `a.k` to `a.kk`; the saved
  view body then fails at eval time because t_alia_other has no
  `kk` column. Post-fix, `select * from v_alia` returns
  `[{"inner_k":20}]`.

All three tests use the project's standard end-to-end pattern (build
schema → ALTER → query the dependent view) rather than inspecting
the rewritten SQL, matching the existing 6a–6p style.

### Note on Case C shape

The plan mentioned the alias rebinding "may be hard to express
cleanly" and offered the option to skip. The scalar-subquery shape
(`select (subq) as inner_k from t_alia as a` with the subquery doing
`from t_alia_other as a`) is the cleanest minimal repro: two scopes,
two same-text aliases, two distinct tables. Both tables need a `k`
column (otherwise the saved view body parses fine pre-fix but the
rewriter never fires anyway). Adding the second table is the only
contrivance.

## Use cases for the reviewer to verify

- Confirm the four helpers' walk direction and shadowing semantics
  match SQL scoping intuition:
  - `isCteExposingInScope`: inner non-exposing CTE shadows outer
    exposing same-name CTE.
  - `isTableInUnaliasedScope`: inner same-name CTE shadows outer
    real-table unaliased binding.
  - `aliasResolvesToTable`: innermost alias wins.
  - `isCteInScope`: intentionally OR — verify the inline comment's
    reasoning ("any enclosing CTE suffices for the gate's
    question").
- Sanity-check by tracing one of the existing tests (e.g. §6m, §6p)
  through the new helpers — the previously passing scenarios should
  still pass with the same gates firing.
- Audit `state.scopeStack` walks one more time end-to-end — I
  confirmed only the four helpers above walk the stack besides
  `isQualifierShadowedInScope` (and push/pop sites, which are not
  walks).

## Known gaps / things to double-check

- Case C's contrivance: the test needs a second table just to give
  the inner alias something distinct to bind to. If a reviewer
  finds a shape that uses only one table while still rebinding the
  alias, that would be cleaner — but I didn't find one.
- The `select *` case in Case B works because the outer columns are
  ResultColumn type='all' and are skipped by `visitColumnRename`
  (only type='column' result columns are walked); at eval time `*`
  re-expands against the renamed table's current columns. This is
  the same handling pre- and post-fix.
- An unrelated optimizer fuzz test ("Optimizer Equivalence — all
  rewrite rules disabled produces identical results") failed on a
  randomly-seeded run during validation. The failing SQL touches no
  ALTER / rename / schema-mutation code path; it's a pre-existing
  fuzz finding orthogonal to this ticket. Reviewer may want to
  re-run the fuzz tests for a sanity check.

## Validation

- `yarn workspace @quereus/quereus run test --grep "41.3"` —
  41.3-alter-rename-propagation.sqllogic passes (1/1).
- `yarn workspace @quereus/quereus run test --grep "alter|rename|SQL Logic Tests"` —
  203/203 passing across all sqllogic files, the MemoryVTable
  alterSchema tests, and the schema-differ ALTER detection tests.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn test:store` not run — fix is internal to the AST rewriter
  in `src/schema/`; no store-specific code path is involved.

## Docs

`docs/schema.md` covers ALTER propagation at a high level. The fix
is an internal precedence correction; no user-visible behavior
beyond the new test scenarios changes. The test file itself
documents the new covered shapes (§12, §13, §14). No doc updates
needed.
