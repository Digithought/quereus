description: Cross-check SQLite transaction, savepoint, parameter-binding, and error-path tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` row in the **"Transactions, savepoints"**, **"Bound parameters, identifiers"**, and **"Error paths"** sections of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

In-scope:
- `trans.test`, `trans2.test`, `trans3.test`, `transaction.test`
- `savepoint.test`, `savepoint2.test` – `savepoint7.test`
- `bind.test`
- Any errors-related row (`errors.test` if present)

The `descidx*.test` row is owned by `5-sqlite-xref-indexes.md`. The `identifier.test` and quoted-identifier rows are small — handle them here as part of bind/identifiers.

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- Existing coverage: `04-transactions.sqllogic`, `101-transaction-edge-cases.sqllogic`, `13.2-cte-bind-params.sqllogic`, `90.1-parse-errors.sqllogic`, `90.3-expression-errors.sqllogic`, `90.4-dml-errors.sqllogic`, `90-error_paths.sqllogic`, `03.1-quoted-identifiers.sqllogic`, `06.4.1-schema-case-insensitive.sqllogic`.
- BEGIN/COMMIT/ROLLBACK with implicit/explicit transactions, BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE — IMMEDIATE/EXCLUSIVE are SQLite locking modes; likely `n/a`.
- SAVEPOINT lifecycle: nested savepoints, RELEASE, ROLLBACK TO, savepoint after commit.
- Parameter binding: `?`, `?N`, `:name`, `@name`, `$name`. Parameter type inference at plan time (Quereus pins types pre-execution per `docs/architecture.md` § Modern Type System) — pin down with fixtures.
- Error messages: SQLite's specific error codes won't match Quereus. Fixtures should use `-- error: <substring>` matching Quereus's wording. The substring should be specific enough to fail if the engine accepts the input but loose enough not to over-fit.
- Quoted-identifier and case-insensitivity rules — already broadly covered; check edge cases (quoted reserved words, mixed case in CREATE vs SELECT).
- Transactions interacting with assertions/deferred constraints: `42-committed-snapshot.sqllogic`, `43-transition-constraints.sqllogic`, `95-assertions.sqllogic` cover the Quereus-specific layer; SQLite has no analog.

## TODO

- [ ] Read process doc and assigned sections of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard.
