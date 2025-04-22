# SQLiter - A TypeScript SQL Query Processor

**(Work In Progress)**

SQLiter is a lightweight, TypeScript adaptation of the SQLite 3 query processor, specifically designed for efficient in-memory data processing with a strong emphasis on the **virtual table** interface. It aims to provide rich SQL query capabilities (joins, aggregates, window functions) primarily over data sources exposed via the virtual table mechanism, while intentionally de-emphasizing persistent file storage.

See [SQLite 3 Source](amalgamation/sqlite3.c) for reference.

## Project Goals

*   **Virtual Table Centric**: Provide a robust and flexible virtual table API as the primary means of interacting with data sources.
*   **In-Memory Focus**: Optimize for in-memory operations, removing the complexity of persistent storage, WAL, etc.
*   **TypeScript & Modern JS**: Leverage TypeScript's type system and modern JavaScript features and idioms.
*   **Async VTab Operations**: Assume virtual table data operations (reads/writes) can be long-running and asynchronous, designing the core engine accordingly.
*   **Cross-Platform**: Target diverse Javascript runtime environments, including Node.js, browser, and React Native.
*   **Minimal Dependencies**: Avoid heavy external dependencies where possible (currently includes `digitree`).
*   **SQL Compatibility**: Support a rich subset of SQL, particularly DML features useful for querying and manipulating data across virtual tables.

## Architecture Overview

SQLiter follows a classic query processing pipeline, adapted for its specific goals:

1.  **SQL Input**: The process starts with a SQL query string.
2.  **Parser (`src/parser`)**:
    *   **Lexer (`lexer.ts`)**: Tokenizes the raw SQL string into a stream of tokens (keywords, identifiers, literals, operators).
    *   **Parser (`parser.ts`)**: Consumes the token stream and builds an Abstract Syntax Tree (AST) representing the query's logical structure. AST definitions are in `ast.ts`.
3.  **Compiler (`src/compiler`)**:
    *   Traverses the AST.
    *   Resolves table and function references using the Schema Manager.
    *   Performs query planning via the virtual table `xBestIndex` method.
    *   Generates bytecode instructions for the Virtual Database Engine (VDBE).
4.  **VDBE - Virtual Database Engine (`src/vdbe`)**:
    *   A stack-based virtual machine that executes the compiled bytecode (`engine.ts`).
    *   Manages memory cells (registers) and interacts with cursors.
    *   Executes opcodes defined in `instruction.ts`, using compiled program metadata from `program.ts`.
    *   Invokes virtual table methods (`xFilter`, `xNext`, `xColumn`, `xUpdate`, etc.) via the module interface to interact with data.
    *   Calls User-Defined Functions (UDFs).
    *   Yields result rows back to the Statement object.
5.  **Virtual Tables (`src/vtab`)**:
    *   The core data interface. Modules implement the `VirtualTableModule` interface (`module.ts`), defining how to create, connect, query, and update table instances.
    *   `table.ts` and `cursor.ts` provide base classes for table and cursor instances.
    *   `indexInfo.ts` defines the structure used for query planning (`xBestIndex`).
    *   Includes a `MemoryTable` implementation (`memory-table.ts`) backed by the `digitree` B+Tree library.  This is also used for internal ephemeral purposes as well.  See [memory tables](doc/memory-table.md) for details.
6.  **Schema Management (`src/schema`)**:
    *   The `SchemaManager` (`manager.ts`) orchestrates access to different database schemas ('main', 'temp').
    *   Each `Schema` (`schema.ts`) holds definitions for tables (`table.ts`), columns (`column.ts`), and functions (`function.ts`).
    *   Supports programmatic schema definition, especially for virtual tables via `declareVtab`.
7.  **User-Defined Functions (`src/func`)**:
    *   Allows registering custom JavaScript functions to be called from SQL.
    *   The `FunctionContext` (`context.ts`) provides the API for functions to set results, access user data, and manage auxiliary data.
8.  **Core API (`src/core`)**:
    *   `Database (`database.ts`): The main entry point, managing connections, transactions, and module registration.
    *   `Statement (`statement.ts`): Represents a compiled SQL query, handling parameter binding, execution steps, and result retrieval.
9.  **Utilities (`src/util`)**:
    *   `comparison.ts`: Provides SQL value comparison logic (`compareSqlValues`).
    *   `latches.ts`: A simple async mutex for serializing operations.

## Source File Layout

The project is organized into the following main directories:

*   `src/common`: Foundational types, constants, and error classes used across the project.
*   `src/core`: High-level API classes (`Database`, `Statement`).
*   `src/parser`: SQL lexing, parsing, and AST definitions.
*   `src/compiler`: Translates AST to VDBE bytecode.
*   `src/vdbe`: The bytecode execution engine (Virtual Database Engine).
*   `src/schema`: Management of database schemas (tables, columns, functions).
*   `src/vtab`: Virtual table interface definitions and implementations (including `MemoryTable`).
*   `src/func`: User-defined function context and related components.
*   `src/util`: General utility functions (e.g., value comparison and latches).

## Key Design Decisions

*   **Federated**: The architecture prioritizes virtual tables as the primary data source and sink.
*   **Async Core**: Core operations like `Statement.step()` and VDBE execution involving VTab interactions are asynchronous (`async`/`await`) to handle potentially long-running I/O from virtual tables.
*   **Sync Callbacks**: VTab `xBestIndex` and `xColumn`, as well as UDFs, are expected to be synchronous for performance, following the SQLite C API design.
*   **JavaScript Types**: Uses standard JavaScript types (`number`, `string`, `bigint`, `boolean`, `Uint8Array`, `null`) internally.
*   **Handle-Based API**: Uses classes (`Database`, `Statement`) to represent resources with lifecycles.
*   **Transient Schema**: Schema information is primarily in-memory; persistence is not a goal. Programmatic definition is supported.
*   **SQL Subset**: Focuses on DML (SELECT, INSERT, UPDATE, DELETE) and features crucial for querying (joins, aggregates, etc.), omitting features tied to persistent storage (e.g., WAL, file formats, autoincrement intricacies).

## Variations from SQLite

* We support ASC/DESC on primary key column definitions

## Current Status

SQLiter is currently under active development. Core components like the parser, VDBE, virtual table interface, `MemoryTable` implementation, planning infrastructure (`xBestIndex`), and the core API are functional. SQL feature support (e.g., complex constraints, triggers, window functions, full sorting) and advanced query optimization are areas for future development.

**Supported Built-in Functions (Partial List):**

*   **Scalar:** `lower`, `upper`, `length`, `substr`/`substring`, `abs`, `round`, `coalesce`, `nullif`, `like`, `glob`
*   **Aggregate:** `count`, `sum`, `avg`, `min`, `max`, `group_concat`
*   **Date/Time:** `date`, `time`, `datetime`, `julianday`, `strftime`
    *   Date/Time functions support modifiers like `+X days`, `start of month`, `weekday N`, `localtime`, `utc`, `unixepoch`.

## Future Work

See the [TODO List](docs/todo.md) for a detailed breakdown of planned features and improvements.


