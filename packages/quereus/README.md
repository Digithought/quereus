# Quereus - A TypeScript SQL Query Processor

<img src="docs/images/Quereus_colored_wide.svg" alt="Quereus Logo" height="150">

Quereus is a feature-complete SQL query processor specifically designed for efficient in-memory data processing with a strong emphasis on the **virtual table** interface. It provides rich SQL query and constraint capabilities (joins, aggregates, subqueries, CTEs, window functions, constraints) over data sources exposed via the virtual table mechanism. Quereus features a modern type system with temporal types, JSON support, and plugin-extensible custom types. It has no persistent file storage, though one could be built as a virtual table module.

## Project Goals

*   **Virtual Table Centric**: Provide a robust and flexible virtual table API as the primary means of interacting with data sources. All tables are virtual tables.
*   **In-Memory Default**: Includes a comprehensive in-memory virtual table implementation (`MemoryTable`) with support for transactions and savepoints.
*   **Modern Type System**: Extensible logical/physical type separation with built-in temporal types (DATE, TIME, DATETIME), native JSON type with deep equality comparison, and plugin support for custom types. See [Type System Documentation](../docs/types.md).
*   **TypeScript & Modern JS**: Leverage TypeScript's type system and modern JavaScript features and idioms.
*   **Async VTab Operations**: Virtual table data operations (reads/writes) are asynchronous. Cursors are implemented as async iterables.
*   **Cross-Platform**: Target diverse Javascript runtime environments, including Node.js, browser, and React Native. Plugin loading (via `@quereus/plugin-loader`) uses dynamic `import()` and is not compatible with React Native; use static imports for RN.
*   **Minimal Dependencies**: Avoid heavy external dependencies where possible.
*   **SQL Compatibility**: Comprehensive support for modern SQL features including joins, window functions, subqueries, CTEs, constraints, views, and advanced DML/DDL operations.
*   **Key-Based Addressing**: All tables are addressed by their defined Primary Key. The concept of a separate, implicit `rowid` for addressing rows is not used.
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
    *   Performs query planning, incorporating virtual table `getBestAccessPlan` method and table schema statistics.
    *   **Optimizer (`src/planner/optimizer`)**: Transforms logical plans into efficient physical execution plans through a rule-based optimization system. See [Optimizer Documentation](../docs/optimizer.md) for details.
4.  **Runtime (`src/runtime`)**:
    *   **Emitters (`src/runtime/emitters.ts`, `src/runtime/emit/`)**: Translate `PlanNode`s into a graph of `Instruction` objects.
    *   **Scheduler (`src/runtime/scheduler.ts`)**: Manages the execution flow of the `Instruction` graph.
    *   **Instructions**: JavaScript functions that operate on `RuntimeValue`s (which can be `SqlValue` or `AsyncIterable<Row>`). Async parameters are awaited.
    *   Invokes virtual table methods (e.g., `query` which returns `AsyncIterable<Row>`, `update`) to interact with data.
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
*   `src/vtab`: Virtual table interface and build-ins (including `memory`).
*   `src/func`: User-defined functions.
*   `src/util`: General utility functions.
*   `docs`: Project documentation.

## Quick Start

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Create a table and insert data
await db.exec("create table users (id integer primary key, name text, email text)");
await db.exec("insert into users values (1, 'Alice', 'alice@example.com')");

// Query returns objects: { id: 1, name: 'Alice', email: 'alice@example.com' }
const user = await db.get("select * from users where id = ?", [1]);
console.log(user.name); // "Alice"

// Iterate over multiple rows
for await (const row of db.eval("select * from users")) {
  console.log(row.name);
}
```

### Reactive Patterns with Event Hooks

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Subscribe to data changes at the database level
db.onDataChange((event) => {
  console.log(`${event.type} on ${event.tableName} (module: ${event.moduleName})`);
  if (event.remote) {
    console.log('Change came from remote sync');
  }
  if (event.type === 'update') {
    console.log('Changed columns:', event.changedColumns);
  }
});

// Subscribe to schema changes
db.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
});

// Events fire after commit
await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
// Output: create table: users

await db.exec("INSERT INTO users VALUES (1, 'Alice')");
// Output: insert on users (module: memory)
```

The database-level event system aggregates events from all modules automatically. Events are batched within transactions and delivered only after successful commit.

SQL values use native JavaScript types (`string`, `number`, `bigint`, `Uint8Array`, `null`). Temporal types are ISO 8601 strings. Results stream as async iterators.

See the [Usage Guide](../docs/usage.md) for complete API reference and [Module Authoring Guide](../docs/module-authoring.md) for event system details.

## Platform Support & Storage

Quereus runs on any JavaScript runtime. For persistent storage, platform-specific plugins provide the `store` virtual table module:

### Node.js

Use [`@quereus/plugin-leveldb`](packages/quereus-plugin-leveldb/) for LevelDB-based persistent storage with full transaction isolation. Each table becomes a subdirectory under `basePath`:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, { basePath: './data' }); // ./data/users/, ./data/orders/, etc.

await db.exec(`create table users (id integer primary key, name text) using store`);

// Full transaction isolation enabled by default
await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
const user = await db.get('SELECT * FROM users WHERE id = 1'); // Sees uncommitted insert
await db.exec('COMMIT');
```

### Browser

Use [`@quereus/plugin-indexeddb`](packages/quereus-plugin-indexeddb/) for IndexedDB-based persistent storage with cross-tab sync and full transaction isolation. All tables share one IndexedDB database:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';

const db = new Database();
await registerPlugin(db, indexeddbPlugin, { databaseName: 'myapp' }); // IndexedDB database name

await db.exec(`create table users (id integer primary key, name text) using store`);
```

### React Native

Use [`@quereus/plugin-react-native-leveldb`](packages/quereus-plugin-react-native-leveldb/) for fast LevelDB storage with full transaction isolation. Each table becomes a separate LevelDB database with a name prefix:

```typescript
import { LevelDB, LevelDBWriteBatch } from 'react-native-leveldb';
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, {
  openFn: LevelDB.open,
  WriteBatch: LevelDBWriteBatch,
  databaseName: 'myapp'  // creates myapp_users, myapp_orders, etc.
});

await db.exec(`create table users (id integer primary key, name text) using store`);
```

**Note:** React Native requires runtime polyfills and static plugin loading. See the [plugin README](packages/quereus-plugin-react-native-leveldb/) for setup details.

**Required polyfills:**
- `structuredClone` (Quereus uses it internally)
- `TextEncoder` / `TextDecoder` (used by store plugins)
- `Symbol.asyncIterator` (required for async-iterable support; Quereus has a Hermes workaround for AsyncGenerator iterables, but the symbol must exist)

### NativeScript

Use [`@quereus/plugin-nativescript-sqlite`](packages/quereus-plugin-nativescript-sqlite/) for SQLite-based storage with full transaction isolation. All tables share one SQLite database file:

```typescript
import { openOrCreate } from '@nativescript-community/sqlite';
import { Database, registerPlugin } from '@quereus/quereus';
import sqlitePlugin from '@quereus/plugin-nativescript-sqlite/plugin';

const sqliteDb = openOrCreate('myapp.db');  // SQLite database file
const db = new Database();
await registerPlugin(db, sqlitePlugin, { db: sqliteDb });

await db.exec(`create table users (id integer primary key, name text) using store`);
```

See [Store Documentation](../docs/store.md) for the storage architecture and custom backend implementation.

## Documentation

* [Usage Guide](/docs/usage.md): Complete API reference including:
  - Type mappings (SQL ↔ JavaScript)
  - Parameter binding and prepared statements
  - Logging via `debug` library with namespace control
  - Instruction tracing for performance analysis
  - Transaction and savepoint management
* [SQL Reference Guide](../docs/sql.md): SQL syntax (includes Declarative Schema)
* [Schema Management](../docs/schema.md): SchemaManager API, change events, key types
* [Type System](../docs/types.md): Logical/physical types, temporal types, JSON, custom types
* [Functions](../docs/functions.md): Built-in scalar, aggregate, window, and JSON functions
* [Memory Tables](/docs/memory-table.md): Built-in MemoryTable module
* [Module Authoring](../docs/module-authoring.md): Virtual table module development and event system
* [Date/Time Handling](../docs/datetime.md): Temporal parsing, functions, and ISO 8601 formats
* [Runtime](../docs/runtime.md): Instruction-based execution and opcodes
* [Error Handling](../docs/error.md): Error types and status codes
* [Plugin System](../docs/plugins.md): Virtual tables, functions, and collations
* [TODO List](../docs/todo.md): Planned features

### Plugin Development

Quereus exports all critical utilities needed for plugin and module development:

* **Comparison Functions**: `compareSqlValues`, `compareRows`, `compareTypedValues`, `createTypedComparator` — Match Quereus SQL semantics in custom implementations
* **Coercion Utilities**: `tryCoerceToNumber`, `coerceForComparison`, `coerceForAggregate` — Handle type coercion correctly
* **Collation Support**: `registerCollation`, `getCollation`, built-in collations (`BINARY_COLLATION`, `NOCASE_COLLATION`, `RTRIM_COLLATION`)
* **Type System**: Full access to logical types, validation, and parsing utilities
* **Event Hooks**: `VTableEventEmitter` interface for mutation and schema change events — Enable reactive patterns, caching, and replication

See the [Plugin System documentation](../docs/plugins.md#comparison-and-coercion-utilities) for complete API reference and examples.

## Key Design Decisions

*   **Federated / VTab-Centric**: All tables are virtual tables.
*   **Async Core**: Core operations are asynchronous. Cursors are `AsyncIterable<Row>`.
*   **Key-Based Addressing**: Rows are identified by their defined Primary Key. No separate implicit `rowid`.
*   **Relational Orthogonality**: Any statement that results in a relation can be used anywhere that expects a relation value, including mutating statements with RETURNING clauses.
*   **Declarative Schema (Optional)**: Keep using DDL normally. Optionally use order‑independent `declare schema { ... }` to describe end‑state; the engine computes diffs against current state using module‑reported catalogs and emits canonical DDL. You may auto‑apply via `apply schema` or fetch the DDL and run it yourself (enabling custom backfills). Supports seeds, imports (URL + cache), versioning, and schema hashing. Destructive changes require explicit acknowledgement.
*   **JavaScript Types**: Uses standard JavaScript types (`number`, `string`, `bigint`, `boolean`, `Uint8Array`, `null`) internally.
*   **Object-Based API**: Uses classes (`Database`, `Statement`) to represent resources with lifecycles, rather than handles.
*   **Transient Schema**: Schema information is primarily in-memory; persistence is not a goal. Emission of schema SQL export is supported.
*   **Multi-Schema Support**: Organize tables across multiple schemas with flexible search paths for modular designs.
*   **Bags vs Sets Distinction**: Explicit type-level distinction between relations that guarantee unique rows (sets) and those that allow duplicates (bags), enabling sophisticated optimizations and maintaining algebraic correctness in line with Third Manifesto principles.
*   **Attribute-Based Context System**: Robust column reference resolution using stable attribute IDs eliminates architectural fragilities and provides deterministic context lookup across plan transformations.

## Key Design Differences

While Quereus supports standard SQL syntax, it has several distinctive design choices:

*   **Modern Type System**: Uses logical/physical type separation instead of SQLite's type affinity model. Includes native temporal types (DATE, TIME, DATETIME) and JSON type with deep equality comparison. Conversion functions (`integer()`, `date()`, `json()`) are preferred over CAST syntax. See [Type System Documentation](../docs/types.md).
*   **Virtual Table Centric**: Uses `CREATE TABLE ... USING module(...)` syntax. All tables are virtual tables.
*   **Default NOT NULL Columns**: Following Third Manifesto principles, columns default to NOT NULL unless explicitly specified otherwise. This behavior can be controlled via `pragma default_column_nullability = 'nullable'` to restore SQL standard behavior.
*   **No Rowids**: All tables are addressed by their Primary Key. When no explicit PRIMARY KEY is defined, Quereus includes all columns in the primary key.
*   **Async API**: Core execution is asynchronous with async/await patterns throughout.
*   **No Triggers or Built-in Persistence**: Persistent storage can be implemented as a VTab module.

### Row-Level Constraints

- Row-level CHECKs that reference only the current row are enforced immediately.
- Row-level CHECKs that reference other tables (e.g., via subqueries) are automatically deferred and enforced at COMMIT using the same optimized engine as global assertions. No `DEFERRABLE` or `SET CONSTRAINTS` management is required by the user.
- **Determinism Enforcement**: CHECK constraints and DEFAULT values must use only deterministic expressions. Non-deterministic values (like `datetime('now')` or `random()`) must be passed via mutation context to ensure captured statements are replayable. See [Runtime Documentation](../docs/runtime.md#determinism-validation).

### Sequential ID Generation

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

## Current Status

Quereus is a feature-complete SQL query processor with a modern planner and instruction-based runtime architecture. The engine successfully handles complex SQL workloads including joins, window functions, subqueries, CTEs, constraints, and comprehensive DML/DDL operations.

**Current capabilities include:**
*   **Modern Type System** - Temporal types (DATE, TIME, DATETIME), JSON with deep equality, plugin-extensible custom types
*   **Complete JOIN support** - INNER, LEFT, RIGHT, CROSS joins with proper NULL padding
*   **Advanced window functions** - Ranking, aggregates, and frame specifications
*   **Full constraint system** - NOT NULL, CHECK constraints with operation-specific triggers
*   **Comprehensive subqueries** - Scalar, correlated, EXISTS, and IN subqueries
*   **Relational orthogonality** - INSERT/UPDATE/DELETE with RETURNING can be used as table sources
*   **Complete set operations** - UNION, INTERSECT, EXCEPT with proper deduplication
*   **DIFF (symmetric difference)** - `A diff B` equals `(A except B) union (B except A)`, handy for table equality checks via `not exists(A diff B)`
*   **Robust transaction support** - Multi-level savepoints and rollback
*   **Rich built-in function library** - Scalar, aggregate, window, JSON, and date/time functions

**Optimizer Status:**

Quereus features a sophisticated rule-based query optimizer that transforms logical plans into efficient physical execution plans. The optimizer uses a single plan node hierarchy with logical-to-physical transformation, generic tree rewriting infrastructure, and comprehensive optimization rules including constant folding, intelligent caching, and streaming aggregation.

See the [Optimizer Documentation](../docs/optimizer.md) for architecture details and [Optimizer Conventions](../docs/optimizer-conventions.md) for development guidelines.
[TODO List](../docs/todo.md) has remaining priorities.

Recent changes:
- Retrieve growth and push-down stabilized: query-based modules slide full nodes via `supports()`; index-style fallback injects supported-only fragments inside `Retrieve`, preserving residuals above.
- Retrieve logical properties now expose `bindingsCount` and `bindingsNodeTypes` (visible in `query_plan().properties`) to aid verification that parameters/correlations are captured.

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
    *   **Configurable Diagnostics**: On unexpected failures, the test runner provides clean error messages by default with optional detailed diagnostics controlled by command line arguments:
        *   `yarn test --verbose` - Show execution progress during tests
        *   `yarn test --show-plan` - Include concise query plan in diagnostics
        *   `yarn test --plan-full-detail` - Include full detailed query plan (JSON format)
        *   `yarn test --plan-summary` - Show one-line execution path summary
        *   `yarn test --expand-nodes node1,node2...` - Expand specific nodes in concise plan
        *   `yarn test --max-plan-depth N` - Limit plan display depth
        *   `yarn test --show-program` - Include instruction program in diagnostics
        *   `yarn test --show-stack` - Include full stack trace in diagnostics
        *   `yarn test --show-trace` - Include execution trace in diagnostics
        *   `yarn test --trace-plan-stack` - Enable plan stack tracing in runtime
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
*   **Date/Time:** `date`, `time`, `datetime`, `julianday`, `strftime` (supports common formats and modifiers), `epoch_s`, `epoch_ms`, `epoch_s_frac` (Unix epoch conversions with strict parsing)
*   **JSON:** `json_valid`, `json_schema`, `json_type`, `json_extract`, `json_quote`, `json_array`, `json_object`, `json_insert`, `json_replace`, `json_set`, `json_remove`, `json_array_length`, `json_patch`
*   **Query Analysis:** `query_plan`, `scheduler_program`, `execution_trace` (debugging and performance analysis)


