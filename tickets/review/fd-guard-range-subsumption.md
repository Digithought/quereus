---
description: Review — `GuardClause` extended with a `range` variant so partial-index / implication-CHECK predicates like `WHERE age >= 18` can be discharged by stronger filters like `WHERE age >= 21`.
prereq:
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
  packages/quereus/src/planner/analysis/predicate-shape.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
---

## Summary

`GuardClause` (in `plan-node.ts`) now has a `range` variant whose shape mirrors
the existing `DomainConstraint.range` shape: `{ column, min?, max?,
minInclusive, maxInclusive }`. The recognizers in
`partial-unique-extraction.ts` and `check-extraction.ts` produce range guards
from `<`/`<=`/`>`/`>=`/`BETWEEN` shapes, and `fd-utils.ts:clauseEntailed` can
discharge a range guard when a filter's intersected range on the same column
(or any EC peer / binding-shared column) is a subset of the guard's range.

`NOT BETWEEN`, NULL literal bounds, and symbolic/parameter bounds remain
unrecognized — they're called out in the file-level doc comments and the
ticket's "out of scope" list.

## Files changed

- **`plan-node.ts`** — added `range` to the `GuardClause` union and expanded
  the surrounding doc comment to describe the four atom kinds plus `or-of`.
- **`predicate-shape.ts`** — added a shared `flipComparison(op)` helper (just
  the operand-swap variant; predicate negation lives in
  `predicate-normalizer.ts:flipComparison` and is distinct).
- **`partial-unique-extraction.ts`** — `recognizeClause` now dispatches to
  new `recognizeRange` (for `<`/`<=`/`>`/`>=` with column-on-either-side) and
  `recognizeBetween` (for `col BETWEEN lit AND lit`, rejecting `NOT BETWEEN`).
  NULL literal bounds drop silently.
- **`check-extraction.ts`** — `recognizeNegatedGuard` extended for the
  implication-form disjuncts `col < lit` / `col <= lit` / `col > lit` /
  `col >= lit` (and their operand-flipped twins), producing the negated range
  guard. Uses the shared `flipComparison` helper; the local copy is removed.
- **`fd-utils.ts`** —
  - `guardClauseEquals`, `projectClause`, `shiftClause` all gain `range` arms
    (column shift / mapping lookup, per-bound presence/value/inclusivity
    equality).
  - `PredicateFacts` gains `rangeBounds: Map<number, FilterRange>`.
  - `buildPredicateFacts` recognizes `BinaryOpNode` with `<`/`<=`/`>`/`>=`
    (operand-flip on `lit op col`) and `BetweenNode` (skipping `not === true`),
    folding bounds into per-column ranges via `tightenLowerBound` /
    `tightenUpperBound`. On equal values the exclusive flag wins (stronger).
    NULL literal bounds are dropped.
  - `clauseEntailed` `range` arm calls `filterRangeSubsetOfGuardRange`
    (per-side subset check using `compareSqlValues(_, _, 'BINARY')`) across
    every `candidateColumn` (column + EC peers + binding-shared).

## Use cases for validation

- Partial UNIQUE `WHERE created_at >= 'D'`: a query with a stronger
  `WHERE created_at >= 'D''` (where `D'' >= D`) exposes the unguarded FD; a
  weaker filter leaves the guard intact.
- Implication-form CHECK `(age < 18 OR x = y)`: query with `WHERE age >= 18`
  activates the body FDs.
- Two-conjunct filter `WHERE age >= 21 AND age <= 30` intersects to a closed
  interval discharging both lower-bound and upper-bound guards.
- EC-peer discharge: `WHERE c1 >= 21 AND c1 = c2` discharges a range guard on
  `c2`.

## Tests added / modified

In `test/optimizer/conditional-fds.spec.ts`:

- 9 new `predicateImpliesGuard` cases covering subset-true, subset-false,
  inclusivity edges, BETWEEN, AND-intersected filter ranges, eq-literal
  non-piggyback, EC-peer discharge.
- 2 new `extractCheckConstraints` cases for `(col < lit OR ...)` and
  `(col >= lit OR ...)` implication-form range guards.
- 6 new `extractPartialUniqueGuardedFds` cases for all four comparison
  operators, operand-flip, BETWEEN, and `NOT BETWEEN` rejection (the old
  `'rejects col > literal (range)'` case is replaced with the positive
  recognition variants).
- 5 new `fd-utils` cases for range-clause shift / project / dedupe /
  side-by-side preservation when bounds or inclusivity differ.
- 2 new end-to-end `Conditional FDs` cases with `CREATE UNIQUE INDEX … WHERE
  created_at >= 'D'` and stronger / weaker filter queries.
- Two pre-existing tests (`'rejects OR with one unrecognized disjunct'` and
  `'rejects the whole predicate if one conjunct is unrecognized'`) used
  `bin('>', age, 18)` as the "unrecognized" half. Since `>` is now
  recognized, both were updated to use `bin('!=', age, 18)` (which remains
  unrecognized in partial-UC scope).

## Validation run

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 3085 passing, 2 pending, 0 failing.
- Targeted `test:single packages/quereus/test/optimizer/conditional-fds.spec.ts` —
  107 passing.

## Known gaps / risks

- **Collation**: subsumption compares text bounds with BINARY collation. This
  matches how the existing `DomainConstraint` range handling works, but text
  partial-UC predicates that depend on collation-aware ordering (e.g.,
  NOCASE) will under-discharge. Filed as an out-of-scope follow-up in the
  doc comment.
- **Symbolic bounds**: only compile-time literals are recognized. Parameter
  bounds (`age >= ?`) drop silently. Out of scope per ticket.
- **Empty-interval contradiction**: a filter range with `min > max` is
  treated as a normal range and may discharge guards whose interval contains
  the (effectively empty) intersection. Acceptable conservatively — the
  predicate-contradiction-detection ticket owns that case.
- **eq-literal vs range cross-discharge**: filter `age = 25` does NOT discharge
  a range guard `age >= 18` via the range path (only the eq-literal path).
  Explicitly tested; out of scope per ticket.
- **NOT BETWEEN / single-side range negation**: out of scope — both decompose
  to a disjunction of two range halves that don't fit a single range clause.

## Note on existing test surface

The two ticket-validation tests above were the only tests in the suite that
relied on `>` being unrecognized in the partial-UC extractor. After the
update there are no other places in the test surface where a `>` against a
literal is expected to be silently dropped — anything that needs an
unrecognized clause now uses `!=`. If a reviewer wants tighter coverage, a
property test asserting "no filter ⊆ guard ⇒ no false discharge" over random
range pairs would catch any subset-rule regression cheaply.
