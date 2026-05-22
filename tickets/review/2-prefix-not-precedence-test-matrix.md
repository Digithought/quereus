description: Review the new prefix-NOT precedence matrix (`packages/quereus/test/logic/03.8-not-precedence.sqllogic`) and the one-line pointer that replaced the old witness in `02-filters.sqllogic`. Confirm the matrix actually distinguishes the correct parse from the buggy parse and that its semantics (especially the three-valued-logic NULL row) are pedantically right.
prereq: fix-prefix-not-precedence-against-comparison
files:
  packages/quereus/test/logic/03.8-not-precedence.sqllogic
  packages/quereus/test/logic/02-filters.sqllogic
  packages/quereus/src/parser/parser.ts
----
## What landed

- **New** `packages/quereus/test/logic/03.8-not-precedence.sqllogic` —
  a single sqllogic file driving a probe relation
  `create table p (id integer primary key, v any null)` with rows
  `(1, 5), (2, 10), (3, null)`. Sections cover, in order:
  - 8 comparison operators (`=`, `==`, `<>`, `!=`, `<`, `<=`, `>`,
    `>=`) — two assertions per operator (prefix form vs explicit
    parenthesised form; no SQL postfix exists). 16 assertions total.
  - `in (value list)` — three forms (A `not v in`, B `v not in`,
    C `not (v in)`).
  - `in (subquery)` — three forms, using `select 5 union all select 7`
    as the subquery.
  - `between … and …` — three forms.
  - `like 'pat'` — three forms, with `cast(v as text)` so the probe
    relation stays homogeneous.
  - `glob` / `regexp` — comment-only stub. **Verified** in
    `packages/quereus/src/parser/lexer.ts` that no `GLOB` or `REGEXP`
    token exists (only `LIKE`), and `comparison()` in `parser.ts:1262`
    only matches `LIKE` among pattern operators. The stub explains
    where they belong when added.
  - `is null` and `is not null` — three forms each. The IS-NOT-NULL
    block uses the double-negation `v is null` as the postfix
    equivalent of `not v is not null`.
  - `exists` — two forms (no postfix). One row each for the
    true/false branches.
  - Stacked `not not` — two smoke tests (comparison and IN-list).
  - `not` bound by `and` — three assertions using `v < 5` as the
    second conjunct so the discriminator is sharp (correct parse: 0,
    wrong parse: 2).
  - De Morgan — two assertions confirming `not (A or B)` ≡
    `(not A) and (not B)` on the probe relation.

- **Updated** `packages/quereus/test/logic/02-filters.sqllogic` —
  the five-row witness at the end (old lines 52-72) is replaced by
  a one-line pointer comment to `03.8-not-precedence.sqllogic`. The
  rest of the file (predicate-inference tests) is untouched.

- **Not updated** `docs/architecture.md` — the "Testing Strategy"
  section describes `*.sqllogic` files at a high level and does not
  enumerate individual files, so no edit is required. Verified by
  reading § Testing Strategy (starts at line 182).

## Validation evidence

- `yarn workspace @quereus/quereus run test` — 3247 passing,
  0 failing, ~33 s. Log: `/tmp/not-matrix-final.log`.
- `yarn workspace @quereus/quereus run lint` — clean (no output).
- **Negative-control performed.** Locally reverted the parser fix
  (moved `NOT` handling out of `notExpression()` back into `unary()`
  alongside `MINUS/PLUS/TILDE`, mimicking the pre-fix layout). Re-ran
  just `03.8-not-precedence.sqllogic` with `--grep`. The very first
  assertion (`select v from p where not v = 5 order by v` →
  `[{"v":10}]`) failed: with the buggy parse `not v = 5` reduces to
  `(not v) = 5` which evaluates to `false = 5` / `false = 5` /
  `null = 5` across the three rows — all excluded by the WHERE
  filter, yielding `[]`. Restored the parser to baseline; `git diff
  packages/quereus/src/parser/parser.ts` is empty post-restore.
  Sqllogic stops on first failure so only the comparison row was
  observed turning red, but that row is sufficient to prove the
  matrix detects the bug; the IN/BETWEEN/LIKE rows would behave
  analogously under the same revert (the buggy parse of
  `not v in (5,7)` is `(not v) in (5,7)`, which also collapses to
  `[]`).

## Things the reviewer should poke at

- **NULL semantics in every block.** The comments in
  `03.8-not-precedence.sqllogic` claim `not (null op x)` is null
  (excluded from WHERE) and `not (v is null)` for v=null is false.
  Re-derive each block's expected output by hand against a SQL
  three-valued truth table — if any row is off by one, the matrix
  silently locks in wrong behaviour. The IS-NOT-NULL block is the
  trickiest: its expected output is `[{"v":null}]`, which depends on
  the runtime emitting JSON `null` rather than omitting the row.
- **`v < 5` discriminator in the NOT-bound-by-AND block.** The
  ticket originally specified `v < 100` with `count = 2`, which
  doesn't actually discriminate (both parses give 1). I switched to
  `v < 5`, which makes the correct parse 0 and the would-be-wrong
  parse 2. Confirm the discriminator math is right and that asserting
  the wrong-parse count of 2 alongside the correct count of 0 is the
  intended way to prove the bind — alternatives are to omit the
  `not (v = 5 and v < 5)` assertion entirely and let the equivalence
  to `(not v = 5) and v < 5` carry the weight.
- **`cast(v as text)` for the LIKE block.** The probe relation is
  `any null`; LIKE expects strings, so I cast on the way in. The
  `cast(null as text)` returns `null` (confirmed against
  `03.6-type-system.sqllogic:51-52`), so the null-row semantics still
  hold. If the reviewer prefers a separate string-typed probe table
  for LIKE, that's reasonable, but it would mean two probe relations
  in one file — the ticket explicitly says to prefer the cast and
  comment if exceptions are needed.
- **EXISTS row weakness.** The fix doesn't change parsing of
  `not exists (...)` itself — EXISTS is a primary expression, so
  even the buggy `unary()`-level NOT bound it correctly. Including
  EXISTS here is more for completeness / regression-against-future-
  parser-rewrites than for catching the specific bug from #22. The
  reviewer may want to add a stronger EXISTS test that does exercise
  precedence — e.g. `not exists (...) and X`. I left this out
  because the ticket only asked for the matrix in the table.
- **`02-filters.sqllogic` shrinkage.** I replaced the 5-row witness
  with a 2-line pointer comment. If the reviewer prefers to keep
  one or two of those original assertions as a sanity smoke inside
  `02-filters` (the ticket allows either), they can be re-added
  trivially.

## Out of scope (do not pursue here)

- AND/OR/NOT precedence beyond the one assertion in this file —
  covered elsewhere (`test/optimizer/predicate-normalizer.spec.ts`).
- Bitwise `~` precedence — unrelated operator.
- Postfix `IS [NOT] {TRUE|FALSE|UNKNOWN}` — not parsed.
- GLOB / REGEXP — not in the grammar; stub left in place.
