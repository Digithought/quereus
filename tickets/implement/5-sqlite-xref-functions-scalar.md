description: Cross-check SQLite scalar/string/math function tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` **scalar-function** row of the "Functions" section in `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`. Date and JSON functions are owned by `5-sqlite-xref-functions-temporal-json.md` — leave those alone.

In-scope:
- `func.test`, `func2.test`, `func3.test`, `func4.test`, `func5.test`, `func6.test`, `func7.test`
- `substr.test`
- `printf.test`, `printf2.test`
- `random.test`
- `like.test`, `like2.test`, `like3.test`

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- Existing coverage: `06-builtin_functions.sqllogic`, `06.1-string-functions.sqllogic`, `06.2-math-functions.sqllogic`, `24-builtin-branches.sqllogic`. Calibrate.
- SQLite-specific functions (`zeroblob`, `quote`, `randomblob`, `last_insert_rowid`, `changes`, `total_changes`) — many are `n/a` (rowid, persistence concepts).
- `printf()`/`format()`: verify Quereus exposes either. If absent, write a fixture that uses it — the next pass decides whether to add the function or reclassify.
- `random()` / `randomblob()`: Quereus's determinism rules differ — `random()` outside `WITH CONTEXT` is rejected. Most of `random.test` is `n/a` for direct translation; pin down the determinism-validation behavior with a fixture if not already covered (`44-determinism-validation.sqllogic` may suffice).
- LIKE / GLOB pattern semantics: case-folding, `ESCAPE` clause, NULL pattern, NULL operand.
- String length functions: byte-length vs char-length distinctions.
- Math: `abs`, `round`, `floor`, `ceil`, `power`, `sqrt`, `mod`, `log`, etc. SQLite added many in 3.35; verify Quereus parity.
- `coalesce`, `ifnull`, `nullif` — usually well-covered; sanity-check with one fixture if gap suspected.

## TODO

- [ ] Read process doc and assigned subset of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard.
