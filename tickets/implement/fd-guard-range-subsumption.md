---
description: Extend `GuardClause` with a `range` variant so partial-index predicates like `WHERE age >= 18` can be discharged by stronger filters like `WHERE age >= 21`. Today the vocabulary is `eq-literal | eq-column | is-null | or-of`, so any range-shaped partial predicate is unrecognized and drops the whole guarded FD.
prereq:
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
  packages/quereus/src/planner/analysis/predicate-shape.ts
  packages/quereus/src/util/comparison.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
---

## Architecture

### New `range` GuardClause variant

`GuardClause` (in `plan-node.ts`) gains a `range` variant whose shape mirrors
the existing `DomainConstraint` `range` kind so the two layers stay in sync:

```ts
| { readonly kind: 'range';
    readonly column: number;
    readonly min?: SqlValue;
    readonly max?: SqlValue;
    readonly minInclusive: boolean;
    readonly maxInclusive: boolean;
  }
```

At least one of `min` / `max` must be defined; the inclusive flag for an
absent bound is unobservable but stored conservatively as `false` (so equality
never accidentally matches). When `min === max` and both inclusive the clause
is logically equivalent to `eq-literal`; recognizers MAY normalize that case
to `eq-literal` for cache-friendliness, but discharge code must accept both
shapes. The simpler path — leave normalization to the recognizer that produces
`BETWEEN lit AND lit` — is what we'll do.

### Recognizers

**`partial-unique-extraction.ts → recognizeClause`** gains:

| AST conjunct          | guard clause                                      |
| --------------------- | ------------------------------------------------- |
| `col > lit`           | `range { col, min: lit, minInc: false, maxInc: false }` |
| `col >= lit`          | `range { col, min: lit, minInc: true,  maxInc: false }` |
| `col < lit`           | `range { col, max: lit, maxInc: false, minInc: false }` |
| `col <= lit`          | `range { col, max: lit, maxInc: true,  minInc: false }` |
| `lit > col` etc.      | flip operator, same as col-on-left                |
| `col BETWEEN lo AND hi` | `range { col, min: lo, max: hi, minInc: true, maxInc: true }` |

`NOT BETWEEN` stays unrecognized (decomposes to a disjunction of two ranges,
out of scope).

**`check-extraction.ts → recognizeNegatedGuard`** (implication-form, where the
disjunct is the *negation* of the actual guard) gains:

| disjunct AST  | guard clause (negated)                            |
| ------------- | ------------------------------------------------- |
| `col < lit`   | `range { col, min: lit, minInc: true,  maxInc: false }` (i.e. `col >= lit`) |
| `col <= lit`  | `range { col, min: lit, minInc: false, maxInc: false }` (i.e. `col > lit`) |
| `col > lit`   | `range { col, max: lit, maxInc: true,  minInc: false }` (i.e. `col <= lit`) |
| `col >= lit`  | `range { col, max: lit, maxInc: false, minInc: false }` (i.e. `col < lit`) |
| flipped operands | flip operator, same as col-on-left             |

`BETWEEN` and `NOT BETWEEN` in implication-form CHECK disjuncts stay out of
scope — `BETWEEN` negation is a disjunction of two range halves, which doesn't
fit a single range clause.

Both recognizers reuse `columnIndexFromExpr` / `literalValue` from
`predicate-shape.ts`. Add a small shared helper there to flip a comparison
operator (`flipComparison`) so it isn't duplicated in
`check-extraction.ts:399` and the new partial-unique site.

### Discharge: `predicateImpliesGuard`

`fd-utils.ts` changes:

- **`PredicateFacts`**: add `rangeBounds: Map<number, FilterRange>` where
  `FilterRange = { min?, minInclusive, max?, maxInclusive }`. Each per-column
  entry is the *intersection* of every range conjunct on that column observed
  in the filter (take the stronger lower / upper bound; on equal values prefer
  the exclusive flag).

- **`buildPredicateFacts`**: extend the AND-conjunct walker to recognize
  `BinaryOpNode` with operator `<`, `<=`, `>`, `>=` between a `ColumnReferenceNode`
  and a literal (use `literalSqlValueOf` peeling Cast/Collate, same as the
  existing `=` handling). Operand-flipped variants flip the operator. Update
  the column's entry in `rangeBounds`. Also recognize `BetweenNode` (peeling
  is unnecessary at the top-level — its `expr/lower/upper` slots are
  ScalarPlanNodes already): a column-vs-literal-vs-literal BETWEEN folds into
  a closed-interval range entry. NULL-literal bounds drop silently (NULL is
  not a meaningful comparison anchor).

- **`clauseEntailed`**: new `range` arm — entailed iff the filter has a
  recorded range on the same column (or any EC peer / binding-shared column,
  same `candidateColumns` lookup the IN-list path uses) whose interval is a
  subset of the guard's interval.

  Subset rule (`filter ⊆ guard`):

  - lower side: guard has no min ⇒ trivially satisfied. Else filter must have
    a min (else filter is unbounded below, can't be subset). Compare values
    with `compareSqlValues` (BINARY collation — same convention as
    DomainConstraint handling). If `cmp(filter.min, guard.min) > 0` ⇒ ok. If
    `cmp < 0` ⇒ fail. If `cmp == 0` ⇒ ok unless filter is inclusive but guard
    is exclusive (then `min` itself is in filter but excluded from guard ⇒
    fail).
  - upper side: symmetric.

  Cross-type comparisons (text vs number etc.) flow through `compareSqlValues`
  using SQLite's `NULL < Numeric < TEXT < BLOB` ordering — semantically
  defensible because both bounds in this comparison are compile-time literals
  on the same column, so they're typically the same storage class.

- **`guardClauseEquals`**: new `range` arm — structural equality on column,
  bounds, and (only-where-bound-is-defined) inclusivity flags. Mirrors the
  existing `domainConstraintEquals` pattern.

- **`projectClause` / `shiftClause`**: trivial range arms (column +/- offset
  or mapping lookup).

Collation note: BINARY-only comparison is consistent with how
`DomainConstraint` is handled today and how the partial-index AST stores
literals. Per-column collation-aware subsumption is filed as a follow-up
backlog ticket if it becomes a discharge gap in practice — partial UNIQUE
predicates almost always range on numeric / date columns.

### Test plan

Unit tests in `test/optimizer/conditional-fds.spec.ts`:

- **`extractPartialUniqueGuardedFds`**:
  - `col >= lit` produces a single range clause with `min=lit, minInc=true, maxInc=false`.
  - `col > lit`, `col <`, `col <=` all produce range clauses with the right inclusivity.
  - `lit < col` (operand-flipped) produces the same clause as `col > lit`.
  - `col BETWEEN lo AND hi` produces a closed interval range clause.
  - The existing `'rejects col > literal (range)'` test goes away (replaced
    by the positive case above) — it asserts the *old* behavior we're fixing.

- **`extractCheckConstraints` (implication-form)**:
  - `(age < 18 OR x = y)` ⇒ guarded FD with range guard `{age, min:18, minInc:true, maxInc:false}`.
  - `(age >= 18 OR x = y)` ⇒ range guard `{age, max:18, maxInc:false, minInc:false}` (i.e. `age < 18`).

- **`predicateImpliesGuard`**:
  - filter `age >= 21` discharges guard `range {age, min:18, minInc:true}`.
  - filter `age >= 18` discharges guard `range {age, min:18, minInc:true}` (same bound).
  - filter `age > 18` discharges guard `range {age, min:18, minInc:true}` (stricter inclusivity).
  - filter `age >= 18` does NOT discharge guard `range {age, min:18, minInc:false}` (filter inclusive but guard exclusive).
  - filter `age >= 17` does NOT discharge guard `range {age, min:18, minInc:true}`.
  - filter `age BETWEEN 21 AND 30` discharges guard `range {age, min:18, minInc:true}` and `range {age, max:50, maxInc:true}`.
  - filter `age >= 21 AND age <= 30` (two AND conjuncts) intersects to a closed interval and discharges guard `range {age, min:18, max:50, …}`.
  - filter `age = 25` (eq-literal) does NOT auto-discharge a range guard
    via the range path — eq-literal is its own clause kind. (Could be added
    later as an optimization, but out of scope here.)
  - EC-peer discharge: filter `c1 >= 21 AND c1 = c2` discharges range guard on `c2`.

- **`fd-utils` helpers**:
  - `shiftFds` shifts the column on a range clause.
  - `projectFds` drops a range-guarded FD when the column is missing from the mapping.
  - `addFd` dedupes structurally equal range guards.

End-to-end via `query_plan(...)`:

- Partial UNIQUE `WHERE created_at >= '2025-01-01'` on table `t`, query
  `SELECT * FROM t WHERE created_at >= '2025-06-01'` ⇒ filter exposes
  unguarded FD `c → others`.
- Same setup, query `WHERE created_at >= '2024-01-01'` ⇒ NOT discharged.
- Implication-form CHECK `(age < 18 OR x = y)`, query `WHERE age >= 18` ⇒
  filter exposes activated guarded FDs.

### Out of scope (carry forward in same backlog if needed)

- Per-column collation-aware text bound comparison.
- Symbolic / parameter range bounds (`age >= ?`) — bounds are literals only.
- Range guard on the same column intersecting with an `eq-literal` clause
  (the eq case already reaches via `eq-literal` clause vocabulary; the range
  path doesn't piggyback).
- Empty-interval contradiction detection (covered by the
  predicate-contradiction-detection ticket).

## TODO

Plan-node typing:

- Extend `GuardClause` union in `plan-node.ts:74` with the `range` variant; expand the doc comment block above it to mention the new kind alongside `eq-literal | eq-column | is-null | or-of`.

`fd-utils.ts`:

- Add `range` arm to `guardClauseEquals` (`fd-utils.ts:150`) — reuse the same per-bound presence/value/inclusivity comparison `domainConstraintEquals` already implements (consider extracting a small shared `rangesEqual` helper).
- Add `range` arm to `projectClause` (`fd-utils.ts:358`) and `shiftClause` (`fd-utils.ts:415`).
- Extend `PredicateFacts` (`fd-utils.ts:756`) with `rangeBounds: Map<number, FilterRange>`. Define `FilterRange` locally (same shape as the new GuardClause range variant minus `column`).
- Extend `buildPredicateFacts` (`fd-utils.ts:773`):
  - Recognize `BinaryOpNode` with operator in `<`, `<=`, `>`, `>=`. Use `columnIndexOf` and `literalSqlValueOf` for the operand pair; flip the operator for `lit op col`. Update the column entry by intersecting with any prior range fact (`tightenLowerBound`, `tightenUpperBound` helpers).
  - Recognize `BetweenNode` (`scalar.ts:817`): when `expr` is a column ref and `lower` / `upper` are both literals (peel Cast/Collate via `literalSqlValueOf`), update the column entry with the closed interval. Skip when `expression.not === true`.
- Add `clauseEntailed` `range` arm (`fd-utils.ts:950`):
  - Walk `candidateColumns(column, ecs, bindings)` (already exists at `fd-utils.ts:1073`), look up `facts.rangeBounds`, and check `filterRangeSubsetOfGuardRange`.
  - `filterRangeSubsetOfGuardRange(filter, guard)`: per-side check using `compareSqlValues(_, _, 'BINARY')`. Lower-side: guard has no min ⇒ ok; else filter min must exist and either be strictly greater, or equal-with-acceptable-inclusivity (filter exclusive OR guard inclusive). Upper-side: symmetric.

`partial-unique-extraction.ts`:

- In `recognizeClause` (`partial-unique-extraction.ts:174`), before the `=`/`==` branch, add cases for `<`, `<=`, `>`, `>=` operators with a column on either side. Build the range guard with the inclusivity per the table above. NULL literal ⇒ undefined (reject).
- Add a `BetweenExpr` arm: column expr + literal lower + literal upper ⇒ closed-interval range. Skip when `not === true`.
- Update the doc comment block at the top (lines 1–50) to add range / BETWEEN to the recognized-shapes table and remove range from the "out of scope" list.

`check-extraction.ts`:

- In `recognizeNegatedGuard` (`check-extraction.ts:300`), add `<`, `<=`, `>`, `>=` recognition: the disjunct's operator is *negated* into a range guard per the table above. Reuse the operator flip logic shared in `predicate-shape.ts`.
- Update the doc comment block (lines 290–298) to list the new patterns.

`predicate-shape.ts`:

- Add a small exported `flipComparison(op: string): string` helper (move it from the local function in `check-extraction.ts:399`) so both extractors can share it.

Tests (`test/optimizer/conditional-fds.spec.ts`):

- Replace the `'rejects col > literal (range)'` test (~line 791) with positive-case range recognition tests for all four comparison operators and BETWEEN.
- Add `predicateImpliesGuard` cases per the test plan above (8–10 cases covering subset-true, subset-false, inclusivity edge cases, EC-peer discharge, AND-intersected filter ranges).
- Add `extractCheckConstraints` implication-form tests for `(age < 18 OR …)` and `(age >= 18 OR …)`.
- Add `fd-utils` shift / project / dedupe tests for range-clause FDs (parallel to the existing `or-of` / `eq-literal` tests).
- Add an end-to-end test under `Conditional FDs: end-to-end propagation` using a partial UNIQUE `WHERE created_at >= 'D'` and verify a stronger filter exposes the unguarded FD.

Validation:

- `yarn workspace @quereus/quereus run check` (TypeScript).
- `yarn workspace @quereus/quereus test --grep "Conditional FDs|predicateImpliesGuard|extractPartialUniqueGuardedFds|extractCheckConstraints|fd-utils"` to run the focused suite, then full `yarn test` for regressions.
