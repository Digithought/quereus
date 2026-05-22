description: Generative test matrix asserting that prefix-`not` placed in front of any predicate (IN / BETWEEN / LIKE / IS [NOT] NULL / `=` / `<>` / `<` / `<=` / `>` / `>=`) is semantically identical to wrapping the same predicate in `not (...)` — locks the contract behind the parser fix in `fix-prefix-not-precedence-against-comparison` so it cannot regress.
prereq: fix-prefix-not-precedence-against-comparison
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/property.spec.ts
  packages/quereus/test/logic/02-filters.sqllogic
  packages/quereus/docs/architecture.md
----
## Motivation

The fix ticket `fix-prefix-not-precedence-against-comparison`
(issue #22) lands a deterministic regression lock for five specific
expressions. That is enough to keep the reporter's case green, but it
leaves the contract — *prefix-NOT and post-fix-NOT are logically
equivalent for every predicate Quereus accepts* — undefended against
new predicate shapes added later.

This ticket lands a generative matrix that exhaustively cross-products
prefix-NOT against every predicate the grammar emits, and asserts both
forms evaluate the same on a small probe relation. The matrix is small
enough to enumerate by hand (no fast-check needed) but mechanical
enough that adding a new predicate kind makes the missing row a
compile-time / test-time signal.

## Goal (acceptance criteria)

A new sqllogic block (or property-test section, see § Where this
lives) asserts, for every predicate `P` listed in § Test surface and
every value `v` in a small probe set:

```
eval("select (not (V) (P) (R)) as v")
  ===
eval("select ((V) not (P) (R)) as v")   -- where a post-fix form exists
  ===
eval("select (not ((V) (P) (R))) as v")
```

The three forms must produce the same `SqlValue` (including NULL).
The probe set must include each of: a value that satisfies `P`, a
value that violates `P`, and `NULL`, so the three-valued-logic
behaviour is exercised.

Where a predicate has no post-fix-NOT form (`=`, `<`, etc.), the test
asserts only the two-way equivalence
`not (V P R) ≡ not (V) (P) (R)` (with appropriate disambiguating
parens on the RHS where the grammar requires it).

## Where this lives

Sqllogic — `packages/quereus/test/logic/03.8-not-precedence.sqllogic`
(new file) is the natural home: deterministic, hand-readable, and
mirrors how `02-filters.sqllogic` and friends are organised. The fix
ticket already lands a small witness here for the five reporter
expressions; this ticket expands it into the full matrix.

A `property.spec.ts` block is *not* needed for this contract — the
matrix is finite and well-known. (The structural property test for
`parse(stringify(parse(s))) ≡ parse(s)` lives in
`plan-ast-stringify-roundtrip-property-test` and is complementary, not
substitutable: that one would catch the *stringifier* losing a `NOT`
parenthesisation but would not catch a parser precedence regression
where both `not P` and `P` parse identically and wrongly.)

## Test surface — predicates to exercise

Each predicate kind below gets one block in the new sqllogic file. The
probe relation:

```sql
create table p (v any null) using memory;
insert into p values (5), (10), (null);
```

(`any null` so NULL is reachable for every predicate.) The expressions
quantify over the row's `v`.

**Comparison operators** — `=`, `==`, `<>`, `!=`, `<`, `<=`, `>`, `>=`.
For each: `not v op K` vs `not (v op K)`, where `K` is a literal that
both succeeds and fails on the probe rows.

**IN (value list)** — `not v in (5, 7)` vs `v not in (5, 7)` vs
`not (v in (5, 7))`.

**IN (subquery)** — `not v in (select 5 union all select 7)` vs
`v not in (...)` vs `not (v in (...))`. The subquery form is the
exact #22 surface.

**BETWEEN** — `not v between 3 and 7` vs `v not between 3 and 7` vs
`not (v between 3 and 7)`.

**LIKE / GLOB / REGEXP** (whichever the parser exposes as a
`comparison()` postfix) — `not v like '5'` vs `v not like '5'` vs
`not (v like '5')`. Repeat for any sibling pattern operator the
grammar accepts.

**IS NULL / IS NOT NULL** — `not v is null` vs `v is not null` vs
`not (v is null)`. Also `not v is not null` vs `v is null` (modulo
double-negation).

**EXISTS** — `not exists (select 1 from p where v = 5)` vs
`not (exists (select 1 from p where v = 5))`. EXISTS has no post-fix
form, so only the two-way equivalence applies.

**Stacked NOT** — `not not v = 5` vs `v = 5`. Double-negation
elimination must hold for every predicate (smoke-check one or two
combinations).

**NOT bound by AND/OR** — `not v = 5 and v < 100` must parse as
`(not v = 5) and (v < 100)`, not `not (v = 5 and v < 100)`. The
former excludes `v=5` and admits `v=10`; the latter excludes both.
Verify by counting rows.

**Parenthesisation edge** — `not (v in (5, 7) or v = 10)` vs
`(not v in (5, 7)) and not v = 10` (De Morgan). The optimizer's
`predicate-normalizer` already covers De Morgan
(`test/optimizer/predicate-normalizer.spec.ts`), but neither test
exercises this shape with prefix-`NOT` on the outside.

## Equivalence and NULL semantics

Three-valued logic must be preserved exactly. The probe set includes
NULL precisely so the test forces both forms through the
`null → null` propagation rule:

- `not (NULL = 5)` is NULL, not false.
- `not NULL in (5, 7)` is NULL, not false.
- `not NULL is null` is `false` (the inner is `true`, the outer
  flips it).

The sqllogic `→` assertion compares JSON-serialised cell values, so
NULL appears as `null` and is unambiguous.

## Out of scope

- **Precedence relative to AND / OR** beyond the one "NOT bound by AND
  ⇒ NOT applies to immediate predicate" row above. The full AND/OR/NOT
  matrix is more naturally a separate concern (and is partly covered
  by `predicate-normalizer.spec.ts`).
- **Bitwise NOT (`~`)** — separate operator, separate precedence,
  unaffected by the fix.
- **Postfix `IS [NOT] {TRUE|FALSE|UNKNOWN}`** — Quereus does not
  currently accept these. If/when added, the same matrix needs one
  more block; not this ticket's job.

## Pointers

- `packages/quereus/src/parser/parser.ts` — the `unary()` / `equality()` /
  `comparison()` / `isNullExpression()` chain. The fix ticket moves
  prefix `NOT` to its own level above `equality()`; this matrix verifies
  the result.
- `packages/quereus/test/logic/02-filters.sqllogic` — current
  WHERE-clause sqllogic style; mimic the section layout.
- `packages/quereus/test/optimizer/predicate-normalizer.spec.ts` —
  unit-level NOT-normalisation tests over the planner. Worth a glance
  to avoid double-testing the same shape at a different layer.
- `docs/architecture.md` § "Testing Strategy" — extend the SQL-logic
  list when the file lands so the strategy doc reflects reality.
- Issue #22 — the reporter's case is the IN-subquery row in the
  matrix.
