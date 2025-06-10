# Quereus - A TypeScript SQL Query Processor

<img src="docs/images/Quereus_colored_wide.svg" alt="Quereus Logo" height="150">

Quereus is a feature-complete SQL query processor, inspired by SQLite but specifically designed for efficient in-memory data processing with a strong emphasis on the **virtual table** interface. It provides rich SQL query and constraint capabilities (joins, aggregates, subqueries, CTEs, window functions, constraints) over data sources exposed via the virtual table mechanism. Quereus has no persistent file storage, though one could be built as a virtual table module.

## Project Goals

*   **Virtual Table Centric**: Provide a robust and flexible virtual table API as the primary means of interacting with data sources. All tables are virtual tables.
*   **In-Memory Focus**: Includes a comprehensive in-memory virtual table implementation (`MemoryTable`) with support for transactions and savepoints.
*   **TypeScript & Modern JS**: Leverage TypeScript's type system and modern JavaScript features and idioms.
*   **Async VTab Operations**: Virtual table data operations (reads/writes) are asynchronous. Cursors are implemented as async iterables.
*   **Cross-Platform**: Target diverse Javascript runtime environments, including Node.js, browser, and React Native.
*   **Minimal Dependencies**: Avoid heavy external dependencies where possible.
*   **SQL Compatibility**: Comprehensive support for modern SQL features including joins, window functions, subqueries, CTEs, constraints, views, and advanced DML/DDL operations.
*   **Key-Based Addressing**: All tables are addressed by their defined Primary Key. The concept of a separate, implicit `rowid` for addressing rows is not used (similar to SQLite's `WITHOUT ROWID` tables being the default and only mode).
*   **Third Manifesto Friendly**: Embraces some of the principles of the [Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf), such as allowing for empty keys. Utilizes algebraic planning.

## Architecture Overview

Quereus is built on a modern architecture based on partially immutable PlanNodes and an Instruction-based runtime with robust attribute-based context system.

1.  **SQL Input**: The process starts with a SQL query string.
2.  **Parser (`src/parser`)**:
    *   **Lexer (`lexer.ts`)**: Tokenizes the raw SQL string.
    *   **Parser (`parser.ts`)**: Builds an Abstract Syntax Tree (AST).
3.  **Planner (`src/planner`)**:
    *   Traverses the AST to construct a tree of immutable `PlanNode` objects representing the logical query structure.
    *   Handles Common Table Expressions (CTEs) and Subqueries by converting them into relational `PlanNode`s.
    *   Resolves table and function references using the Schema Manager.
    *   Performs query planning, incorporating virtual table `xBestIndex` method and table schema statistics.
    *   **Optimizer (`src/planner/optimizer`)**: Performs query optimization, including join reordering, predicate pushdown, and other optimizations.
4.  **Runtime (`src/runtime`)**:
    *   **Emitters (`src/runtime/emitters.ts`, `src/runtime/emit/`)**: Translate `PlanNode`s into a graph of `Instruction` objects.
    *   **Scheduler (`src/runtime/scheduler.ts`)**: Manages the execution flow of the `Instruction` graph.
    *   **Instructions**: JavaScript functions that operate on `RuntimeValue`s (which can be `SqlValue` or `AsyncIterable<Row>`). Async parameters are awaited.
    *   Invokes virtual table methods (e.g., `xQuery` which returns `AsyncIterable<Row>`, `xUpdate`) to interact with data.
    *   Calls User-Defined Functions (UDFs) and aggregate functions.
    *   Handles transaction and savepoint control.
5.  **Virtual Tables (`src/vtab`)**:
    *   The core data interface. Modules implement `VirtualTableModule`.
    *   `MemoryTable` (`vtab/memory/table.ts`) is a key implementation using `digitree`.
6.  **Schema Management (`src/schema`)**: Manages schemas, tables, columns, functions.
7.  **User-Defined Functions (`src/func`)**: Support for custom JS functions in SQL.
8.  **Core API (`src/core`)**: `Database`, `Statement` classes.

## Source File Layout

The project is organized into the following main directories:

*   `src/common`: Foundational types, constants, and error classes.
*   `src/core`: High-level API classes (`Database`, `Statement`).
*   `src/parser`: SQL lexing, parsing, and AST definitions.
*   `src/planner`: Building and optimizing `PlanNode` trees from AST.
*   `src/runtime`: Emission, scheduling, and execution of runtime `Instruction`s.
*   `src/schema`: Management of database schemas.
*   `src/vtab`: Virtual table interface and implementations (including `memory`).
*   `src/func`: User-defined functions.
*   `src/util`: General utility functions.
*   `docs`: Project documentation.

## Logging

Quereus uses the [`debug`](https://github.com/debug-js/debug) library for internal logging. This allows for fine-grained control over log output based on namespaces, which correspond to the different modules of the system (e.g., `planner`, `runtime`, `vtab:memory`).

To enable logging during development or troubleshooting, set the `DEBUG` environment variable. Examples:

```bash
# Enable all Quereus logs
DEBUG=quereus:*

# Enable all virtual table logs
DEBUG=quereus:vtab:*

# Enable VDBE runtime logs and any warnings/errors from other modules
DEBUG=quereus:runtime,quereus:*:warn,quereus:*:error

# Enable everything EXCEPT verbose runtime logs
DEBUG=*,-quereus:runtime
```

### Developer Usage

To add logging within a module:

1.  **Import the logger factory:**
    ```typescript
    import { createLogger } from '../common/logger.js'; // Adjust path as needed

    const log = createLogger('my-module:sub-feature');
    ```

2.  **Log messages:** Use the logger instance like `console.log`, utilizing format specifiers (`%s`, `%d`, `%j`, `%O`) for better performance and readability.
    ```typescript
    log('Processing item ID %d', itemId);
    log('Current state: %O', complexObject);
    ```

3.  **(Optional) Create specialized loggers for levels:** You can use `.extend()` for specific levels like warnings or errors, which allows finer control via the `DEBUG` variable.
    ```typescript
    const warnLog = log.extend('warn');
    const errorLog = log.extend('error');

    warnLog('Potential issue detected: %s', issueDescription);
    if (errorCondition) {
      errorLog('Operation failed: %O', errorObject);
      // It's often still good practice to throw an actual Error here
    }
    ```

## Documentation

* [Usage Guide](docs/usage.md): Detailed usage examples and API reference
* [SQL Reference Guide](docs/sql.md): Detailed SQL reference guide
* [Functions](docs/functions.md): Details on the built-in functions
* [Window Function Architecture](docs/window-functions.md): Details on the window function architecture and implementation.
* [Memory Tables](docs/memory-table.md): Implementation details of the built-in MemoryTable module
* [Date/Time Handling](docs/datetime.md): Details on date/time parsing, functions, and the Temporal API.
* [Runtime](docs/runtime.md): Details on the runtime and opcodes.
* [Error Handling](docs/error.md): Details on the error handling and status codes.
* [TODO List](docs/todo.md): Planned features and improvements

## Key Design Decisions

*   **Federated / VTab-Centric**: All tables are virtual tables.
*   **Async Core**: Core operations are asynchronous. Cursors are `AsyncIterable<Row>`.
*   **Key-Based Addressing**: Rows are identified by their defined Primary Key. No separate implicit `rowid`.
*   **JavaScript Types**: Uses standard JavaScript types (`number`, `string`, `bigint`, `boolean`, `Uint8Array`, `null`) internally.
*   **Object-Based API**: Uses classes (`Database`, `Statement`) to represent resources with lifecycles, rather than handles.
*   **Transient Schema**: Schema information is primarily in-memory; persistence is not a goal. Emission of schema SQL export is supported.
*   **Bags vs Sets Distinction**: Explicit type-level distinction between relations that guarantee unique rows (sets) and those that allow duplicates (bags), enabling sophisticated optimizations and maintaining algebraic correctness in line with Third Manifesto principles.
*   **Attribute-Based Context System**: Robust column reference resolution using stable attribute IDs eliminates architectural fragilities and provides deterministic context lookup across plan transformations.

## Major variations from SQLite

*   Uses `CREATE TABLE ... USING module(...)` syntax.
*   `PRAGMA default_vtab_module` can be used.
*   Supports `ASC`/`DESC` qualifiers on PRIMARY KEY column definitions.
*   Async core execution.
*   **No Rowids / `WITHOUT ROWID` by Default**: All tables are addressed by their Primary Key, similar to SQLite's `WITHOUT ROWID` tables being the only mode. The `WITHOUT ROWID` clause is not used.
*   **Implicit Primary Key Behavior**: When no explicit PRIMARY KEY is defined, Quereus includes all columns in the primary key. This differs from SQLite which uses the first INTEGER column or an implicit rowid. This design choice ensures predictable behavior and avoids potential confusion with SQLite's implicit rules.
*   No plans for:
    *   Triggers
    *   Persistent file storage (can be a VTab module)

## Current Status

Quereus is a feature-complete SQL query processor with a modern planner and instruction-based runtime architecture. The engine successfully handles complex SQL workloads including joins, window functions, subqueries, CTEs, constraints, and comprehensive DML/DDL operations.

**Current capabilities include:**
*   **Complete JOIN support** - INNER, LEFT, RIGHT, CROSS joins with proper NULL padding
*   **Advanced window functions** - Ranking, aggregates, and frame specifications
*   **Full constraint system** - NOT NULL, CHECK constraints with operation-specific triggers  
*   **Comprehensive subqueries** - Scalar, correlated, EXISTS, and IN subqueries
*   **Complete set operations** - UNION, INTERSECT, EXCEPT with proper deduplication
*   **Robust transaction support** - Multi-level savepoints and rollback
*   **Rich built-in function library** - Scalar, aggregate, window, JSON, and date/time functions

**Primary development focus:**
*   **Query optimization** - Cost-based planning, join reordering, and advanced statistics
*   **Performance enhancement** - Memory pooling, parallel execution, and streaming improvements
*   **Advanced features** - Foreign key constraints, materialized views, and performance tooling

See the [TODO List](docs/todo.md) for detailed development priorities.

## Testing

The tests are located in `test/*.spec.ts` and are driven by Mocha with ts-node/esm.

```bash
yarn test
```

Quereus employs a multi-faceted testing strategy:

1.  **SQL Logic Tests (`test/logic/`)**:
    *   Inspired by SQLite's own testing methodology.
    *   Uses simple text files (`*.sqllogic`) containing SQL statements and their expected JSON results (using `→` marker) or expected error messages (using `-- error:` directive).
    *   Driven by a Mocha test runner (`test/logic.spec.ts`) that executes the SQL against a fresh `Database` instance for each file.
    *   **Configurable Diagnostics**: On unexpected failures, the test runner provides clean error messages by default with optional detailed diagnostics controlled by environment variables:
        *   `QUEREUS_TEST_SHOW_PLAN=true` - Include query plan in diagnostics
        *   `QUEREUS_TEST_SHOW_PROGRAM=true` - Include instruction program in diagnostics
        *   `QUEREUS_TEST_SHOW_STACK=true` - Include full stack trace in diagnostics
        *   `QUEREUS_TEST_SHOW_TRACE=true` - Include execution trace in diagnostics
    *   This helps pinpoint failures at the Parser, Planner, or Runtime layer while keeping output manageable.
    *   Provides comprehensive coverage of SQL features: basic CRUD, complex expressions, all join types, window functions, aggregates, subqueries, CTEs, constraints, transactions, set operations, views, and error handling.

2.  **Property-Based Tests (`test/property.spec.ts`)**:
    *   Uses the `fast-check` library to generate a wide range of inputs for specific, tricky areas.
    *   Focuses on verifying fundamental properties and invariants that should hold true across many different values.
    *   Currently includes tests for:
        *   **Collation Consistency**: Ensures `ORDER BY` results match the behavior of the `compareSqlValues` utility for `BINARY`, `NOCASE`, and `RTRIM` collations across various strings.
        *   **Numeric Affinity**: Verifies that comparisons (`=`, `<`) in SQL handle mixed types (numbers, strings, booleans, nulls) consistently with SQLite's affinity rules, using `compareSqlValues` as the reference.
        *   **JSON Roundtrip**: Confirms that arbitrary JSON values survive being processed by `json_quote()` and `json_extract('$')` without data loss or corruption.

3.  **Performance Sentinels (Planned)**:
    *   Micro-benchmarks for specific scenarios (e.g., bulk inserts, complex queries) to catch performance regressions.

4.  **CI Integration (Planned)**:
    *   Utilize GitHub Actions (or similar) to run test suites automatically, potentially with different configurations (quick checks, full runs, browser environment).

This layered approach aims for broad coverage via the logic tests while using property tests to explore edge cases in specific subsystems more thoroughly.

## Supported Built-in Functions

*   **Scalar:** `lower`, `upper`, `length`, `substr`/`substring`, `abs`, `round`, `coalesce`, `nullif`, `like`, `glob`, `typeof`
*   **Aggregate:** `count`, `sum`, `avg`, `min`, `max`, `group_concat`, `json_group_array`, `json_group_object`
*   **Window Functions:** Complete implementation with `row_number`, `rank`, `dense_rank`, `ntile` (ranking); `count`, `sum`, `avg`, `min`, `max` with OVER clause (aggregates); Full frame specification support (`ROWS BETWEEN`, `UNBOUNDED PRECEDING/FOLLOWING`); `NULLS FIRST/LAST` ordering
*   **Date/Time:** `date`, `time`, `datetime`, `julianday`, `strftime` (supports common formats and modifiers)
*   **JSON:** `json_valid`, `json_type`, `json_extract`, `json_quote`, `json_array`, `json_object`, `json_insert`, `json_replace`, `json_set`, `json_remove`, `json_array_length`, `json_patch`
*   **Query Analysis:** `query_plan`, `scheduler_program`, `execution_trace` (debugging and performance analysis)


