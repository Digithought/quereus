---
description: Review ALTER TABLE RENAME COLUMN propagation through CTEs in view bodies
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## What changed

### `packages/quereus/src/schema/rename-rewriter.ts` — column-rename visitor

Added CTE-aware scope tracking so an `alter table T rename column C to NC` rewrites
references to `C` inside outer SELECTs that pull from a CTE which re-exposes that
column. Previously only inner CTE bodies were rewritten; the outer reference was
left unchanged, breaking views that combined CTEs.

- Extended `ScopeFrame` with `ctesExposingRenamed: Set<string>`.
- New helpers:
  - `emptyFrame()` — shared frame constructor.
  - `pushWithFrame(withClause, state)` — pushes a with-frame, visits each CTE
    body, and registers names that re-expose the renamed column. Caller is
    responsible for popping. Used by SELECT/INSERT/UPDATE/DELETE cases so the
    with-frame is on the stack while the rest of the statement (FROM, WHERE,
    RETURNING…) is visited.
  - `analyzeWithFrame(withClause, state)` — rebuilds a with-frame's exposure
    map *without* re-visiting CTE bodies; used during the post-visit exposure
    analysis to recover nested-WITH context.
  - `cteExposesRenamedColumn(cte, state)` — central rule. Returns `false` if
    the CTE has an explicit column list (`with c(x) as ...`). Otherwise scans
    the CTE's result columns for a passthrough match: a `{type:'all'}` whose
    source binds to the renamed table, or a `{type:'column'}` with no alias
    whose `ColumnExpr` (after rewrite) is `state.newCol` qualified-or-unqualified
    to the renamed table.
  - `isResultColumnExposure(col, bodyFrame, state)` — per-column passthrough test.
  - `isCteExposingInScope(state, name)` — scope-stack walk equivalent to
    `isTableInUnaliasedScope` / `aliasResolvesToTable`.
- `buildScopeFrame` now takes `state` (instead of just `defaultSchema`) so it
  can consult the scope stack via `collectFromBindings`.
- `collectFromBindings` now treats an unqualified `TableSource` whose name
  matches an exposing CTE in any ancestor with-frame as a binding to the
  renamed table — unaliased adds to `frame.unaliased`; aliased adds to
  `frame.aliasMap`. **Beyond the ticket's letter**: when an unaliased CTE
  reference would otherwise be invisible to qualified refs like `a.k`, the
  CTE name is also added to `frame.aliasMap` so `a.k` resolves. This was
  needed to make multi-CTE chains work where an inner CTE qualifies columns
  through the outer CTE name (see `tests` below).
- SELECT/INSERT/UPDATE/DELETE cases were refactored to push a with-frame
  before visiting CTE bodies and the rest of the statement, then pop in
  `finally`. UPDATE/DELETE keep their existing target-table frame inside
  the with-frame.

### `packages/quereus/src/parser/parser.ts` — `(WITH ...)` as subquery source

The pre-existing parser did **not** recognize `(with c as (...) select ... from c)`
as a `subquerySource` — the lookahead at `tableSource()` only checked for SELECT,
VALUES, INSERT/UPDATE/DELETE after `(`. This was a real parser gap that blocked
ticket test case 5. Two-line fix:

- `tableSource()` lookahead now accepts WITH in addition to SELECT/VALUES.
- `subquerySource()` consumes the WITH clause first, then SELECT, attaching
  the WITH to the inner SELECT's `withClause`.

This change is small and self-contained but affects more than the rename path
— any FROM-clause `(WITH ...) AS alias` now parses. Worth a careful eye in
review: are there ambiguities with the `(VALUES ...)` or compound-SELECT paths
I missed? Did I correctly preserve the `loc` / start-token behavior?

### `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`

- Section 6 uncommented (original ticket case).
- Five new sections 6a–6e covering the rules in the ticket:
  - **6a** aliased CTE projection (`select k as kk_alias from t`) — must NOT
    propagate; outer `kk_alias` stays.
  - **6b** explicit CTE column list (`with c(x) as ...`) — must NOT propagate;
    inner `k → kk`, outer `x` stays.
  - **6c** multi-CTE chain (`with a as (...), b as (select k from a) ...`) —
    rewrite must propagate through every link.
  - **6d** CTE inside subquery in view body — requires the parser fix above.
  - **6e** `select *` in CTE body — star passthrough at runtime; outer `k`
    must rewrite to `kk`.

## Verification

- `node test-runner.mjs` (default in-memory vtab path): **3098 passing**, 2 pending.
- `yarn lint`: clean (exit 0).
- I did **not** run `yarn test:store` (LevelDB store path) — out of scope per
  AGENTS.md ("only run when diagnosing a store-specific issue or preparing a
  release"). Reviewer may want to spot-check if confident the store path
  could see a different parse/AST flow.
- I did **not** build the other workspace packages individually beyond the
  initial `yarn workspace @quereus/quereus build` smoke. CLI/web/etc. are
  unaffected by the changes but the parser change ripples into anything that
  parses SQL.

## Use cases for review / extra testing

The visitor's scope model is still relatively shallow (CTE name as an
implicit alias, no proper shadowing semantics). Edge cases to probe:

1. **CTE that shadows the renamed table.** `with t_x as (select 0 as k) select k from t_x`
   where `t_x` is also a real table being column-renamed. My code treats the
   CTE as exposing if its body happens to bind to the real `t_x` somewhere —
   but here the CTE body doesn't reference `t_x`, so `ctesExposingRenamed`
   stays empty and the outer `from t_x` falls through to the real-table path.
   Worth a unit test.

2. **CTE with mixed exposing / non-exposing result columns.** A CTE
   projects `[id, k]` where `id` is from the renamed table but only `k` is
   the renamed column. Exposure analysis fires on the first match; check
   that the visitor doesn't double-rewrite or skip legitimate refs in the
   outer.

3. **Qualified outer ref to exposing CTE.** `with a as (select k from t) select a.k from a` —
   handled via the "CTE name → aliasMap" trick I added beyond the ticket.
   The ticket didn't ask for this; it might be controversial. Without it,
   multi-CTE chains where the inner body uses `from a` (no alias) would
   fail when later code references `a.k`. My new tests use unqualified
   refs throughout, so this path is technically untested by the new SQL
   logic suite. **Consider adding a test for `select a.k from a` if you
   want this guarantee.**

4. **Recursive CTE.** Out of scope per the ticket (recursive CTEs almost
   always have column lists). My code returns `false` from
   `cteExposesRenamedColumn` for any CTE with `columns`. Worth a sanity
   check that a recursive CTE without a column list (unusual but legal)
   doesn't break analysis.

5. **CTE body that's INSERT/UPDATE/DELETE … RETURNING.** I deliberately
   return `false` from `cteExposesRenamedColumn` (`query.type !== 'select'`).
   This means renames don't propagate through such CTEs. Per the ticket
   this is fine, but worth confirming this matches the project's intent
   for those constructs.

6. **Parser side: `(WITH ...) AS alias` edge cases.**
   - With a column list after the alias: `(with c as ... select ... from c) s(x, y)`.
   - Without an alias at all: does the implicit alias path still kick in?
   - In a JOIN: `from foo join (with c as ... select ... from c) s on ...`.
   - In a compound expression context (set ops).
   - With trailing ORDER BY / LIMIT inside the parens.
   I sanity-tested the basic case in 6d. The other shapes are likely fine
   because they reuse the existing `subquerySource` epilogue, but reviewer
   may want to add tests.

## Known gaps / honest assessment

- **No unit test for `cteExposesRenamedColumn` directly.** The function is
  exercised entirely through the .sqllogic integration tests. If you'd
  rather see a Mocha-level test that pokes at edge cases (single CTE body
  with multiple result columns, mixed alias/non-alias projections in one
  CTE, etc.), that would be a reasonable add. The reviewer is encouraged
  to treat the integration tests as a floor.

- **Subquery-in-view propagation when there's NO inner CTE.** Test 6d
  exercises the CTE-in-subquery case. But the plain "subquery in view body
  whose body's FROM is the renamed table" — `create view v as select k from (select k from t) s` —
  was not on the ticket and I did not add a test. The existing visitor
  (and my changes) skip `subquerySource` in `collectFromBindings` because
  it's aliased; that means the outer reference to `k` does NOT propagate
  through a subquery boundary. That's pre-existing behavior. If the
  reviewer wants symmetry with the CTE case, that's a follow-up ticket.

- **`schemaPath` and WITH clauses interaction**: the parser's `parseSchemaPath`
  briefly matches `WITH` then backtracks. My `(WITH ...)` parser fix runs
  before that's reached (we're inside a parenthesized subquery, not at the
  end of a SELECT body), so I don't think there's interaction, but worth
  a moment to confirm.

## Files

- `packages/quereus/src/schema/rename-rewriter.ts` — column-rename visitor.
- `packages/quereus/src/parser/parser.ts` — `tableSource()` lookahead and
  `subquerySource()` WITH support (lines around 814 and 838).
- `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` —
  sections 6 / 6a–6e.
