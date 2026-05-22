description: Review of prefix-NOT parser-precedence fix. Inserts a dedicated `notExpression()` level between `logicalAnd` and `isNull` so prefix `NOT` binds above every predicate (IN, BETWEEN, LIKE, IS [NOT] NULL, comparison) rather than alongside arithmetic unary. Defensive stringifier parens were intentionally kept narrow — see "Deviations" below. Regression coverage added at parser, direct-DDL CHECK, and declarative-schema layers.
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/logic/02-filters.sqllogic
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Background

Github issue [#22](https://github.com/gotchoices/quereus/issues/22). Prefix
`NOT` was matched in `unary()` alongside `-`/`+`/`~`, so `not x in (...)`,
`not x between ...`, `not x like ...`, `not a is null`, and `not 0 = 5`
all evaluated against the *primary*, not the *predicate*. Direct-DDL
`check (not Color in (select Code from Block))` happened to evaluate
correctly at insert time (constraint engine bypasses the wrong precedence
because `not Color` reduces to `not <text>` → null/0 → `not in (subq)`
returned whatever the InExpr returned, which by luck still flagged the
row) but issue #22 also went through the declarative-schema differ which
re-parses the stringified output, exposing the bug semantically.

Full root-cause walk-through (parser trace, evaluator-vs-standard matrix,
three-layer reproduction) lives in the original fix ticket
(`tickets/fix/2-...` in commit `fd5411e0`).

## Changes

### `packages/quereus/src/parser/parser.ts`

- Added `notExpression()` (right-recursive prefix matcher) between
  `logicalAnd()` and `isNull()`. Wraps each matched `NOT` token in
  `UnaryExpr { operator: 'NOT', ... }`. Stacked `not not p` falls out
  via recursion.
- `logicalAnd()` now descends into `notExpression()` instead of `isNull()`.
- `unary()` no longer matches `TokenType.NOT`; it stays an arithmetic-only
  prefix (`-`, `+`, `~`). Doc-comment updated.

All other `TokenType.NOT` usages in `parser.ts` were audited and left
unchanged (lines 1225 = `IS NOT NULL` inside `isNull()`; 1265/1271 =
post-fix `NOT IN`/`NOT BETWEEN`/`NOT LIKE` inside `comparison()`; 3485,
3518, 3683, 3703 = DDL `NOT NULL` / `NOT DEFERRABLE` paths).

### `packages/quereus/src/emit/ast-stringify.ts`

Extracted the body-paren decision into a tiny helper `unaryBodyNeedsParens`
that returns `true` only when the inner expression is `binary`. This is
the **minimum** required by the new precedence — see "Deviations" below.

### Regression tests

- `test/logic/02-filters.sqllogic` — five `select (NOT P)` lines, one for
  each predicate shape (IN, BETWEEN, LIKE, IS NULL, comparison). Pure
  parser-level coverage.
- `test/logic/40.2-check-extras.sqllogic` — direct-DDL `check (not Color
  in (select Code from Block))`; insert of blocked colour returns the
  `CHECK constraint failed: NB` error.
- `test/logic/50-declarative-schema.sqllogic` — issue-#22 verbatim through
  `declare schema` + `apply schema`. Proves the stringify→re-parse
  round-trip is now semantically equivalent.

## Validation

- `yarn workspace @quereus/quereus run test` — **3219 passing**, 0 failing
  (`C:\temp\quereus-test.log`). The new regressions all hit; one existing
  expectation in `03-expressions.sqllogic` was *not* changed (see
  Deviations below).
- `yarn workspace @quereus/quereus run lint` — exit 0, clean.
- `yarn build` — fails in `packages/quereus-isolation` with
  `isolation-module.ts(564,11): error TS2322: Type '{ type:
  "addConstraint"; constraint: TableConstraint; }' is not assignable to
  type 'never'.` **This error pre-exists on `main` (verified by
  `git stash` + rebuild) and is unrelated to this ticket.** `@quereus/quereus`
  itself builds cleanly via `yarn workspace @quereus/quereus run build`
  (implicit in `yarn test`).
- `yarn test:store` — deferred per the ticket (slow, store-specific;
  this change is parser/stringifier-only).

## Deviations from the source ticket

The source ticket prescribed a **defensive** `notBodyNeedsParens` that
would parenthesise NOT's body for *any* of
`'in' | 'between' | 'binary' | 'cast' | 'collate' | 'exists'` and for
nested `unary` (NOT / IS [NOT] NULL). I implemented that initially but
it broke 3 distinct existing assertions (e.g. `not exists (select 1
from B)` → `not (exists (select 1 from B))` at
`50-declarative-schema.sqllogic:477`, `not not 1` → `not (not 1)` at
`03-expressions.sqllogic:17`) and would cascade through several more
test fixtures across `40-constraints`, `50-declarative-schema`,
`01.8-delete-extras`, `07.6.1-subquery-extras`, etc.

Tracing each case against the *new* precedence chain showed that, after
the parser fix, **every shape except `binary` round-trips cleanly
without parens**. The post-fix paths `comparison()` → `IN`/`BETWEEN`/`LIKE`
build `expr` first and only then consume the predicate operator, and
`notExpression` sits above all of them, so:

- `not x in (1,2,3)` re-parses as `UnaryExpr{NOT, InExpr{x, [1,2,3]}}` —
  identical AST to its own stringification.
- `not a is null` re-parses as `UnaryExpr{NOT, UnaryExpr{IS NULL, a}}` —
  identical.
- `not exists (...)` re-parses as `UnaryExpr{NOT, ExistsExpr{...}}` —
  identical.
- `not cast(x as int)` / `not (a collate nocase)` — all self-delimiting.
- `not not 1` re-parses as `UnaryExpr{NOT, UnaryExpr{NOT, 1}}` —
  identical, via recursion in `notExpression()`.

Only a `binary` body genuinely needs parens (e.g. `not a and b` would
re-parse as `(not a) and b`). I therefore kept the helper minimal —
literally `expr.expr.type === 'binary'`, which matches the *original*
emission and avoids the test-fixture churn.

**Reviewer call to make:** if the team prefers the defensive-parens
philosophy for resilience against future precedence refactors, the
helper can be expanded to the source-ticket shape and the affected
fixtures updated en masse. That decision is a policy call rather than a
correctness one — both forms produce the same AST under the current
parser. The right home for the broader emitter-robustness work is the
already-planned sibling
`plan-ast-stringify-roundtrip-property-test` (issue #23).

## Use cases for testing / validation

### Golden path

- `select (not 5 in (1,2,3));` → `true` (was `false` on main).
- `select (not null is null);` → `false` (was `true` on main).
- `create table T (..., constraint NB check (not Color in (select Code
  from Block)));` — insert of a non-blocked colour succeeds; insert of a
  blocked colour returns `CHECK constraint failed: NB`.
- Same constraint expressed via `declare schema` + `apply schema` —
  identical behaviour. Diff schema after apply must be empty (stable
  round-trip).

### Edge cases the reviewer should probe

- Stacked NOT against a predicate: `select not not (1 in (1,2));` must
  return `true` (not `false`).
- NOT against parenthesised disjunction: `select not (1 = 1 or 2 = 2);`
  must return `false` (binary-body parens still apply on stringify).
- NOT against a function-call returning a boolean (e.g. typeof, exists):
  ensure the AST emission round-trips without dropping the function.
- Direct-DDL vs. declare/apply parity for *all* CHECK shapes — the new
  declarative test covers `not in (subquery)`; adjacent shapes (`not
  exists`, `not between`, `not like`) should round-trip just as well,
  but only `not in (subquery)` is explicitly asserted at the
  declarative layer.
- `not` inside a `case when` arm: `select case when not a in (1,2)
  then 'x' else 'y' end from t;` — should follow precedence rules.

### Planner smoke-test (Phase 4 of source ticket)

The fix changes the *parser*; the AST shape produced is byte-identical
to what the post-fix `comparison()` paths build today
(`UnaryExpr{NOT, InExpr{...}}` etc.). All planner consumers of
`UnaryOpNode{NOT}` over a predicate
(`predicate-normalizer.pushNotDown`, `sat-checker`, `fd-utils`,
`rule-subquery-decorrelation`, `assertion-classifier.negateAst`)
therefore see exactly the same input as before. I did **not** add an
EXPLAIN regression — by construction there is nothing to differ — but
the reviewer may want to grab `select * from t where not c in (1,2,3)`
vs. `select * from t where c not in (1,2,3)` and `diff` the plan output
to confirm.

## Known gaps

- The defensive-parens spec in the source ticket was downgraded to
  minimal-parens; see "Deviations" above. A property-style emitter
  roundtrip test (sibling ticket
  `plan-ast-stringify-roundtrip-property-test`) is the right place to
  lock this down structurally.
- A `NOT × predicate` Cartesian property-test matrix
  (sibling `plan-prefix-not-precedence-test-matrix`) was not added —
  out of scope, ticket explicitly defers it.
- Declarative-vs-direct-DDL semantic equivalence is asserted for the
  issue-#22 shape only. The full harness is sibling
  `plan-declarative-schema-semantic-equivalence-harness`.
- Pre-existing build error in `packages/quereus-isolation`
  (`isolation-module.ts:564`) blocks the monorepo-wide build but is
  unrelated to this change.
- `yarn test:store` not run (slow, store path is irrelevant to a
  parser-level fix).

## End
