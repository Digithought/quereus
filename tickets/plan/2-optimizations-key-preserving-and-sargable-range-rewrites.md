---
description: Use injective/monotone expression properties to preserve uniqueness and enable sargable range rewrites
dependencies: 2-expression-properties-injective-monotone.md

---

## Architecture

This task consumes the planned expression property framework to unlock two optimizer behaviors that depend on “value-transform-but-preserve-structure” semantics:

1. **Key/uniqueness preservation through projection**
2. **Sargable range rewrites for monotone bucket/conversion functions** (datetime/date most notably)

### 1) Key-preserving projections (injective)

Current behavior:
- `ProjectNode` preserves logical keys only when a projected column is a direct `ColumnReferenceNode`.
- `physical.uniqueKeys` similarly only projects via column mappings.

Desired behavior:
- If a source key column `k` is projected as `f(k)` and `f` is **injective** over the relevant domain, the output column can replace `k` in keys/uniqueKeys.

Minimal initial scope:
- Numeric injective transforms:
  - `k + c` / `k - c` where `c` is a constant
  - unary `-k` (injective)
- Avoid unsafe transforms:
  - lossy casts, truncation, `date(ts)` (not injective)

Implementation sketch:
- Add an “expression→source-column” mapping that can produce a **derived key column** when:
  - expression is injective in exactly one source attribute id
  - other referenced attributes are absent (or constants only)
- Extend `ProjectNode` key projection logic to allow these mappings in addition to direct column refs.
- Extend physical unique key projection similarly (where physical properties are computed).

Test strategy:
- Add optimizer tests to assert that `uniqueKeys` are preserved through:
  - `select id + 1 as id2 from t` where `id` is PK
  - `select -id as nid from t`

### 2) Sargable range rewrites (monotone + range provider)

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
- [ ] Define the minimal injective transform set worth supporting initially.
- [ ] Define the minimal datetime bucketing functions worth supporting (`date()` first).
- [ ] Decide where in the optimizer pipeline predicate rewrites should run (before Retrieve growth).

### Phase 2: Implementation
- [ ] Extend key propagation to accept injective-derived columns in `ProjectNode` logical keys.
- [ ] Extend physical `uniqueKeys` projection similarly.
- [ ] Implement a predicate rewrite rule for `equalityToRange` providers.
- [ ] Ensure the rewrite preserves NULL semantics and type compatibility (constant-side casts).

### Phase 3: Tests
- [ ] Add key-preserving projection regression tests (PK preserved through `+ const`, unary `-`).
- [ ] Add sargable range rewrite regression tests (predicate rewritten, access-path improves when indexes exist).

