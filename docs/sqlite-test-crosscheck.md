# SQLite Test Cross-Check

Mapping of SQLite's test suite to Quereus's `test/logic/`, used to expand our test coverage by adapting work the open-source community has already done.

The process and per-ticket workflow are in [`sqlite-test-crosscheck-process.md`](sqlite-test-crosscheck-process.md). Work is dispatched via tess implement tickets (`tickets/implement/5-sqlite-xref-*.md`), one per category section below.

The new test fixtures themselves are the durable record of what each cross-check produced — there is no separate gaps log. The only "gaps" tracked here are gaps in the cross-check itself: rows still marked `unreviewed`.

## Sources

- **SQLite TCL test suite** (primary): https://github.com/sqlite/sqlite — `test/` directory.
- **SQLite sqllogictest corpus** (secondary): https://www.sqlite.org/sqllogictest/.

Do not mirror SQLite tests in bulk. Distill scenarios.

## Status

Every row carries one of three values:

| Status | Meaning |
|---|---|
| `unreviewed` | Cross-check not done. Pickable by a ticket. |
| `reviewed (handle, date)` | Cross-check done. Any new fixtures live in `packages/quereus/test/logic/`; existing fixtures listed in Coverage may have been updated. |
| `n/a (reason)` | Doesn't apply to Quereus by design. No cross-check needed. |

Columns: SQLite Source · Status · Quereus Coverage (existing fixtures the reviewer compared against) · Notes (one short sentence; `n/a` reason or any context).

## Out-of-scope categories (block-marked n/a)

These SQLite test areas don't apply by design (see `docs/architecture.md` § Design Differences from SQLite). Not in any ticket; listed here so reviewers don't pick them up:

- **Storage internals**: `btree*.test`, `pager*.test`, `wal*.test`, `mmap*.test`, `memdb*.test`, `journal*.test`, `pcache*.test`, `lock*.test`, `tempdb*.test` — storage delegated to VTab modules.
- **File-level operations**: `vacuum*.test`, `backup*.test`, `attach*.test`, `auth*.test`, `shared*.test` — schema is in-memory.
- **Rowids**: `rowid.test`, `rowidA-Z.test`, `intpkfault.test` — Quereus addresses by primary key.
- **Triggers**: `trigger1-9.test`, `triggerA-G.test` — no triggers in Quereus.
- **Type affinity**: `affinity.test`, `affinity2.test`, parts of `types.test` testing implicit coercion — Quereus uses logical/physical type separation.
- **Fault injection / corruption**: `corrupt*.test`, `crash*.test`, `ioerr*.test`, `malloc*.test`, `oom*.test`, `fault*.test`, `fts*.test`, `hook.test`, `loadext.test`.
- **Pragmas tied to file/page settings**: `pragma2-5.test` parts about `page_size`, `cache_size`, `journal_mode`, `synchronous`, `auto_vacuum`.

If a row in this list later turns out to have an applicable subset, lift it into the per-category section below as a new row.

---

## Index

Rows seeded from a survey of `packages/quereus/test/logic/` (116 files as of 2026-05-05).

### SELECT, projection, ORDER BY, LIMIT

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `select1.test` | unreviewed | 01-basic; 02-smoke | Basic SELECT mechanics, projection, FROM-less. |
| `select2.test` | unreviewed | 01-basic | Larger SELECT shapes. |
| `select3.test` | unreviewed | 07-aggregates | GROUP BY combinations. |
| `select4.test` | unreviewed | 09-set_operations; 28-set-ops-sort-edge-cases | Compound SELECT (UNION/INTERSECT/EXCEPT). |
| `select5.test` | unreviewed | 07-aggregates; 25-aggregate-edge-cases | Aggregate + DISTINCT interactions. |
| `select6.test` | unreviewed | 07.6-subqueries; 11-joins | Subqueries in FROM. |
| `select7.test` | unreviewed | 01-basic | Misc regressions. |
| `select8.test` | unreviewed | 09-set_operations | Compound + ORDER BY. |
| `select9.test` | unreviewed | 09-set_operations | Compound corner cases. |
| `selectA.test` | unreviewed | 09-set_operations | More compound. |
| `selectB.test`, `selectC.test`, `selectD.test`, `selectE.test` | unreviewed | (none mapped) | Misc SELECT regressions. |
| `orderby1.test` – `orderby9.test` | unreviewed | 28-set-ops-sort-edge-cases; 22-boundary-values | ORDER BY behavior, NULLS first/last, multi-key. Split per-file when reviewing. |
| `limit.test`, `limit2.test` | unreviewed | 94.1-limit-offset-edge-cases | LIMIT/OFFSET. |
| `distinct.test`, `distinct2.test` | unreviewed | 10-distinct_datatypes | DISTINCT semantics, multi-col. |
| `minmax.test`, `minmax2.test`, `minmax3.test`, `minmax4.test` | reviewed (claude, 2026-05-06) | 07-aggregates; 25-aggregate-edge-cases; 06.5.2-scalar-minmax | (see aggregates-windows ticket) Scalar multi-arg form gap filled in 06.5.2; index/plan-shape and rowid-arithmetic scenarios are n/a. |
| `count.test` | reviewed (claude, 2026-05-06) | 07-aggregates; 25-aggregate-edge-cases; 92-hash-aggregate-edge-cases | (see aggregates-windows ticket) COUNT(*) / COUNT(expr) / COUNT(DISTINCT) semantics already covered; OP_Count / WITHOUT ROWID optimizations are n/a. |
| `having.test` | reviewed (claude, 2026-05-06) | 07-aggregates; 25-aggregate-edge-cases; 25.2-having-edge-cases | (see aggregates-windows ticket) IS NULL / agg-vs-agg / ungrouped-column predicates added in 25.2. |
| `groupby.test` | reviewed (claude, 2026-05-06) | 07-aggregates; 92-hash-aggregate-edge-cases; 07.3-group-by-extras | (see aggregates-windows ticket) GROUP BY ordinal / expression / NOCASE / CASE coverage added in 07.3. SQLite source URL 404'd; cross-check based on Quereus existing coverage and SQLite-doc-known scenarios. |
| `e_select.test` | unreviewed | 01-basic; 07-aggregates | "Encyclopedia" SELECT — exhaustive grammar coverage. |

### WHERE, JOIN, indexing

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `where.test`, `where2-9.test`, `whereA-J.test` | unreviewed | 26-join-edge-cases; 100-predicate-normalization-edge-cases | WHERE clauses and index selection. Split per-file. |
| `join.test`, `join1-7.test` | unreviewed | 11-joins; 12-join_padding_order; 23-self-joins-duplicates; 26-join-edge-cases | Inner/outer/cross joins, NULL padding. |
| `joinB.test`, `joinC.test`, `joinD.test`, `joinE.test`, `joinF.test`, `joinG.test`, `joinH.test` | unreviewed | 11-joins; 26-join-edge-cases | Misc join regressions. |
| `index.test`, `index1-7.test` | unreviewed | 10.5-indexes; 40.1-pk-desc-direction | Index semantics. |
| `indexedby.test` | unreviewed | 10.5-indexes | INDEXED BY clause. |
| `between.test` | unreviewed | (none mapped) | BETWEEN semantics. |
| `in.test`, `in2-5.test` | unreviewed | 07.7-in-subquery-caching | IN/NOT IN with lists and subqueries. |
| `exists.test` | unreviewed | 08.1-semi-anti-join; 07.6-subqueries | EXISTS/NOT EXISTS. |
| `like.test`, `like2.test`, `like3.test` | unreviewed | 06.1-string-functions | LIKE/GLOB pattern matching. |
| `null.test` | unreviewed | 21-null-edge-cases | NULL semantics in expressions and predicates. |

### Subqueries, CTEs, set ops

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `subquery.test`, `subquery2.test` | unreviewed | 07.6-subqueries; 96-subquery-edge-cases | Scalar/row subqueries, IN-subquery. |
| `subqueryAsExpr.test` (or equivalent) | unreviewed | 07.8-correlated-subquery-edges | Correlated subqueries. |
| `with1.test` – `with5.test` | unreviewed | 13-cte; 13.1-cte-multiple-recursive; 13.2-cte-bind-params; 13.3-cte-edge-cases | CTEs incl. recursive. |
| `compound.test` (and parts of `select4`, `select8`) | unreviewed | 09-set_operations; 28-set-ops-sort-edge-cases | UNION/INTERSECT/EXCEPT. |

### Aggregates and window functions

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `aggfunc.test` | reviewed (claude, 2026-05-06) | 07-aggregates; 06.6-aggregate-extended; 07.1-aggregate-filter-clause; 07.2-aggregate-order-by | FILTER clause and ORDER BY-inside-aggregate gaps filled. |
| `aggnested.test` | reviewed (claude, 2026-05-06) | 25-aggregate-edge-cases; 25.1-nested-aggregates | Aggregate-over-aggregate via subquery / CTE / multi-level nesting added. |
| `window1.test` – `window9.test` | reviewed (claude, 2026-05-06) | 07.5-window; 27-window-edge-cases; 07.5.1-window-named; 07.5.2-window-nth-value; 27.1-window-groups-frame; 27.2-window-exclude | Named WINDOW clause, NTH_VALUE, GROUPS frame mode, and EXCLUDE clauses added (FILTER on window aggregates lives in 07.1). |
| `windowfault.test` | n/a (OOM/memory fault injection only — no grammar/error-path subset present) | (none) | Confirmed via fetch: contents are all `oom-*`/`tmpread` fault-injection wrappers around valid SQL; no applicable grammar errors. |

### Expressions, types, conversion

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `expr.test`, `expr2.test` | unreviewed | 03-expressions; 03.7-bigint-mixed-arithmetic; 22-boundary-values | Arithmetic, logical, comparison ops. |
| `e_expr.test` | unreviewed | 03-expressions | "Encyclopedia" expressions. |
| `cast.test` | unreviewed | 06.5.1-conversion-functions; 99-conversion-edge-cases | CAST. Quereus prefers `integer()`/`date()`/etc.; check both syntaxes. |
| `types.test` | unreviewed | 03.6-type-system; 10-distinct_datatypes | Strip out affinity-coercion sections (n/a); explicit-conversion subset applies. |
| `types2.test`, `types3.test` | unreviewed | 03.6-type-system | Same caveat as `types.test`. |
| `numcast.test`, `tostr.test` | unreviewed | 06.5.1-conversion-functions | Numeric ↔ text conversions. |
| `boundary*.test` | unreviewed | 22-boundary-values | Numeric/string boundaries. |
| `bigint.test` | unreviewed | 03.7-bigint-mixed-arithmetic | bigint arithmetic. |
| `collate1.test` – `collate9.test` | unreviewed | 06.4.1-schema-case-insensitive | Collation sequences. |

### Functions (scalar, string, math, date, json)

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `func.test`, `func2.test`, `func3.test`, `func4.test`, `func5.test`, `func6.test`, `func7.test` | unreviewed | 06-builtin_functions; 24-builtin-branches | Scalar functions. SQLite-specific (`zeroblob`, `quote`, etc.) per-func during review. |
| `substr.test` | unreviewed | 06.1-string-functions | SUBSTR semantics. |
| `printf.test`, `printf2.test` | unreviewed | (check) | `printf()`/`format()`. Confirm Quereus exposure. |
| `random.test` | unreviewed | 45-udf-determinism | `random()` is non-deterministic; bulk likely n/a under Quereus determinism rules. |
| `date.test`, `date2-4.test` | unreviewed | 16-epoch; 17-weekday-modifier; 98-temporal-edge-cases | Date/time functions and modifiers. |
| `json1.test` – `json5.test`, `json101-104.test` | unreviewed | 06.7-json-extended; 06.8-json-path-operators; 97-json-function-edge-cases | JSON functions and path operators. |

### DML (INSERT, UPDATE, DELETE, UPSERT, RETURNING)

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `insert.test`, `insert2-5.test` | unreviewed | 01-basic; 47-upsert | INSERT, INSERT...SELECT, multi-row. |
| `update.test`, `update2.test`, `update_from.test` | unreviewed | 01-basic; 90.4-dml-errors | UPDATE incl. UPDATE...FROM. |
| `delete.test`, `delete2-4.test` | unreviewed | 01-basic | DELETE. |
| `upsert.test`, `upsert2-4.test` | unreviewed | 47-upsert | INSERT ... ON CONFLICT. |
| `returning1.test` | unreviewed | 42-returning; 44-orthogonality | RETURNING. |
| `replace.test` | unreviewed | (check) | REPLACE INTO / OR REPLACE. |
| `conflict.test`, `conflict2-4.test` | unreviewed | 29-constraint-edge-cases; 102-unique-constraints | OR ABORT/FAIL/IGNORE/REPLACE/ROLLBACK. |

### DDL (CREATE/ALTER/DROP, views, indexes)

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `createtab.test` | unreviewed | 10.1-ddl-lifecycle; 10.2-column-features | CREATE TABLE syntax. |
| `tableopts.test` | unreviewed | 12-empty-primary-key | WITHOUT ROWID parts n/a; STRICT-table parts may apply differently. |
| `alter.test`, `altertbl.test`, `alter2-4.test` | unreviewed | 41-alter-table; 41.1-alter-pk; 41.2-alter-column; 90.2-alter-table-errors | ALTER TABLE. |
| `view.test` | unreviewed | 08-views; 93-ddl-view-edge-cases | CREATE/DROP VIEW. |
| `default.test` | unreviewed | 03.4-defaults | DEFAULT expressions. |
| `notnull.test`, `notnull2.test` | unreviewed | 43-default-nullability; 29-constraint-edge-cases | Quereus default differs (NOT NULL by default) — semantics overlap but defaults invert. |
| `unique.test`, `unique2.test` | unreviewed | 102-unique-constraints | UNIQUE constraint. |
| `check.test` | unreviewed | 40-constraints; 29-constraint-edge-cases | CHECK constraints. |
| `fkey1.test` – `fkey9.test` | unreviewed | 41-foreign-keys; 41-fk-cross-schema | Foreign keys, ON DELETE/UPDATE actions. |
| `generated.test` | unreviewed | 41-generated-columns | Generated/virtual columns. |
| `pragma.test`, `pragma1.test` (metadata-style only) | unreviewed | 103-database-options-edge-cases; 102-schema-catalog-edge-cases | Only the metadata/schema-introspection subset applies. |
| `analyze.test`, `analyze[3-9].test` | unreviewed | (none) | SQLite ANALYZE persists stats; Quereus stats are in-memory. Concept applies; mechanics differ. |

### Transactions, savepoints

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `trans.test`, `trans2.test`, `trans3.test` | unreviewed | 04-transactions; 101-transaction-edge-cases | BEGIN/COMMIT/ROLLBACK semantics. |
| `savepoint.test`, `savepoint2-7.test` | unreviewed | 04-transactions | SAVEPOINT / RELEASE / ROLLBACK TO. |
| `transaction.test` | unreviewed | 04-transactions | Misc transaction regressions. |

### Bound parameters, identifiers

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `bind.test` | unreviewed | 13.2-cte-bind-params | Parameter binding (`?`, `:name`, `@name`, `$name`). |
| `descidx*.test` | unreviewed | 40.1-pk-desc-direction | Descending indexes. |
| `identifier.test` (if present) | unreviewed | 03.1-quoted-identifiers; 06.4.1-schema-case-insensitive | Quoting and identifier resolution. |

### Error paths

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `errors.test` (if present) | unreviewed | 90.1-parse-errors; 90.3-expression-errors; 90.4-dml-errors; 90-error_paths | Error message coverage; SQLite error codes won't match — focus on which inputs raise. |

### Quereus-specific (no SQLite analog)

These exercise design differences from SQLite. Listed so reviewers don't try to map them.

- `42-committed-snapshot.sqllogic` — `committed.tablename` pseudo-schema.
- `43-transition-constraints.sqllogic` — transition constraints via committed.*.
- `44-determinism-validation.sqllogic`, `45-udf-determinism.sqllogic`, `46-mutation-context.sqllogic` — determinism enforcement and `WITH CONTEXT`.
- `44-orthogonality.sqllogic` — relational orthogonality (statements as relations).
- `49-reference-graph.sqllogic` — schema reference graph.
- `50-declarative-schema.sqllogic`, `50.1-declare-schema-pk.sqllogic`, `50-metadata-tags.sqllogic` — declarative schema.
- `80-grow-retrieve-pass.sqllogic`, `81-quickpick.sqllogic`, `82-bloom-join.sqllogic`, `83-merge-join.sqllogic`, `91-merge-join-edge-cases.sqllogic`, `84-key-cardinality.sqllogic`, `85-relational-const-folding.sqllogic`, `86-scalar-cse.sqllogic`, `100-predicate-normalization-edge-cases.sqllogic`, `108-cardinality-estimation.sqllogic`, `109-aggregate-physical-selection.sqllogic` — optimizer rules and plan-shape decisions.
- `95-assertions.sqllogic` — `CREATE ASSERTION`.
- `101-builtin-mutation-kills.sqllogic`, `104-emit-mutation-kills.sqllogic`, `105-vtab-memory-mutation-kills.sqllogic`, `106-constraint-extractor-mutation-kills.sqllogic`, `107-temporal-arithmetic-mutation-kills.sqllogic`, `110-scan-emitter-mutation-kills.sqllogic` — mutation-testing kill files.
- `15-timespan.sqllogic` — interval/timespan type.
- `06.4-schema-search-path.sqllogic`, `06.3.1-schema-all-schemas.sqllogic` — multi-schema search path.
- `14-utilities.sqllogic`, `pushdown-test.sqllogic` — internal utilities.
