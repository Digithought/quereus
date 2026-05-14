---
description: Sargable range rewrites for monotone bucket/conversion functions (datetime/date in particular). The key-preserving half of this ticket landed via 2-fd-from-injective-projections (see `planner/util/key-utils.ts:deriveProjectionColumnMap` and the Project/ReturningNode wiring).
prereq: expression-properties-injective-monotone.md

---

## Architecture

This task consumes the planned expression property framework to unlock sargable range rewrites for monotone bucket/conversion functions (datetime/date most notably).

> **Key-preserving projections (injective)** — landed in `tickets/complete/2-fd-from-injective-projections.md`. `ProjectNode` and `ReturningNode` now propagate keys/FDs/ECs through any projection whose expression is injective in a single source attribute (with all other leaves being literals or parameters). The helper is `deriveProjectionColumnMap` in `planner/util/key-utils.ts`; built-in injective forms cover unary `±x`, `x ± const`, `const ± x`, and same-logical-type `CAST`. Additional built-ins / SQL functions opt in by setting `injectiveOnArgs` on their `FunctionSchema`. The "sargable" half remains below.

### Sargable range rewrites (monotone + range provider)

Problem:
- Predicates like `where date(ts) = :d` or `where convert(date, ts) = @d` are *semantically fine* but tend to be non-sargable unless rewritten to a range on `ts`.

Desired behavior:
- Recognize patterns of the form `f(col) op constant` where:
  - `col` is a column reference
  - `f` is monotone in `col` and/or provides a safe **equalityToRange** (bucketing) transformation
- Rewrite to an equivalent predicate on `col` that the access-path selection can push into Retrieve / index seeks.

Rewrite patterns (initial):
- `f(col) = c` → `col >= lower(c) and col < upper(c)` when `equalityToRange` is available
- Potential follow-ups:
  - `f(col) >= c` and `f(col) < c` (needs monotonicity and careful boundary mapping)

Likely targets:
- datetime bucketing:
  - `date(ts)` (start-of-day / next-day)
  - `datetime(ts)` normalization (if implemented as a canonicalizer; careful with time zones)

Implementation sketch:
- Add an optimizer rule (new or in existing predicate normalization) that:
  - detects `BinaryOpNode` comparisons where LHS is a function/cast node
  - queries the range rewrite provider for that expression
  - replaces with a conjunction of range predicates on the base column
- Ensure the rewrite happens **before** access-path selection / Retrieve growth.
- Ensure null semantics match SQL:
  - rewrite must preserve behavior for `null` constants and `null` column values
  - `date(null) = c` is null → false; range rewrite should also not match nulls

Test strategy:
- Add an optimizer test that checks the plan shape:
  - query contains a range predicate on base column after rewrite (via `query_plan()` inspection)
  - and/or index seek is chosen when applicable

### Interaction with parameter typing / implicit conversions

Range rewrites are sensitive to type coercion. Prefer rewriting so that:
- constants/parameters are coerced to the **column’s logical type** (or a compatible physical type)
- avoid introducing “column side conversions” that would defeat sargability.

This may require:
- ensuring parameter typing is known early enough, or
- inserting an explicit cast on the constant side.

## TODO

### Phase 1: Planning
- [ ] Define the minimal datetime bucketing functions worth supporting (`date()` first).
- [ ] Decide where in the optimizer pipeline predicate rewrites should run (before Retrieve growth).

### Phase 2: Implementation
- [ ] Implement a predicate rewrite rule for `equalityToRange` providers.
- [ ] Ensure the rewrite preserves NULL semantics and type compatibility (constant-side casts).

### Phase 3: Tests
- [ ] Add sargable range rewrite regression tests (predicate rewritten, access-path improves when indexes exist).

