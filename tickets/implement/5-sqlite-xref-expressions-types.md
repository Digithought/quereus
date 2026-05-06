description: Cross-check SQLite expression, type, conversion, and collation tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/, docs/types.md
----

## Scope

For each `unreviewed` row in the **"Expressions, types, conversion"** section of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

In-scope:
- `expr.test`, `expr2.test`, `e_expr.test`
- `cast.test`
- `types.test`, `types2.test`, `types3.test`
- `numcast.test`, `tostr.test`
- `boundary*.test` (numeric/string boundary regressions)
- `bigint.test`
- `collate1.test` – `collate9.test`

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first. Also read `docs/types.md` for Quereus's logical/physical type model.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- This is the **highest-`n/a`-rate category**. SQLite's type affinity model and implicit coercions don't apply to Quereus. Be liberal with `n/a` and concise with reasons.
  - Implicit coercion of TEXT '123' to INTEGER 123 in arithmetic: `n/a` (Quereus rejects or requires explicit `integer()`).
  - "Type affinity rules from CREATE TABLE column type": `n/a`.
  - `typeof()` returning SQLite-specific bucket names ('integer', 'real', 'text', 'blob', 'null'): partial — Quereus has `typeof` but the buckets may differ. Pin down.
- `e_expr.test` is "encyclopedia of expressions" — high-value, expect many partials/gaps.
- CAST vs Quereus's `integer()`/`date()`/`json()` conversion functions — fixtures should exercise both syntaxes where Quereus accepts CAST.
- BLOB literals (`X'...'`) and bytewise comparison.
- BigInt range edges (Number.MAX_SAFE_INTEGER, 2^63-1, etc.) — `03.7-bigint-mixed-arithmetic.sqllogic` covers some.
- Collation: `collate1-9.test` exercises BINARY, NOCASE, RTRIM. Quereus's collation surface may be narrower — verify per file.
- IS / IS NOT vs `=`/`<>` with NULL operands.
- Scalar subquery as expression — fixture only if not covered in subquery section.

## TODO

- [ ] Read process doc, types doc, assigned section of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<short type-system reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard, plus an explicit list of n/a reasons categorized (affinity, rowid, etc.) — this category will produce the longest n/a list and a clean summary helps the human.
