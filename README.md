# SQLiter - A TypeScript SQL Query Processor

![SQLiter Logo](docs/cover-800.png)

**(Work In Progress)**

SQLiter is a lightweight, TypeScript adaptation of the SQLite 3 query processor, specifically designed for efficient in-memory data processing with a strong emphasis on the **virtual table** interface. It aims to provide rich SQL query capabilities (joins, aggregates, subqueries, CTEs) over data sources exposed via the virtual table mechanism.  SQLiter has no persistent file storage, though one could be built as an add-on module.

See [SQLite 3 Source](amalgamation/sqlite3.c) for reference.

## Project Goals

*   **Virtual Table Centric**: Provide a robust and flexible virtual table API as the primary means of interacting with data sources.
*   **In-Memory Focus**: Includes a comprehensive in-memory virtual table implementation (`MemoryTable`) with support for transactions and savepoints.
*   **TypeScript & Modern JS**: Leverage TypeScript's type system and modern JavaScript features and idioms.
*   **Async VTab Operations**: Assume virtual table data operations (reads/writes) can be long-running and asynchronous.
*   **Cross-Platform**: Target diverse Javascript runtime environments, including Node.js, browser, and React Native.
*   **Minimal Dependencies**: Avoid heavy external dependencies where possible.
*   **SQL Compatibility**: Support a rich subset of SQL, particularly DML (select, insert, update, delete) features useful for querying and manipulating data across virtual tables.

## Architecture Overview

SQLiter follows a classic query processing pipeline, adapted for its specific goals:

1.  **SQL Input**: The process starts with a SQL query string.
2.  **Parser (`src/parser`)**:
    *   **Lexer (`lexer.ts`)**: Tokenizes the raw SQL string into a stream of tokens (keywords, identifiers, literals, operators).
    *   **Parser (`parser.ts`)**: Consumes the token stream and builds an Abstract Syntax Tree (AST) representing the query's logical structure. AST definitions are in `ast.ts`.
3.  **Compiler (`src/compiler`)**:
    *   Traverses the AST.
    *   Handles Common Table Expressions (CTEs) (`cte.ts`) and Subqueries (`subquery.ts`).
    *   Resolves table and function references using the Schema Manager.
    *   Performs query planning via the virtual table `xBestIndex` method.
    *   Manages compilation context including stack frames for subroutines.
    *   Generates bytecode instructions for the Virtual Database Engine (VDBE).
4.  **VDBE - Virtual Database Engine (`src/vdbe`)**:
    *   A stack-based virtual machine that executes the compiled bytecode (`runtime.ts`).
    *   Manages memory cells (registers) using activation frames.
    *   Interacts with cursors for data access.
    *   Executes opcodes defined in `instruction.ts`, using compiled program metadata from `program.ts`.
    *   Invokes virtual table methods (`xFilter`, `xNext`, `xColumn`, `xUpdate`, etc.) via the module interface to interact with data.
    *   Calls User-Defined Functions (UDFs) and aggregate functions.
    *   Handles basic aggregation and transaction/savepoint control.
    *   Yields result rows back to the Statement object.
5.  **Virtual Tables (`src/vtab`)**:
    *   The core data interface. Modules implement the `VirtualTableModule` interface (`module.ts`), defining how to create, connect, query, and update table instances.
    *   `table.ts` and `cursor.ts` provide base classes for table and cursor instances.
    *   `indexInfo.ts` defines the structure used for query planning (`xBestIndex`).
    *   Includes `MemoryTable` (`memory-table.ts`) backed by `digitree`, `JsonEach` (`json-each.ts`), and `JsonTree` (`json-tree.ts`) implementations.
    *   The `MemoryTable` supports transactions and savepoints via internal buffering. See [Memory Tables](docs/memory-table.md) for details.
6.  **Schema Management (`src/schema`)**:
    *   The `SchemaManager` (`manager.ts`) orchestrates access to different database schemas ('main', 'temp').
    *   Each `Schema` (`schema.ts`) holds definitions for tables (`table.ts`), columns (`column.ts`), and functions (`function.ts`).
    *   Supports programmatic schema definition and JSON import/export (`json-schema.ts`).
    *   Reflection virtual table (`schema-table.ts`) provides a built-in `sqlite_schema` table for introspection.
7.  **User-Defined Functions (`src/func`)**:
    *   Allows registering custom JavaScript functions to be called from SQL (`registration.ts`).
    *   The `FunctionContext` (`context.ts`) provides the API for functions to set results, access user data, and manage auxiliary data.
    *   A suite of built-in scalar, aggregate, date/time, and JSON functions are provided (`builtins/`).
8.  **Core API (`src/core`)**:
    *   `Database` (`database.ts`): The main entry point, managing connections, transactions, and module registration.
    *   `Statement` (`statement.ts`): Represents a compiled SQL query, handling parameter binding, execution steps, and result retrieval.

## Source File Layout

The project is organized into the following main directories:

*   `src/common`: Foundational types, constants, and error classes used across the project.
*   `src/core`: High-level API classes (`Database`, `Statement`).
*   `src/parser`: SQL lexing, parsing, and AST definitions.
*   `src/compiler`: Translates AST to VDBE bytecode, including CTE and subquery handling.
*   `src/vdbe`: Runtime bytecode execution engine.
*   `src/schema`: Management of database schemas (tables, columns, functions).
*   `src/vtab`: Virtual table interface definitions
*   `src/vtab/*`: Vtab implementations including `memory`, `schema`, and `json`).
*   `src/func`: User-defined function context, registration helpers, and built-in functions.
*   `src/util`: General utility functions (e.g., value comparison, latches, DDL stringifier).
*   `docs`: Project documentation.

## Documentation

* [Usage Guide](docs/usage.md): Detailed usage examples and API reference
* [Functions](docs/functions.md): Details on the built-in functions
* [Memory Tables](docs/memory-table.md): Implementation details of the built-in MemoryTable module
* [Date/Time Handling](docs/datetime.md): Details on date/time parsing, functions, and the Temporal API.
* [Runtime](docs/runtime.md): Details on the VDBE runtime and opcodes.
* [Error Handling](docs/error.md): Details on the error handling and status codes.
* [TODO List](docs/todo.md): Planned features and improvements

## Key Design Decisions

*   **Federated / VTab-Centric**: The architecture prioritizes virtual tables as the primary data source and sink. 
    *   Tables can be created statically using `CREATE TABLE ... USING module(...)` syntax.
    *   Table-valued functions (like `json_each`, `json_tree`) can be invoked dynamically in the `FROM` clause using standard function call syntax: `SELECT ... FROM my_function(arg1, arg2) [AS alias] ...`.
    *   If `USING` is omitted in `CREATE TABLE`, it defaults to the configured default module (initially `memory` base on the `MemoryTable` module).
*   **Async Core**: Core operations like `Statement.step()` and VDBE execution involving VTab interactions are asynchronous (`async`/`await`) to handle potentially long-running I/O from virtual tables.
*   **Sync Callbacks**: VTab `xBestIndex` and `xColumn`, as well as UDFs, are expected to be synchronous for performance, following the SQLite C API design. `xCreate` and `xConnect` are also synchronous.
*   **JavaScript Types**: Uses standard JavaScript types (`number`, `string`, `bigint`, `boolean`, `Uint8Array`, `null`) internally.
*   **Object-Based API**: Uses classes (`Database`, `Statement`) to represent resources with lifecycles, rather than handles.
*   **Transient Schema**: Schema information is primarily in-memory; persistence is not a goal. Programmatic definition and JSON import/export are supported.

## Specific variations from SQLite

*   Uses `CREATE TABLE ... USING module(...)` syntax for static virtual tables. Supports dynamic invocation of table-valued functions (e.g., `json_each(...)`) in the `FROM` clause.
*   `PRAGMA default_vtab_module` can be used to set the default module for `CREATE TABLE` without `USING`.
*   Supports `ASC`/`DESC` qualifiers on PRIMARY KEY column definitions in `CREATE TABLE`.
*   Interface enhancements: `eval()` async enumerable helper on `Database`; easy to use parameters as names or indexed
*   Core VDBE execution stepping is asynchronous.
*   Built-in functions tailored for JS environments (e.g., extensive JSON support).
*   No plans for:
  *   Triggers - not well suited to federated environment
  *   Persistent file storage - this could always be developed as an add-in VT module

## Current Status

SQLiter is functional for a significant subset of SQL focused on querying and manipulating virtual tables. Key implemented features include:

*   Parsing and execution of `SELECT`, `INSERT`, `UPDATE`, `DELETE` statements.
*   Support for Common Table Expressions (CTEs), including basic recursive CTEs.
*   Support for various subquery types (scalar, comparison, `IN`, `EXISTS`), including correlated subqueries.
*   Joins (`INNER`, `LEFT`, `CROSS`).
*   Basic Aggregation (`GROUP BY`, `HAVING` with functions like `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `GROUP_CONCAT`, `JSON_GROUP_ARRAY`, `JSON_GROUP_OBJECT`).
*   Basic `ORDER BY` and `LIMIT`/`OFFSET` (with VDBE-level sorting via `MemoryTable` if needed).
*   Transactions (`BEGIN`, `COMMIT`, `ROLLBACK`) and Savepoints (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`).
*   Virtual Table implementations: `MemoryTable` (B+Tree based, supports transactions/savepoints and secondary indexes), `JsonEach`, `JsonTree`.
*   Extensive built-in functions: scalar (string, math), date/time, and JSON manipulation/querying.
*   `PRAGMA` support for setting default VTab module.
*   Basic `CREATE TABLE`/`DROP TABLE` for managing VTabs.
*   `CREATE INDEX`/`DROP INDEX` support for virtual tables that implement `xCreateIndex`/`xDropIndex` (like `MemoryTable`).
*   Schema export/import via JSON.
*   Basic read-only access to `sqlite_schema` for introspection.
*   Row-level `CHECK` constraints with `ON (INSERT|UPDATE|DELETE)` clause and support for `NEW`/`OLD` row aliases.

**Limitations & Missing Features:**

*   **Constraints**: `FOREIGN KEY` constraints are parsed but not enforced. `DEFAULT` values are used, but complex default expressions might have limitations. (`NOT NULL` and `CHECK` constraints *are* enforced).
*   **Advanced SQL**: Window functions, triggers, full `ALTER TABLE`, and views (parsing only) are not yet implemented.
*   **Index Features**: Indices on expressions are not supported. Collation support in indices is basic.
*   **Error Handling**: Error messages could be more detailed.
*   **Optimization**: Query planning (`xBestIndex`) is basic; VDBE opcode optimization is minimal.
*   **Testing**: While a comprehensive test framework is now in place (see below), more specific test cases are always needed.

## Testing

The tests are located in `test/*.spec.ts` and are driven by Mocha via aegir.

```bash
yarn test
```

SQLiter employs a multi-faceted testing strategy:

1.  **SQL Logic Tests (`test/logic/`)**:
    *   Inspired by SQLite's own testing methodology.
    *   Uses simple text files (`*.sqllogic`) containing SQL statements and their expected JSON results (using `→` marker) or expected error messages (using `-- error:` directive).
    *   Driven by a Mocha test runner (`test/logic.spec.ts`) that executes the SQL against a fresh `Database` instance for each file.
    *   **Diagnostics**: On unexpected failures, the test runner automatically dumps the parsed Abstract Syntax Tree (AST) and the compiled Virtual Database Engine (VDBE) bytecode, aiding in pinpointing the failure layer (Parser, Compiler, or Runtime).
    *   Covers core functionality: basic CRUD, expressions, joins, aggregates, subqueries, CTEs, transactions, VTab planning basics, built-ins, and common error paths.

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
*   **Date/Time:** `date`, `time`, `datetime`, `julianday`, `strftime` (supports common formats and modifiers)
*   **JSON:** `json_valid`, `json_type`, `json_extract`, `json_quote`, `json_array`, `json_object`, `json_insert`, `json_replace`, `json_set`, `json_remove`, `json_array_length`, `json_patch`

## Future Work

See the [TODO List](docs/todo.md) for a detailed breakdown.


