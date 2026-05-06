description: Cross-check SQLite date/time and JSON function tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/, docs/datetime.md
----

## Scope

For each `unreviewed` **date/time or JSON** row of the "Functions" section in `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

In-scope:
- `date.test`, `date2.test`, `date3.test`, `date4.test`
- `json1.test` – `json5.test`
- `json101.test` – `json104.test`

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first. Also read `docs/datetime.md` for Quereus's temporal type model.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- **Temporal model differs**: Quereus has native DATE/TIME/DATETIME types (see `docs/datetime.md`); SQLite stores as TEXT/REAL/INTEGER. Many SQLite tests assert string forms — calibrate against Quereus's logical type. Use `n/a` when the SQLite test is asserting SQLite's storage representation rather than the logical operation.
- Existing coverage: `16-epoch.sqllogic`, `17-weekday-modifier.sqllogic`, `15-timespan.sqllogic`, `98-temporal-edge-cases.sqllogic`.
- Date/time modifiers SQLite supports: `'+N days'`, `'start of month'`, `'unixepoch'`, `'localtime'`, `'utc'`, `'weekday N'`, etc. Verify each — likely partial.
- `strftime` format codes — check parity.
- `'now'` / `'now', 'localtime'` — non-deterministic; in Quereus must be passed via mutation context. Fixtures should respect Quereus determinism rules. Tests of `datetime('now')` outside `WITH CONTEXT` should pin down the rejection.
- JSON functions: existing coverage at `06.7-json-extended.sqllogic`, `06.8-json-path-operators.sqllogic`, `97-json-function-edge-cases.sqllogic`. SQLite's `json1-5` and `json101-104` are extensive — cycles, deeply nested, malformed input, type preservation, JSON5 extensions.
- JSON path operators `->`, `->>` — verify operator parity.
- `json_each`, `json_tree` (TVFs) — verify support.
- `json_valid`, `json_quote`, `json_type`, `json_array_length`, `json_extract`, `json_set`, `json_replace`, `json_insert`, `json_remove`, `json_patch`, `json_object`, `json_array`, `json_group_object`, `json_group_array` — full surface check.

## TODO

- [ ] Read process doc, datetime doc, assigned subset of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard.
