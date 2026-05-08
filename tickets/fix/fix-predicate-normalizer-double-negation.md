description: Predicate normalizer mis-evaluates `NOT NOT (a > 10)` — returns all rows instead of rows where `a > 10`. Pre-existing failure surfaced during review of `2-fix-composite-asc-desc-index-ordering`.
files:
  packages/quereus/test/optimizer/predicate-normalizer.spec.ts (failing case at line 53)
  packages/quereus/src/planner/ (predicate normalizer / NOT push-down logic — exact path TBD)
----

## Reproduction

```sql
CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER NULL, b INTEGER NULL, c TEXT NULL) USING memory;
INSERT INTO t VALUES (1, 10, 20, 'x'), (2, 20, 10, 'y'), (3, 30, 30, 'z'), (4, 40, NULL, NULL), (5, NULL, 50, 'w');

-- Expected: [2, 3, 4]   (rows where a > 10, NULLs excluded by 3VL)
-- Actual:   [1, 2, 3, 4, 5]
SELECT id FROM t WHERE NOT NOT (a > 10) ORDER BY id;
```

The single-NOT case (`NOT (a > 10)` correctly returning row 1) works, and so does NOT-pushdown across operators (De Morgan AND/OR cases pass). Only the `NOT NOT` collapse appears to drop the inner predicate entirely, leaving an effectively unconditional WHERE.

## Notes

- Adjacent normalizer cases all pass (De Morgan, NOT pushdown on `>`/`>=`/`=`, etc.) — so the surrounding rewrite framework is healthy; the bug is specifically in double-NOT collapse.
- Failure pre-dates `2-fix-composite-asc-desc-index-ordering`; reproduces on the implement commit (`b38a4bf2`) and earlier. Do NOT bisect blame to recent ordering work.
- Three-valued logic must be preserved when collapsing `NOT NOT P`: row 5 (`a IS NULL`) should remain excluded.

## TODO

- Locate the NOT-collapse / `simplifyNot` (or equivalent) in the predicate normalizer.
- Add a unit test directly against the normalizer (AST in → AST out) demonstrating that `NOT (NOT (a > 10))` collapses to `a > 10` and not to `TRUE` or empty.
- Fix the collapse and confirm `Predicate normalizer > double negation` test passes.
- Re-run `yarn workspace @quereus/quereus test` — should reach 994 passing, 0 failing.
