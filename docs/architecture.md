# Quereus Architecture

This document describes the internal architecture of the Quereus SQL engine: the pipeline from SQL text to result rows, the source layout, the conventions for extending the engine, and the design decisions that shape it. For the user-facing feature overview and quick start, see [`packages/quereus/README.md`](../packages/quereus/README.md).

## Pipeline Overview

Quereus is built on partially immutable `PlanNode`s and an instruction-based runtime with an attribute-based context system.

1. **SQL Input** — a SQL query string.
2. **Parser (`src/parser`)**
	* **Lexer (`lexer.ts`)** — tokenizes the raw SQL string.
	* **Parser (`parser.ts`)** — builds an Abstract Syntax Tree (AST).
3. **Planner (`src/planner`)**
	* Traverses the AST to construct a tree of immutable `PlanNode` objects representing the logical query structure.
	* Handles Common Table Expressions (CTEs) and subqueries by converting them into relational `PlanNode`s.
	* Resolves table and function references using the Schema Manager.
	* Performs query planning using each virtual table's `getBestAccessPlan` method and table/column statistics.
	* **Optimizer (`src/planner/optimizer`)** — transforms logical plans into efficient physical execution plans through a rule-based optimization system. See [Optimizer Documentation](optimizer.md).
4. **Runtime (`src/runtime`)**
	* **Emitters (`src/runtime/emitters.ts`, `src/runtime/emit/`)** — translate `PlanNode`s into a graph of `Instruction` objects.
	* **Scheduler (`src/runtime/scheduler.ts`)** — manages the execution flow of the `Instruction` graph.
	* **Instructions** — JavaScript functions operating on `RuntimeValue`s (either `SqlValue` or `AsyncIterable<Row>`). Async parameters are awaited.
	* Invokes virtual table methods (e.g., `query` which returns `AsyncIterable<Row>`, `update`) to interact with data.
	* Calls User-Defined Functions (UDFs) and aggregate functions.
	* Handles transaction and savepoint control.
5. **Virtual Tables (`src/vtab`)** — the core data interface. Modules implement `VirtualTableModule`. `MemoryTable` (`vtab/memory/table.ts`) is the reference implementation, using `digitree`.
6. **Schema Management (`src/schema`)** — manages schemas, tables, columns, functions.
7. **User-Defined Functions (`src/func`)** — support for custom JS functions in SQL.
8. **Core API (`src/core`)** — `Database`, `Statement` classes.

## Source File Layout

```
src/
├── core/                     # Database, Statement, transactions
├── parser/                   # SQL parser → AST
├── planner/                  # AST → PlanNode tree
│   ├── building/             # Plan builders (select.ts, expression.ts, ddl.ts, ...)
│   ├── nodes/                # PlanNode classes (one per node type)
│   │   └── plan-node-type.ts # PlanNodeType enum — add new node types here
│   ├── rules/                # Optimizer rules, by category:
│   │   ├── access/           #   access-path selection
│   │   ├── aggregate/        #   streaming aggregation
│   │   ├── cache/            #   CTE, IN-subquery, materialization
│   │   ├── distinct/         #   distinct elimination
│   │   ├── join/             #   join commutation, physical selection
│   │   ├── predicate/        #   predicate pushdown
│   │   ├── retrieve/         #   retrieve growth
│   │   └── subquery/         #   subquery decorrelation
│   ├── framework/            # Optimizer framework (characteristics, passes, registry)
│   ├── cost/                 # Cost model (index.ts)
│   ├── analysis/             # Const evaluator, constraint extractor, predicate normalizer
│   ├── stats/                # Table/column statistics
│   ├── validation/           # Plan validation passes
│   ├── scopes/               # Name resolution scopes
│   └── cache/                # Plan cache
├── runtime/
│   ├── emit/                 # Instruction emitters (mirrors planner/nodes/)
│   ├── cache/                # Runtime caching
│   └── functions/            # Runtime function dispatch
├── emit/                     # Top-level emitter entry (plan → instructions)
├── schema/                   # Catalog, schema manager, table/column/view/assertion defs
├── types/                    # Type system (logical types, registry, temporal, JSON)
├── func/builtins/            # Built-in functions (scalar, aggregate, string, datetime, json, ...)
├── vtab/                     # Virtual table framework
│   └── memory/               # In-memory VTab implementation (layers, merge iterators)
├── common/                   # Shared constants, errors, logger, type inference
└── util/                     # Miscellaneous utilities

test/
├── logic/                    # SQL logic tests (*.sqllogic) — primary test suite
├── plan/                     # Plan-shape tests (basic/, joins/, aggregates/)
├── optimizer/                # Optimizer-specific tests
├── planner/                  # Planner unit tests
├── vtab/                     # VTab tests
└── util/                     # Test utilities
```

Key relationships: each PlanNode in `planner/nodes/` has a matching emitter in `runtime/emit/`. Optimizer rules in `planner/rules/` are registered via `planner/framework/registry.ts`. Tests go in `test/logic/*.sqllogic` (SQL logic tests) or `test/plan/` (plan shape tests).

## Common Implementation Patterns

**Adding a new PlanNode** (follow an existing node as template):
1. `planner/nodes/my-node.ts` — node class (e.g. copy `bloom-join-node.ts` for joins)
2. `planner/nodes/plan-node-type.ts` — add enum entry
3. `runtime/emit/my-node.ts` — matching emitter
4. `emit/emitter.ts` — register emitter in the visitor
5. Tests in `test/logic/*.sqllogic` or `test/plan/`

**Adding an optimizer rule:**
1. `planner/rules/<category>/rule-my-rule.ts` (copy an existing rule in the same category)
2. Register in `planner/framework/registry.ts`
3. Cost constants go in `planner/cost/index.ts`

**Adding a built-in function:**
1. `func/builtins/<category>.ts` (scalar.ts, string.ts, aggregate.ts, json.ts, datetime.ts, ...)
2. Register via `func/registration.ts`

All paths above are relative to `src/`.

## Key Design Decisions

*   **Federated / VTab-Centric** — all tables are virtual tables.
*   **Async Core** — core operations are asynchronous. Cursors are `AsyncIterable<Row>`.
*   **Key-Based Addressing** — rows are identified by their defined Primary Key. No separate implicit `rowid`.
*   **Relational Orthogonality** — any statement that results in a relation can be used anywhere that expects a relation value, including mutating statements with RETURNING clauses.
*   **Declarative Schema (Optional)** — keep using DDL normally. Optionally use order‑independent `declare schema { ... }` to describe end‑state; the engine computes diffs against current state using module‑reported catalogs and emits canonical DDL. You may auto‑apply via `apply schema` or fetch the DDL and run it yourself (enabling custom backfills). Supports seeds, imports (URL + cache), versioning, and schema hashing. Destructive changes require explicit acknowledgement.
*   **JavaScript Types** — uses standard JavaScript types (`number`, `string`, `bigint`, `boolean`, `Uint8Array`, `null`) internally.
*   **Object-Based API** — uses classes (`Database`, `Statement`) to represent resources with lifecycles, rather than handles.
*   **Transient Schema** — schema information is primarily in-memory; persistence is not a goal. Emission of schema SQL export is supported.
*   **Multi-Schema Support** — organize tables across multiple schemas with flexible search paths for modular designs.
*   **Bags vs Sets Distinction** — explicit type-level distinction between relations that guarantee unique rows (sets) and those that allow duplicates (bags), enabling sophisticated optimizations and maintaining algebraic correctness in line with Third Manifesto principles.
*   **Attribute-Based Context System** — robust column reference resolution using stable attribute IDs eliminates architectural fragilities and provides deterministic context lookup across plan transformations.

## Design Differences from SQLite

While Quereus supports standard SQL syntax, it has several distinctive design choices:

*   **Modern Type System** — uses logical/physical type separation instead of SQLite's type affinity model. Includes native temporal types (DATE, TIME, DATETIME) and JSON type with deep equality comparison. Conversion functions (`integer()`, `date()`, `json()`) are preferred over CAST syntax. All expressions have known types at plan time, including parameters; cross-category comparisons (e.g., numeric vs text) are handled via explicit conversions rather than implicit runtime coercion. See [Type System Documentation](types.md).
*   **Virtual Table Centric** — uses `CREATE TABLE ... USING module(...)` syntax. All tables are virtual tables.
*   **Default NOT NULL Columns** — following Third Manifesto principles, columns default to NOT NULL unless explicitly specified otherwise. This behavior can be controlled via `pragma default_column_nullability = 'nullable'` to restore SQL standard behavior.
*   **No Rowids** — all tables are addressed by their Primary Key. When no explicit PRIMARY KEY is defined, Quereus includes all columns in the primary key.
*   **Async API** — core execution is asynchronous with async/await patterns throughout.
*   **No Triggers or Built-in Persistence** — persistent storage can be implemented as a VTab module.

## Constraints

- Row-level CHECKs that reference only the current row are enforced immediately.
- Row-level CHECKs that reference other tables (e.g., via subqueries) are automatically deferred and enforced at COMMIT using the same optimized engine as global assertions. No `DEFERRABLE` or `SET CONSTRAINTS` management is required by the user.
- `CREATE ASSERTION name CHECK (...)` defines database-wide invariants evaluated at COMMIT.
- `FOREIGN KEY ... REFERENCES` with `ON DELETE CASCADE/SET NULL/RESTRICT` and `ON UPDATE CASCADE/SET NULL/RESTRICT`.
- **`committed.tablename` pseudo-schema** — provides read-only access to the pre-transaction (committed) state of any table. Enables transition constraints that compare current and committed state (e.g., `CREATE ASSERTION no_decrease CHECK (NOT EXISTS (SELECT 1 FROM t JOIN committed.t ct ON t.id = ct.id WHERE t.val < ct.val))`). The committed view is pinned to the transaction-start snapshot and is unaffected by savepoints.
- **Determinism Enforcement** — CHECK constraints and DEFAULT values must use only deterministic expressions. Non-deterministic values (like `datetime('now')` or `random()`) must be passed via mutation context to ensure captured statements are replayable. See [Runtime Documentation](runtime.md#determinism-validation).

## Sequential ID Generation

Quereus has no built-in auto-increment or sequence objects. Instead, batch ID generation composes naturally from existing features: mutation context captures a non-deterministic seed once, a window function provides a deterministic per-row ordinal, and a scalar or table-valued function produces the final ID. For example, inserting with timestamp-derived IDs:

```sql
insert into orders (id, customer_id, total)
with context base_ts = epoch_ms('now')
select
    base_ts * 1000 + row_number() over (order by c.customer_id),
    c.customer_id,
    c.total
from (select customer_id, sum(price) as total from cart_items group by customer_id) c;
```

The `WITH CONTEXT` boundary captures `epoch_ms('now')` as a literal, and `row_number() over (order by ...)` assigns a deterministic ordinal over a declared ordering. The entire statement is replayable. For richer formats (ULIDs, UUIDv7), register a deterministic scalar UDF that encodes `(seed, counter)` into the desired format — or use a lateral join to a deterministic TVF when multiple columns are needed per generated row.

## Optimizer

Quereus features a sophisticated rule-based query optimizer that transforms logical plans into efficient physical execution plans. The optimizer uses a single plan node hierarchy with logical-to-physical transformation, generic tree rewriting infrastructure, and comprehensive optimization rules including constant folding, intelligent caching, streaming aggregation, bloom (hash) join selection for equi-joins, and correlated subquery decorrelation (EXISTS/IN → semi/anti joins).

See the [Optimizer Documentation](optimizer.md) for architecture details and [Optimizer Conventions](optimizer-conventions.md) for development guidelines.

### Recent refinements

- Retrieve growth and push-down stabilized: query-based modules slide full nodes via `supports()`; index-style fallback injects supported-only fragments inside `Retrieve`, preserving residuals above.
- Retrieve logical properties now expose `bindingsCount` and `bindingsNodeTypes` (visible in `query_plan().properties`) to aid verification that parameters/correlations are captured.

## Testing Strategy

The tests are located in `test/*.spec.ts` and are driven by Mocha with ts-node/esm.

```bash
yarn test
```

Quereus employs a multi-faceted testing strategy:

1.  **SQL Logic Tests (`test/logic/`)**
	*   Inspired by SQLite's own testing methodology.
	*   Uses simple text files (`*.sqllogic`) containing SQL statements and their expected JSON results (using `→` marker) or expected error messages (using `-- error:` directive).
	*   Driven by a Mocha test runner (`test/logic.spec.ts`) that executes the SQL against a fresh `Database` instance for each file.
	*   **Configurable Diagnostics** — on unexpected failures, the test runner provides clean error messages by default with optional detailed diagnostics controlled by command line arguments:
		*   `yarn test --verbose` — show execution progress during tests
		*   `yarn test --show-plan` — include concise query plan in diagnostics
		*   `yarn test --plan-full-detail` — include full detailed query plan (JSON format)
		*   `yarn test --plan-summary` — show one-line execution path summary
		*   `yarn test --expand-nodes node1,node2...` — expand specific nodes in concise plan
		*   `yarn test --max-plan-depth N` — limit plan display depth
		*   `yarn test --show-program` — include instruction program in diagnostics
		*   `yarn test --show-stack` — include full stack trace in diagnostics
		*   `yarn test --show-trace` — include execution trace in diagnostics
		*   `yarn test --trace-plan-stack` — enable plan stack tracing in runtime
	*   This helps pinpoint failures at the Parser, Planner, or Runtime layer while keeping output manageable.
	*   Provides comprehensive coverage of SQL features: basic CRUD, complex expressions, all join types, window functions, aggregates, subqueries, CTEs, constraints, transactions, set operations, views, and error handling.

2.  **Property-Based Tests (`test/property.spec.ts`)**
	*   Uses the `fast-check` library to generate a wide range of inputs for specific, tricky areas.
	*   Focuses on verifying fundamental properties and invariants that should hold true across many different values.
	*   Currently includes tests for:
		*   **Collation Consistency** — ensures `ORDER BY` results match the behavior of the `compareSqlValues` utility for `BINARY`, `NOCASE`, and `RTRIM` collations across various strings.
		*   **Numeric Affinity** — verifies that comparisons (`=`, `<`) in SQL handle mixed types (numbers, strings, booleans, nulls) consistently with SQLite's affinity rules, using `compareSqlValues` as the reference.
		*   **JSON Roundtrip** — confirms that arbitrary JSON values survive being processed by `json_quote()` and `json_extract('$')` without data loss or corruption.
		*   **Mixed Type Arithmetic** — checks that arithmetic on mixed types behaves consistently between SELECT and WHERE contexts.
		*   **Parser Robustness** — feeds random strings, SQL-like fragment mixtures, and random identifiers to the parser, asserting it either produces a valid AST or throws `QuereusError` — never unhandled exceptions.
		*   **Expression Evaluation** — compares random arithmetic expression trees and boolean comparisons evaluated in SQL against JS semantics.
		*   **Comparison Properties** — validates `compareSqlValues` maintains antisymmetry, reflexivity, and transitivity across mixed types.
		*   **Insert/Select Roundtrip** — tests value preservation through insert+select for INTEGER, REAL, TEXT, BLOB, and ANY column types.
		*   **ORDER BY Determinism** — verifies repeated ORDER BY queries on data with duplicate sort keys produce identical results.

3.  **Performance Sentinels (`test/performance-sentinels.spec.ts`)**
	*   Micro-benchmarks with generous thresholds to catch severe performance regressions.
	*   Currently includes sentinels for: parser throughput (simple, wide-SELECT, nested-expression), query execution (full table scan), and self-join (nested-loop baseline).
	*   Thresholds are intentionally generous to avoid flakiness while still catching order-of-magnitude regressions.

4.  **Unit Tests (`test/*.spec.ts`)**
	*   Dedicated unit tests for core subsystems: type system (`type-system.spec.ts`), schema manager (`schema-manager.spec.ts`), optimizer rules (`optimizer/*.spec.ts`), memory vtable (`memory-vtable.spec.ts`), utility functions (`utility-edge-cases.spec.ts`).
	*   Integration boundary tests (`integration-boundaries.spec.ts`) verify all boundary transitions: Parser→Planner, Planner→Optimizer, Optimizer→Runtime, Runtime→VTab.
	*   Golden plan tests (`plan/golden-plans.spec.ts`) use snapshot testing to detect unintended query plan changes.

5.  **Benchmark Suite (`bench/`)**
	*   Standalone benchmark harness run via `yarn bench`. Measures parser, planner, execution, and mutation throughput across 18 benchmarks.
	*   Records results to timestamped JSON files in `bench/results/` (gitignored).
	*   `yarn bench --baseline <file>` compares against a previous result, color-codes regressions (>20% red) and improvements (>10% green), and exits non-zero on regressions.

6.  **CI Integration (Planned)**
	*   Utilize GitHub Actions (or similar) to run test suites automatically, potentially with different configurations (quick checks, full runs, browser environment).

This layered approach aims for broad coverage via the logic tests, unit tests for individual subsystems, property tests to explore edge cases, performance sentinels to guard against regressions, and a dedicated benchmark suite for tracking performance over time.
