description: Edge-case sqllogic tests for NULL semantics, boundary values, and mixed-type expressions
dependencies: none
files:
  - packages/quereus/test/logic/21-null-edge-cases.sqllogic
  - packages/quereus/test/logic/22-boundary-values.sqllogic
----

## Summary

Created two new sqllogic test files covering value-level edge cases. All tests pass.

### 21-null-edge-cases.sqllogic

Systematically tests NULL behavior in every SQL position, building on existing NULL basics in `03-expressions.sqllogic`:

- **NULL in join keys** — INNER/LEFT JOIN with NULL keys verifying NULLs don't match (NULL ≠ NULL)
- **NULL in GROUP BY** — NULLs grouped together into one group
- **NULL in ORDER BY** — default (NULLs first), explicit NULLS FIRST/LAST, DESC with NULLS FIRST
- **NULL in CASE WHEN** — NULL condition (falsy), simple CASE NULL=NULL (no match), NULL result branches
- **NULL in IN/NOT IN** — NULL in list doesn't match; NOT IN with NULL returns empty (three-valued logic); NULL operand
- **NULL in aggregates** — count(col) vs count(*), sum/avg/min/max skip NULLs, group_concat skips NULLs
- **NULL in window functions** — PARTITION BY groups NULLs; RANK gives NULLs same rank
- **NULL in COALESCE chains** — single null, all nulls, per-row cascade with mixed types
- **NULL with all comparison operators** — =, <>, <, >, <=, >= all return null; IS NULL/IS NOT NULL return boolean
- **NULL in DISTINCT** — NULLs treated as equal, deduplicated to one
- **NULL in subqueries** — EXISTS (select null) → true; scalar subquery returning null; IN with null subquery result

### 22-boundary-values.sqllogic

Tests boundary values for each type and mixed-type expressions:

- **INTEGER boundaries** — 0, ±1, ±MAX_SAFE_INTEGER; arithmetic and comparison at boundaries
- **REAL boundaries** — 0.0, very small (1e-15), very large (1e15); `0.1 + 0.2` floating-point behavior; IEEE 754 0.0 == -0.0
- **TEXT boundaries** — empty string (not null, length 0); embedded quotes; unicode character length
- **BLOB boundaries** — empty blob type/length; single byte; equality
- **Mixed-type arithmetic** — integer+real→real; integer/integer→real (no truncation); string coercion (`1 + '2'` → 3)
- **Cross-type comparisons** — `1 = 1.0` → true; typeof for integer, real (note: 1.0 is integer-typed in this engine), text
- **CASE with mixed-type branches** — typeof follows actual branch taken
- **UNION with different column types** — per-row type preservation

## Testing notes

- All tests pass: `yarn test` — 0 failures
- Engine-specific behaviors observed:
  - `typeof(1.0)` returns `"integer"` (integer-valued reals stored as integer)
  - `10 / 3` returns `3.3333333333333335` (real division, not integer truncation)
  - Default NULL ordering: NULLs first for both ASC and DESC
  - `DESC NULLS FIRST` treats NULLs as lowest value (NULLs appear at end in DESC)
