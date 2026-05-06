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
| `index.test`, `index1-7.test` | reviewed (claude, 2026-05-06) | 10.5-indexes; 40.1-pk-desc-direction; 102.1-unique-edge-cases; 06.4.2-collation-extras; 06.3-schema; 41.3-alter-rename-propagation; 10.5.1-partial-indexes; 10.5.2-expression-indexes | Basic CREATE / DROP / IF [NOT] EXISTS / multi-column / DESC / UNIQUE / NULLs / COLLATE / schema introspection / post-hoc CREATE UNIQUE INDEX rejecting duplicates already covered. Partial indexes (basic, partial UNIQUE within scope, IS NULL predicate, compound WHERE, scope-transition on UPDATE) added in 10.5.1. Expression indexes (UPPER, arithmetic, concatenation, UNIQUE on lower(), expression+partial combo) added in 10.5.2. Implicit rowid auto-index, INTEGER-PK rowid alias, REINDEX, ATTACH, PRAGMA case_sensitive_like, page-format / disk-I/O patterns (index5.test), 65k-row stress (index4.test), and reserved-prefix `sqlite_` index name rejection are n/a (no rowids, no REINDEX, no ATTACH, storage delegated to VTab; reserved-name policy is SQLite-specific). |
| `indexedby.test` | n/a (INDEXED BY / NOT INDEXED hint syntax not in Quereus parser; planner uses cost-based selection) | 10.5-indexes | Confirmed: every bullet in indexedby.test exercises the hint clause itself; Quereus has no equivalent grammar (verified by grep over src/parser and the explicit n/a comment in 01.6-update-extras line 3). |
| `between.test` | unreviewed | (none mapped) | BETWEEN semantics. |
| `in.test`, `in2-5.test` | unreviewed | 07.7-in-subquery-caching | IN/NOT IN with lists and subqueries. |
| `exists.test` | unreviewed | 08.1-semi-anti-join; 07.6-subqueries | EXISTS/NOT EXISTS. |
| `like.test`, `like2.test`, `like3.test` | reviewed (claude, 2026-05-06) | 06-builtin_functions; 24-builtin-branches; 06.1.3-like-glob-edges | Case-sensitivity invariant (Quereus is fixed case-sensitive — no PRAGMA case_sensitive_like), multi-byte `_` matching, LIKE on numeric/BLOB columns, ESCAPE clause (`\%`, `\_`, `\\`), GLOB character classes (`[abc]`, `[a-c]`, `[^abc]`) added in 06.1.3. like3.test (optimizer plan-shape, REINDEX, UTF-16 encoding) n/a. |
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
| `expr.test`, `expr2.test` | reviewed (claude, 2026-05-06) | 03-expressions; 03.7-bigint-mixed-arithmetic; 22-boundary-values; 03.2-bitwise-operators; 03.3-is-truthy-falsy | Bitwise binary operators (&/\|/<</>>) added in 03.2. IS TRUE/FALSE/NOT TRUE/NOT FALSE added in 03.3. Rowid arithmetic, internal search-count counters, sqlite3-only introspection are n/a. |
| `e_expr.test` | reviewed (claude, 2026-05-06) | 03-expressions; 03.6-type-system; 03.2-bitwise-operators | "Encyclopedia of expressions" surface (binary/unary ops, IS NULL, BETWEEN, LIKE/GLOB, CASE, CAST, EXISTS, IN, COLLATE, parentheses, NULL propagation, function calls) covered by existing fixtures plus 03.2 bitwise gap. RAISE / MATCH / REGEXP n/a (no triggers, no FTS, no regex matcher). |
| `cast.test` | reviewed (claude, 2026-05-06) | 06.5.1-conversion-functions; 99-conversion-edge-cases; 03.6-type-system; 99.1-cast-syntax-extras | BLOB roundtrip via CAST, scientific notation, whitespace trim, `cast('3.0' as numeric)` → INTEGER affinity, IEEE 754 INF/NaN, BOOLEAN ↔ numeric edges added in 99.1. |
| `types.test` | reviewed (claude, 2026-05-06) | 03.6-type-system; 10-distinct_datatypes | Cross-type ordering (NULL < num < text < blob), BLOB byte-comparison, typeof bucket names, NULL ordering, BOOLEAN ordering, lexicographic date/time ordering all already covered. Implicit column-type affinity coercion / CREATE TABLE NUMERIC/INTEGER/TEXT/BLOB affinity rules / SQLite physical record sizing are n/a (Quereus uses strict logical types). |
| `types2.test`, `types3.test` | reviewed (claude, 2026-05-06) | 03.6-type-system; 99.1-cast-syntax-extras | Cross-category comparison (=, <, >, BETWEEN) and IN with mixed-type literal lists pinned in 99.1; rest of types2/types3 (column-type affinity, manifest-typing via Tcl variables, custom-function affinity tagging, index-affinity optimization) n/a by design. |
| `numcast.test`, `tostr.test` | reviewed (claude, 2026-05-06) | 06.5.1-conversion-functions; 99-conversion-edge-cases; 99.1-cast-syntax-extras | Whitespace trimming, scientific notation, real-to-text formatting added in 99.1. `tostr.test` does not exist upstream (numeric-to-text covered via existing text() / cast(... as text) tests). SQLite UTF-16 internal encoding paths n/a. |
| `boundary*.test` | reviewed (claude, 2026-05-06) | 22-boundary-values; 03.7-bigint-mixed-arithmetic; 99.1-cast-syntax-extras | Value-domain boundaries (Number.MAX_SAFE_INTEGER ±, empty string/BLOB, IEEE 754 0.0 vs -0.0, mixed-type arithmetic) already covered; INF/NaN handling added in 99.1. SQLite varint / page-format / bytecode-level boundary tests are n/a (storage delegated to VTab). |
| `bigint.test` | n/a (file does not exist in upstream sqlite/sqlite — confirmed via raw URL 404) | 03.7-bigint-mixed-arithmetic | Mixed-type bigint/number arithmetic at 2^53 boundary fully covered in 03.7; no upstream `bigint.test` to mirror. |
| `collate1.test` – `collate9.test` | reviewed (claude, 2026-05-06) | 06.4.1-schema-case-insensitive; 03-expressions; 03.6-type-system; 07.5-window; 07.3-group-by-extras; 06.4.2-collation-extras | ORDER BY with column-level NOCASE/explicit override, RTRIM in WHERE/ORDER BY/DISTINCT, JOIN ON with COLLATE override, DISTINCT NOCASE dedup, UNION/INTERSECT/EXCEPT under NOCASE, MIN/MAX under NOCASE, INDEX with COLLATE NOCASE, COLLATE in CASE all added in 06.4.2. C-API `sqlite3_create_collation_v2` / collation factory callbacks / REINDEX / UTF-16 encoding / ATTACH cross-collation are n/a (Quereus uses plugin path; no REINDEX or ATTACH). |

### Functions (scalar, string, math, date, json)

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `func.test` | reviewed (claude, 2026-05-06) | 06-builtin_functions; 24-builtin-branches; 06.1.1-string-functions-extended | hex(), char(), unicode(), octet_length() (UTF-8 byte vs char distinction) added in 06.1.1. SQLite-specific quote(), zeroblob(), last_insert_rowid(), changes(), total_changes(), sqlite_version(), likelihood/likely/unlikely n/a (storage internals, debug helpers, optimizer hints). |
| `func2.test` | reviewed (claude, 2026-05-06) | 06-builtin_functions; 24-builtin-branches; 24.1-substr-extras | NULL propagation across substr args, substring() alias equivalence, Y > strlen, 2-arg negative-Y forms, Y=0+length, negative-Z (chars preceding Y per SQLite docs), multi-byte indexing all added in 24.1. BLOB byte-substr n/a (Quereus stringifies). |
| `func3.test` | n/a (likelihood/likely/unlikely optimizer hints + C-API destructor mechanics not present in Quereus) | 06-builtin_functions | No SQL-observable surface. |
| `func4.test` | n/a (totype.c extension — tointeger()/toreal() not in Quereus core) | 06-builtin_functions | Extension-specific type-conversion functions; Quereus uses logical type system instead. |
| `func5.test` | reviewed (claude, 2026-05-06) | 44-determinism-validation; 45-udf-determinism | Deterministic-vs-nondeterministic factoring covered in determinism fixtures; remaining content is plan-shape / SQLITE_DETERMINISTIC C-API flag mechanics (n/a). |
| `func6.test` | n/a (sqlite_offset() — b-tree byte-offset introspection; storage delegated to VTab modules) | (none) | Verified via fetch: file is entirely sqlite_offset() probes. |
| `func7.test` | reviewed (claude, 2026-05-06) | 06.2-math-functions; 06.2.1-math-extended | SQLite 3.35+ math surface (ln/log/log10/log2/exp, trig, hyperbolic, pi/degrees/radians, trunc/mod/sign) pinned in 06.2.1. |
| `substr.test` | reviewed (claude, 2026-05-06) | 06-builtin_functions; 24-builtin-branches; 24.1-substr-extras | Most edges (negative Y, Y=0, negative Z → empty) already covered; NULL propagation via columns, substring() alias, multi-byte indexing, Y past end, 2-arg negative-Y, Y=0+length, SQLite negative-Z (chars preceding) added in 24.1. |
| `printf.test`, `printf2.test` | reviewed (claude, 2026-05-06) | 06.1.2-printf | printf() / format() not currently registered in Quereus; fixture in 06.1.2 documents the SQLite surface (integer / float / string / %q / %Q / %w / %% / width-precision / asterisk-width / %c / %,d / NULL handling / format() alias) so the next pass decides whether to add the function or reclassify. |
| `random.test` | n/a (file does not exist in upstream sqlite/sqlite — confirmed via raw URL 404) | 06.2-math-functions; 24.2-random-extras; 44-determinism-validation; 45-udf-determinism | randomblob() type/length contract and arity validation pinned in 24.2 as a regression guard. |
| `date.test`, `date2-4.test` | unreviewed | 16-epoch; 17-weekday-modifier; 98-temporal-edge-cases | Date/time functions and modifiers. |
| `json1.test` – `json5.test`, `json101-104.test` | unreviewed | 06.7-json-extended; 06.8-json-path-operators; 97-json-function-edge-cases | JSON functions and path operators. |

### DML (INSERT, UPDATE, DELETE, UPSERT, RETURNING)

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `insert.test`, `insert2-5.test` | reviewed (claude, 2026-05-06) | 01-basic; 47-upsert; 01.5-insert-select | INSERT…SELECT variants (column reordering, GROUP BY, compound, JOIN, DISTINCT, LIMIT, self-reference, view-mediated, correlated WHERE, CHECK propagation) added in 01.5. Trigger / rowid / autoincrement scenarios n/a. |
| `update.test`, `update2.test`, `update_from.test` | reviewed (claude, 2026-05-06) | 01-basic; 90.4-dml-errors; 01.6-update-extras; 01.7-update-from | UPDATE all-rows / scalar subquery in SET / multi-column SET / column-list `(a,b)=(subquery)` / NOT / OR / PK-change in 01.6. UPDATE…FROM single table / subquery FROM / CTE FROM / multi-table FROM in 01.7. `update_from.test` n/a (file does not exist in upstream sqlite/sqlite — confirmed via gh api 404). UPDATE LIMIT/ORDER BY / INDEXED BY / rowid n/a. |
| `delete.test`, `delete2-4.test` | reviewed (claude, 2026-05-06) | 01-basic; 29-constraint-edge-cases; 41-foreign-keys; 01.8-delete-extras | DELETE EXISTS / NOT EXISTS / NOT(...) / OR / multi-column AND / self-referential EXISTS / composite-PK delete-all / IN-subquery added in 01.8. `delete2.test` n/a (cursor-lock and index-corruption regression that's not user-observable in Quereus). DELETE LIMIT/ORDER BY / rowid forms n/a. |
| `upsert.test`, `upsert2-4.test` | reviewed (claude, 2026-05-06) | 47-upsert; 47.1-upsert-conflict-targets | `upsert.test` n/a (file does not exist in upstream — confirmed via gh api 404). Composite UNIQUE conflict targets (full match, reversed order, partial-target rejection), `excluded.col` semantics, `INSERT…AS alias`, CTE source for UPSERT, DO UPDATE WHERE filter, column-list assignment in DO UPDATE SET, multi-row UPSERT mix-and-match added in 47.1. Trigger / WITHOUT ROWID variants n/a. |
| `returning1.test` | reviewed (claude, 2026-05-06) | 42-returning; 44-orthogonality; 42.1-returning-extras | Scalar subquery in RETURNING list, INSERT…SELECT with RETURNING, quoted/bracketed identifiers, RETURNING on no-op DO NOTHING upsert, RETURNING on UPDATE OR IGNORE skip, generated-column RETURNING projection added in 42.1. Trigger / FTS / sqlite_schema scenarios n/a. |
| `replace.test` | reviewed (claude, 2026-05-06) | 47-upsert; 102-unique-constraints; 43.1-notnull-or-conflict; 47.2-replace-and-or-clauses | `replace.test` does not exist upstream, but the surface called out in the ticket is exercised in 47.2: REPLACE INTO keyword, multi-row REPLACE, multi-conflict REPLACE (cross-UNIQUE), REPLACE+RETURNING, UPDATE OR REPLACE on UNIQUE, INSERT OR ABORT/FAIL/ROLLBACK semantics with respect to surrounding transactional state, OR IGNORE on CHECK, and OR REPLACE not masking CHECK. |
| `conflict.test`, `conflict2-4.test` | reviewed (claude, 2026-05-06) | 29-constraint-edge-cases; 102-unique-constraints; 47.2-replace-and-or-clauses; 29.1-column-level-conflict-clause | `conflict4.test` n/a (file does not exist upstream — confirmed via gh api 404). OR ABORT/FAIL/ROLLBACK semantics in 47.2. Column-level ON CONFLICT directives (PRIMARY KEY/UNIQUE/NOT NULL/CHECK ON CONFLICT REPLACE/IGNORE; statement-level OR override) pinned in 29.1. |

### DDL (CREATE/ALTER/DROP, views, indexes)

| SQLite Source | Status | Quereus Coverage | Notes |
|---|---|---|---|
| `createtab.test` | reviewed (claude, 2026-05-06) | 10.1-ddl-lifecycle; 10.2-column-features; 10.1.1-create-table-syntax-edges | Untyped columns, DDL during cursor, duplicate-column UNIQUE rejection added in 10.1.1. |
| `tableopts.test` | reviewed (claude, 2026-05-06) | 12-empty-primary-key; 10.2.1-table-options-rejection | WITHOUT ROWID rejected; unknown table options rejected; STRICT-equivalent type enforcement pinned in 10.2.1. AUTOINCREMENT / WITHOUT ROWID storage semantics are n/a. |
| `alter.test` | reviewed (claude, 2026-05-06) | 41-alter-table; 41.1-alter-pk; 41.2-alter-column; 90.2-alter-table-errors; 41.3-alter-rename-propagation; 41.4-alter-add-column-constraints; 41.5-alter-misc; 90.2.1-alter-extra-errors | RENAME/ADD/DROP COLUMN, ALTER PRIMARY KEY, ALTER COLUMN already covered; UTF-8 identifiers, in-transaction ALTER, default-aggregate, ADD COLUMN with CHECK/REFERENCES/COLLATE/UNIQUE, missing-table errors, non-constant default rejection, backfill CHECK violation added. Triggers, ATTACH, sqlite_master direct edits are n/a. |
| `altertbl.test` (= `altertab.test`) | reviewed (claude, 2026-05-06) | 41-alter-table; 41.3-alter-rename-propagation | Schema rewrite of dependent objects (views, CHECK, FK, partial-index, CTE inside view, index expression) added in 41.3. Trigger / WITHOUT ROWID / ATTACH variants n/a. |
| `alter2.test` | reviewed (claude, 2026-05-06) | 41-alter-table; 41.4-alter-add-column-constraints | Integer/real default backfill scenarios added in 41.4. File-format compatibility (file format 2/5, VACUUM reset, attached DB) is n/a. |
| `alter3.test` | reviewed (claude, 2026-05-06) | 41-alter-table; 41.4-alter-add-column-constraints; 90.2.1-alter-extra-errors; 93.1-view-error-paths | ADD COLUMN CHECK/REFERENCES/UNIQUE rejection, ALTER on view rejection, non-constant default rejection, backfill+CHECK rollback added. ATTACH / TEMP triggers / VACUUM / sqlite_master n/a. |
| `alter4.test` | reviewed (claude, 2026-05-06) | 41-alter-table; 41.4-alter-add-column-constraints; 90.2.1-alter-extra-errors; 93.1-view-error-paths | Same surface as alter3 (TEMP/ATTACH variants); applicable bullets covered by 41.4 / 90.2.1 / 93.1. Rest n/a (triggers, ATTACH, file-format, large-int affinity). |
| `view.test` | reviewed (claude, 2026-05-06) | 08-views; 93-ddl-view-edge-cases; 08.1-view-edge-cases; 93.1-view-error-paths | Multi-level views, column-list rename, TEMP VIEW, compound select, schema-qualified, self-join in view added in 08.1. Dangling base table, drop mismatch, mutation rejection, ALTER on view added in 93.1. INSTEAD OF triggers, recursive views, ATTACH n/a. |
| `default.test` | reviewed (claude, 2026-05-06) | 03.4-defaults; 10.2-column-features; 44-determinism-validation; 03.4.1-default-edge-cases | Negative integer / boundary integer / real / DEFAULT VALUES / DEFAULT+NOT NULL+UNIQUE+CHECK / parameter+column-ref rejection in 03.4.1. CURRENT_TIMESTAMP / random() defaults are n/a (rejected as non-deterministic per 44). |
| `notnull.test` | reviewed (claude, 2026-05-06) | 43-default-nullability; 10.2-column-features; 29-constraint-edge-cases; 43.1-notnull-or-conflict | INSERT/UPDATE OR IGNORE / OR REPLACE on NOT NULL with and without DEFAULT, INSERT...SELECT propagation added in 43.1. |
| `notnull2.test` | reviewed (claude, 2026-05-06) | 43-default-nullability; 26.1-left-join-isnull-on-notnull; 25.3-aggregate-isnull-empty | Most of notnull2 is planner-step-count introspection (n/a); the observable LEFT JOIN with IS NULL and aggregate IS NULL on empty NOT NULL table cases added. |
| `unique.test`, `unique2.test` | reviewed (claude, 2026-05-06) | 102-unique-constraints; 47-upsert; 102.1-unique-edge-cases | COLLATE NOCASE in UNIQUE, error-message column identification, post-hoc CREATE UNIQUE INDEX failing on duplicates, bad-column-ref in PK/UNIQUE/INDEX added in 102.1. DEFERRABLE UNIQUE / partial UNIQUE INDEX / SQLite numeric error codes n/a. |
| `check.test` | reviewed (claude, 2026-05-06) | 40-constraints; 29-constraint-edge-cases; 43-transition-constraints; 40.2-check-extras | CHECK with typeof()/CASE/BETWEEN/COLLATE, INSERT...SELECT enforcement, parameter-in-CHECK rejection added in 40.2. ON CONFLICT clause on CHECK / PRAGMA ignore_check_constraints / rowid refs are n/a. |
| `fkey1.test` | reviewed (claude, 2026-05-06) | 41-foreign-keys; 41-fk-cross-schema; 06.3.2-schema-foreign-keys; 41-fk-extended-targets; 41-fk-cascade-conflict-and-self-ref | Non-PK UNIQUE parent target, generated-column FK, multi-FK on one child, FK arity mismatch, FK to missing parent, multi-column parent column-order added in 41-fk-extended-targets. Self-referential composite FK in 41-fk-cascade-conflict-and-self-ref. |
| `fkey2.test` | reviewed (claude, 2026-05-06) | 41-foreign-keys; 29-constraint-edge-cases; 41-fk-cascade-conflict-and-self-ref | INSERT/UPDATE OR IGNORE/ABORT child semantics, cascade chain hitting another FK's RESTRICT, multi-row parent UPDATE cascade added. DEFERRABLE / DBSTATUS / triggers n/a. |
| `fkey3.test` | reviewed (claude, 2026-05-06) | 41-foreign-keys; 06.3.2-schema-foreign-keys; 41-fk-cascade-conflict-and-self-ref | DROP TABLE of referenced parent rejected; self-referential composite FK with UNIQUE target added. PRAGMA foreign_key_check / integrity_check n/a (Quereus uses foreign_key_info() TVF). |
| `fkey4.test` | reviewed (claude, 2026-05-06) | 41-foreign-keys; 41-fk-cascade-conflict-and-self-ref | DEFERRABLE INITIALLY DEFERRED column FK + repeated auto-commit failure pinned (regression guard). |
| `fkey5.test` | reviewed (claude, 2026-05-06) | 41-foreign-keys; 06.3.2-schema-foreign-keys; 41-fk-extended-targets | UNIQUE-column FK target, COLLATE NOCASE FK match, multi-column FK with non-natural column order, missing parent table, FK arity mismatch added. WITHOUT ROWID variants n/a. |
| `fkey6.test` | reviewed (claude, 2026-05-06) | 41-foreign-keys; 29-constraint-edge-cases; 95-assertions | Quereus auto-defers cross-table FK checks to COMMIT (no defer_foreign_keys / DEFERRABLE / DBSTATUS). Standard commit-time enforcement and post-rollback recovery already covered; no new fixtures. |
| `fkey7.test` | reviewed (claude, 2026-05-06) | 41-foreign-keys; 41-fk-extended-targets | UNIQUE-column FK target covered in 41-fk-extended-targets; remaining bullets are deferred-mode / INSERT-OR-FAIL precedence which are n/a. |
| `fkey8.test` | reviewed (claude, 2026-05-06) | 41-foreign-keys; 41-fk-cross-schema; 29-constraint-edge-cases | Standard cascade/MATCH SIMPLE/multi-column already covered; DEFERRABLE / WITHOUT ROWID / ATTACH / triggers n/a. No new fixtures. |
| `fkey9.test` | n/a (file does not exist in upstream sqlite/sqlite — series stops at fkey8) | (none) | Verified via raw URL 404 and gh api repos/sqlite/sqlite/contents/test. |
| `generated.test` | reviewed (claude, 2026-05-06) | 41-generated-columns; 41-generated-column-extras; 41-generated-column-errors | Chains, query usage (WHERE/ORDER BY/GROUP BY), type coercion, generated as UNIQUE/PK in extras. Self-reference, mutually-recursive, DROP COLUMN of referenced column in errors. RAISE / pragma_table_xinfo / rowid scenarios n/a. |
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
| `descidx*.test` | reviewed (claude, 2026-05-06) | 40.1-pk-desc-direction; 10.5-indexes; 06.3-schema; 10.5.3-desc-index-ordering; test/optimizer/desc-index-ordering.spec.ts | Single-column DESC traversal, composite mixed-direction (ASC, DESC), DESC ordering of NULLs (NULLS FIRST / LAST), DESC range scan, DESC TEXT lexicographic added in 10.5.3. Plan-shape: ORDER BY DESC consumes DESC index without SORT, range filter+ORDER BY DESC uses index, composite (ASC, DESC) index satisfies equality+DESC trailing without SORT — added in test/optimizer/desc-index-ordering.spec.ts. SQLite file-format-version 4 / VACUUM-with-format-preservation paths n/a (in-memory; no on-disk format constraints). |
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
