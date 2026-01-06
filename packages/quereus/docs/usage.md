# Quereus Usage Guide

Quereus provides a lightweight, TypeScript-native SQL interface with a focus on virtual tables that can be backed by any data source. This document explains how to use Quereus effectively in your applications.

## Quick Start

Quereus uses native JavaScript types for SQL values. Query results are returned as objects with column names as keys:

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Create a table and insert data
await db.exec("create table users (id integer primary key, name text, email text)");
await db.exec("insert into users values (1, 'Alice', 'alice@example.com')");

// Query returns objects: { id: 1, name: 'Alice', email: 'alice@example.com' }
const user = await db.prepare("select * from users where id = ?").get([1]);
console.log(user.name); // "Alice"

// Iterate over multiple rows
for await (const user of db.eval("select * from users")) {
  console.log(user.name); // Each row is an object
}
```

**Key Points:**
- SQL values use JavaScript types: `string`, `number`, `bigint`, `boolean`, `Uint8Array`, `null`
- Temporal types (DATE, TIME, DATETIME) store values as ISO 8601 strings
- JSON type stores validated JSON strings with deep equality comparison
- BLOBs are `Uint8Array` typed arrays
- Results stream as async iterators - use `for await` to process rows

See [Type System Documentation](types.md) for complete details on types, validation, and conversion functions.

## Basic Usage

### Creating a Database

```typescript
import { Database } from '@quereus/quereus';
// Make sure to import other necessary types if using them directly
// import { type SqlValue, QuereusError, MisuseError } from '@quereus/quereus';

// Create an in-memory database
const db = new Database();
```

### Executing Simple Statements (`db.exec`)

Use `db.exec(sql)` for executing statements without fetching results, especially for DDL (`create`, `drop`), transaction control (`begin`, `commit`), or simple `insert`/`update`/`delete` statements with or without parameters.

```typescript
// Execute DDL
await db.exec("create table users (id integer primary key, name text, email text)");
await db.exec("create index idx_users_email on users(email)");

// Simple INSERT
await db.exec("insert into users (name, email) values (?, ?)", ["User A", "example@sample.com"]);

// Transaction control
await db.exec("begin");
// ... operations ...
await db.exec("commit");
```

### Inserting Data (Recommended: Prepared Statements)

For inserting data, especially multiple rows or with parameters, using prepared statements is safer and often more efficient.

```typescript
// Insert multiple rows with a prepared statement
const stmt = await db.prepare("insert into users (name, email) values (?, ?)");
try {
  await stmt.run(["Alice Smith", "alice@example.com"]);
  await stmt.run(["Bob Johnson", "bob@example.com"]);
} finally {
  await stmt.finalize(); // Always finalize when done
}
```

### Querying Data

Quereus provides several ways to query data, depending on your needs.

#### Iterating Over Results (`db.eval`)

The most idiomatic way to process multiple result rows is using `db.eval`, which returns an async iterator. It automatically handles statement preparation, parameter binding, and finalization.

```typescript
try {
  // Using positional parameters
  for await (const user of db.eval("select name, email from users where status = ? order by name", ["active"])) {
    console.log(`Active user: ${user.name} (${user.email})`);
    // row is Record<string, SqlValue>
  }

  // Using named parameters
  for await (const project of db.eval("select * from projects where owner = :owner and deadline < :date", 
                                    { ":owner": "Alice Smith", ":date": Date.now() })) {
    console.log(`Project: ${project.name}`);
  }

  // No parameters
  for await (const item of db.eval("select * from inventory")) {
     // ...
  }
} catch (e) {
  console.error("Query failed:", e);
  // Handle errors (e.g., QuereusError, MisuseError)
}
```

#### Fetching a Single Row (`stmt.get`)

If you expect only one row (or just need the first one), prepare the statement and use `stmt.get()`.

```typescript
const stmt = await db.prepare("select * from users where id = ?");
try {
  const user = await stmt.get([1]); // Get first row only (or undefined if none)
  if (user) {
    console.log(user.name); // "John Doe"
  }
} finally {
  await stmt.finalize();
}

// Using named parameters
const stmt2 = await db.prepare("select * from users where email = :email");
try {
  const byEmail = await stmt2.get({ ":email": "alice@example.com" });
  // ...
} finally {
  await stmt2.finalize();
}
```

#### Streaming All Rows (`stmt.all`)

The `stmt.all()` method returns an async iterator for streaming results:

```typescript
const stmt = await db.prepare("select * from users where role = ?");
try {
  // Stream rows with for-await
  for await (const admin of stmt.all(["admin"])) {
    console.log(admin.name);
  }
} finally {
  await stmt.finalize();
}
```

To collect all rows into an array, use spread or `Array.fromAsync`:

```typescript
const stmt = await db.prepare("select * from users where role = ?");
try {
  const admins = [];
  for await (const row of stmt.all(["admin"])) {
    admins.push(row);
  }
  console.log(`Found ${admins.length} admins`);
} finally {
  await stmt.finalize();
}
```

### Transactions

```typescript
// Simple transaction
await db.exec("begin transaction");
try {
  await db.exec("insert into users (name) values (?)", ["User 1"]);
  await db.exec("insert into users (name) values (?)", ["User 2"]);
  await db.exec("commit");
} catch (e) {
  await db.exec("rollback");
  throw e;
}

// Transaction with savepoints
await db.exec("begin transaction");
try {
  await db.exec("insert into users (name) values (?)", ["User 3"]);
  
  await db.exec("savepoint save1");
  try {
    await db.exec("insert into users (name) values (?)", ["User 4"]);
    // Some condition to decide whether to keep these changes
    if (shouldRollback) {
      await db.exec("rollback to save1");
    } else {
      await db.exec("release save1");
    }
  } catch (e) {
    await db.exec("rollback to save1");
    // Continue with the outer transaction
  }
  
  await db.exec("commit");
} catch (e) {
  await db.exec("rollback");
  throw e;
}
```

## Database API Reference

### `db.exec(sql: string, params?: SqlParameters): Promise<void>`
Executes one or more SQL statements separated by semicolons. Primarily intended for DDL, transaction control, or DML without results. Supports optional parameters.

### `db.prepare(sql: string): Statement`
Prepares an SQL statement for execution, returning a `Statement` object. This is the entry point for using the `Statement` API (`run`, `get`, `all`, `bind`, etc.).

### `db.get(sql: string, params?: SqlParameters): Promise<Record<string, SqlValue> | undefined>`
Convenience method to execute a query and return the first result row, or undefined if no rows. Equivalent to `db.prepare(sql).get(params)`.

```typescript
const user = await db.get("select * from users where id = ?", [1]);
```

### `db.eval(sql: string, params?: SqlParameters): AsyncIterable<Record<string, SqlValue>>`
A high-level async generator for executing a query and iterating over its results. Handles statement preparation, parameter binding, and automatic finalization.

### `db.beginTransaction()`, `db.commit()`, `db.rollback()`
Standard transaction control methods.

### `db.registerModule(...)`, `db.createScalarFunction(...)`, `db.createAggregateFunction(...)`, `db.registerCollation(...)`
Methods for extending database functionality.

### `db.setInstructionTracer(tracer: InstructionTracer | null)`
Sets an instruction tracer for debugging and performance analysis. The tracer will be used for all statement executions on this database instance.

### `db.close()`
Closes the database connection and finalizes all open statements.

## Statement API Reference

Prepared statements provide methods for executing parameterized SQL.

#### `stmt.run(params?: SqlValue[] | Record<string, SqlValue>): Promise<void>`

Executes the statement until completion, ignoring any result rows. Ideal for INSERT, UPDATE, or DELETE operations.

```typescript
await stmt.run(["param1", 42]); // Positional parameters
await stmt.run({ ":name": "Alice", ":age": 30 }); // Named parameters
```

#### `stmt.get(params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue> | undefined>`

Executes the statement and returns the first result row as an object, or undefined if no rows are returned.

```typescript
const user = await stmt.get([1]); // e.g., "select * from users where id = ?"
if (user) {
  console.log(user.name, user.email);
}
```

#### `stmt.all(params?: SqlValue[] | Record<string, SqlValue>): AsyncIterable<Record<string, SqlValue>>`

Returns an async iterator over all result rows. Use `for await` to stream results:

```typescript
for await (const user of stmt.all([30])) {
  console.log(user.name);
}
```

#### `stmt.bind(key: number | string, value: SqlValue): stmt`

Binds a single parameter by position (1-based) or name. Returns the statement for chaining.

```typescript
stmt.bind(1, "value"); // Bind first parameter
stmt.bind(":name", "John"); // Bind named parameter
```

#### `stmt.bindAll(params: SqlValue[] | Record<string, SqlValue>): stmt`

Binds multiple parameters at once. Returns the statement for chaining.

```typescript
stmt.bindAll([1, "text", null]); // Positional
stmt.bindAll({ ":id": 1, ":name": "John" }); // Named
```

#### `stmt.reset(): Promise<void>`

Resets the statement to its initial state, ready to be re-executed with new parameters.

#### `stmt.finalize(): Promise<void>`

Releases all resources associated with the statement. The statement cannot be used after finalizing.

## Virtual Tables

One of Quereus's key features is its support for virtual tables, which allow you to expose any data source as a SQL table.

### Creating virtual tables

The explicit way to create a virtual table is using the `create table ... using module_name(...)` syntax. The arguments passed to the module name are specific to that module.

```typescript
// Register a virtual table module (e.g., a module for reading JSON)
db.registerModule('json_data', new JsonTableModule());

// Create a virtual table using the module with specific arguments
await db.exec(\`
  create table products using json_data(
    '{"data": [{"id": 1, "name": "Product A"}, {"id": 2, "name": "Product B"}]}'
  )
\`);

// Query it like a regular table
const products = await db.prepare("select * from products where id > ?").all([1]);
```

### Using `create table` with a Default Module

Alternatively, you can define a *default* virtual table module for the database connection using `pragma`. Any `create table` statement without the `using` clause will implicitly use this default module. This can be useful if you primarily interact with one type of virtual table or want a specific behavior for standard table creation.

```typescript
// Example: Setting the built-in 'memory' module as the default
// The 'memory' module creates an in-memory table based on the schema
// (Requires the MemoryTableModule to be registered)
await db.exec("pragma default_vtab_module = 'memory'");

// Optional: Set default arguments for the module (if it accepts/requires them)
// The format is typically a JSON array string.
// For the 'memory' module, it currently doesn't use constructor args in this way,
// but other modules might. E.g., pragma default_vtab_args = '["arg1", {"key": "value"}]';
await db.exec("pragma default_vtab_args = '[]'"); // Set empty args for 'memory'

// Now, a standard CREATE TABLE implicitly uses the 'memory' module
await db.exec("create table my_memory_table (col_a integer, col_b text)");

// Query the implicitly created virtual table
const results = await db.prepare("select * from my_memory_table").all();

// To clear the default module:
// await db.exec("pragma default_vtab_module = null");
// await db.exec("pragma default_vtab_args = null");
```

**Note:** When using a default module with `create table`, the module's `create` function receives the table definition (columns, constraints) parsed from the `create table` statement itself, rather than relying solely on arguments passed via `using (...)` or `pragma default_vtab_args`. The `memory` module is designed to work this way.

See the [Memory Table documentation](./memory-table.md) for more details on the built-in memory table implementation.

## Declarative Schema Workflow

Quereus supports an order‑independent declarative schema with a separate apply step. DDL remains primary; declarative is an optional layer that produces canonical DDL. Modules continue to use the DDL interface.

### Quick Start

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Optional: set default module (so `using ...` can be omitted)
await db.exec("pragma default_vtab_module = 'memory'");

// 1) Declare target schema
await db.exec(`
  declare schema main version '1.0.0' {
    table users {
      id integer primary key,
      email text not null unique,
      name text not null
    }

    table roles {
      id integer primary key,
      name text not null unique
    }

    table user_roles (
      user_id integer not null,
      role_id integer not null,
      constraint pk_user_roles primary key (user_id, role_id),
      constraint fk_user foreign key (user_id) references users(id),
      constraint fk_role foreign key (role_id) references roles(id)
    );

    index users_email on users(email);

    seed roles (
      (1, 'admin'),
      (2, 'viewer')
    )
  }
`);

// 2) Get migration DDL statements
const ddlStatements = [];
for await (const row of db.eval('diff schema main')) {
  ddlStatements.push(row.ddl);
}
console.log('Migration DDL:', ddlStatements);

// 3) Option A: Execute DDL manually with custom logic
for (const ddl of ddlStatements) {
  console.log('Executing:', ddl);
  await db.exec(ddl);
  // Insert custom migration logic here (backfills, data transforms, etc.)
}

// 3) Option B: Auto-apply (convenience)
await db.exec('apply schema main');

// 4) Apply with seed data (clears and repopulates)
await db.exec('apply schema main with seed');

// 5) Verify schema hash
const hashResult = await db.prepare('explain schema main').get();
console.log(hashResult.info); // e.g., "hash:a1b2c3d4e5f6"

// 6) Use the schema
await db.exec("insert into users (id, email, name) values (1, 'alice@example.com', 'Alice')");
const users = await db.prepare('select * from users').all();
console.log(users);
```

### Working with Declarative Schemas

**Declaring Schemas:**
- Use `{...}` braces or `(...)` parentheses for table column definitions.
- All declarations are stored but have no side effects until `apply`.
- Tables, indexes, and views can be declared in any order.

**Viewing Changes:**
- `diff schema` returns a JSON object showing all required changes.
- Review the diff before applying to understand impact.

**Applying Migrations:**
- `apply schema main` executes the migration DDL automatically.
- `apply schema main with seed` also clears tables and inserts seed data.
- Migrations execute in safe order: drops, creates, then alters.

**Seed Data:**
- Seed blocks define initial data for tables.
- Application clears existing data before inserting seeds.
- Use for test fixtures, reference data, or initial configurations.


## User-Defined Functions

Quereus allows you to define custom SQL functions:

```typescript
// Register a scalar function
db.createScalarFunction("reverse", { numArgs: 1, deterministic: true }, 
  (text) => {
    if (typeof text !== 'string') return text;
    return text.split('').reverse().join('');
  }
);

// Use it in SQL
const result = await db.prepare("select reverse(name) from users").all();
```

## Error Handling

Quereus throws specific error types that you can catch and handle:

```typescript
try {
  await db.exec("insert into nonexistent_table values (1)");
} catch (err) {
  if (err instanceof QuereusError) {
    console.error(`Quereus error (code ${err.code}): ${err.message}`);
  } else if (err instanceof MisuseError) {
    console.error(`API misuse: ${err.message}`);
  } else {
    console.error(`Unknown error: ${err}`);
  }
}
```

## Direct Parser and Emitter Access

For advanced use cases like building SQL tools, IDE integrations, query analysis, or programmatic SQL manipulation, Quereus exposes its SQL parser and emitter as separate subpath exports.

### Parser (`@quereus/quereus/parser`)

Parse SQL statements into Abstract Syntax Tree (AST) nodes:

```typescript
import { parse, parseAll, parseSelect, Parser } from '@quereus/quereus/parser';
import type { Statement, SelectStmt, Expression, CreateTableStmt } from '@quereus/quereus/parser';

// Parse a single statement
const stmt = parse('select * from users where id = ?');
console.log(stmt.type); // 'select'

// Parse multiple statements separated by semicolons
const stmts = parseAll('select 1; select 2;');
console.log(stmts.length); // 2

// Parse specifically as SELECT (throws if not a SELECT)
const selectAst = parseSelect('select name, email from users');

// Access the Parser class directly for more control
const parser = new Parser();
const ast = parser.parse('insert into users (name) values (?)');
```

**Available Exports:**
- `parse(sql)` - Parse a single SQL statement, returns `Statement`
- `parseAll(sql)` - Parse multiple semicolon-separated statements, returns `Statement[]`
- `parseSelect(sql)` - Parse as SELECT statement, throws if not SELECT
- `parseInsert(sql)` - Parse as INSERT statement, throws if not INSERT
- `Parser` - The parser class for direct access
- `Lexer`, `TokenType`, `KEYWORDS` - Lexer internals for tokenization
- All AST type definitions (`Statement`, `SelectStmt`, `Expression`, etc.)

### Emitter (`@quereus/quereus/emit`)

Convert AST nodes back into SQL strings:

```typescript
import {
  astToString,
  quoteIdentifier,
  selectToString,
  insertToString,
  createTableToString
} from '@quereus/quereus/emit';
import { parse } from '@quereus/quereus/parser';

// Convert any statement AST to SQL
const ast = parse('select * from users');
const sql = astToString(ast);
console.log(sql); // 'select * from "users"'

// Quote identifiers safely (adds quotes when needed)
const safeName = quoteIdentifier('my-table');  // '"my-table"'
const simpleName = quoteIdentifier('users');   // 'users' (no quotes needed)

// Statement-specific emitters
const selectSql = selectToString(selectAst);
const insertSql = insertToString(insertAst);
const createSql = createTableToString(createTableAst);
```

**Available Exports:**
- `astToString(ast)` - Convert any statement AST to SQL string
- `quoteIdentifier(name)` - Safely quote an identifier if needed
- `expressionToString(expr)` - Convert an expression AST to SQL
- `selectToString`, `insertToString`, `updateToString`, `deleteToString`, `valuesToString` - DML emitters
- `createTableToString`, `createIndexToString`, `createViewToString` - DDL emitters

### Use Cases

**Query Analysis:**
```typescript
import { parse } from '@quereus/quereus/parser';

const ast = parse('select name from users where active = true');
// Inspect tables referenced
console.log(ast.from[0].name); // 'users'
// Inspect columns selected
console.log(ast.columns[0].expr.name); // 'name'
```

**Query Rewriting:**
```typescript
import { parse } from '@quereus/quereus/parser';
import { astToString } from '@quereus/quereus/emit';

const ast = parse('select * from users');
// Add a WHERE clause programmatically
ast.where = { type: 'binary', operator: '=', left: {...}, right: {...} };
const modifiedSql = astToString(ast);
```

**SQL Formatting/Normalization:**
```typescript
import { parse } from '@quereus/quereus/parser';
import { astToString } from '@quereus/quereus/emit';

// Parse and re-emit to normalize formatting
const normalized = astToString(parse('SELECT   *   FROM   users'));
console.log(normalized); // 'select * from "users"'
```

## Type System Reference

This section provides comprehensive details on how Quereus represents SQL values in JavaScript/TypeScript.

### Core Type Definitions

```typescript
// All SQL values are represented by this union type
type SqlValue = string | number | bigint | boolean | Uint8Array | null;

// Rows are arrays of values
type Row = SqlValue[];

// Parameters can be positional (array) or named (object)
type SqlParameters = Record<string, SqlValue> | SqlValue[];
```

### SQL to JavaScript Type Mapping

| SQL Type | JavaScript Type | Notes |
|----------|----------------|-------|
| `NULL` | `null` | SQL NULL is JavaScript null |
| `INTEGER` | `number` or `bigint` | Small integers use `number`, large integers use `bigint` |
| `REAL` / `FLOAT` | `number` | Floating-point numbers |
| `TEXT` | `string` | Text strings |
| `BLOB` | `Uint8Array` | Binary data as typed array |
| `BOOLEAN` | `boolean` | True/false values |
| `DATE` | `string` | ISO 8601 date: `"2024-01-15"` |
| `TIME` | `string` | ISO 8601 time: `"14:30:00"` |
| `DATETIME` | `string` | ISO 8601 datetime: `"2024-01-15T14:30:00"` |
| `TIMESPAN` | `string` | ISO 8601 duration: `"PT1H30M"` (1 hour 30 minutes) |
| `JSON` | `string` | Validated JSON string |

### Temporal Types (DATE, TIME, DATETIME)

Quereus has native temporal types that store values as ISO 8601 strings and provide validation and comparison:

```typescript
// Create table with temporal columns
await db.exec(`
  create table events (
    id integer primary key,
    event_date date,
    event_time time,
    created_at datetime
  )
`);

// Insert temporal values - strings are validated and normalized
await db.exec(`
  insert into events values (
    1,
    '2024-01-15',           -- DATE
    '14:30:00',             -- TIME
    '2024-01-15T14:30:00'   -- DATETIME
  )
`);

// Use conversion functions to ensure proper type
await db.exec(`
  insert into events values (
    2,
    date('2024-03-20'),
    time('09:00:00'),
    datetime('now')
  )
`);

// Query temporal values - returned as ISO 8601 strings
for await (const event of db.eval("select * from events")) {
  console.log(event.event_date);   // "2024-01-15"
  console.log(event.event_time);   // "14:30:00"
  console.log(event.created_at);   // "2024-01-15T14:30:00"
}

// Temporal types support proper comparison and ordering
for await (const event of db.eval(`
  select * from events
  where event_date >= date('2024-01-01')
  order by created_at desc
`)) {
  console.log(event);
}
```

**Conversion Functions:**
- `date(value)` - Convert to DATE type
- `time(value)` - Convert to TIME type
- `datetime(value)` - Convert to DATETIME type
- `timespan(value)` - Convert to TIMESPAN type
- Special value: `datetime('now')` returns current timestamp

### TIMESPAN Type

Quereus has a native TIMESPAN type for representing durations and intervals:

```typescript
// Create table with timespan column
await db.exec(`
  create table events (
    id integer primary key,
    name text,
    duration timespan
  )
`);

// Insert timespan values - ISO 8601 duration strings
await db.exec(`
  insert into events values
    (1, 'Meeting', 'PT1H30M'),        -- 1 hour 30 minutes
    (2, 'Workshop', 'PT3H'),          -- 3 hours
    (3, 'Sprint', 'P14D')             -- 14 days
`);

// Use timespan() function with human-readable strings
await db.exec(`
  insert into events values
    (4, 'Break', timespan('15 minutes')),
    (5, 'Project', timespan('2 weeks 3 days'))
`);

// Temporal arithmetic: add timespan to datetime
for await (const event of db.eval(`
  select
    name,
    duration,
    datetime('2024-01-15T09:00:00') + duration as end_time
  from events
`)) {
  console.log(event);
}

// Subtract timespans
const diff = await db.prepare(`
  select timespan('2 hours') - timespan('30 minutes') as remaining
`).get();
console.log(diff.remaining); // "PT1H30M"

// Compare timespans
for await (const event of db.eval(`
  select * from events
  where duration > timespan('1 hour')
  order by duration
`)) {
  console.log(event);
}
```

**TIMESPAN Features:**
- ISO 8601 duration string format (`"PT1H30M"`, `"P1DT2H"`)
- Human-readable parsing via `timespan()` function
- Arithmetic operations with DATE, TIME, DATETIME types
- Addition and subtraction of timespans
- Proper comparison and ordering
- Stored as TEXT with validation

### JSON Type

Quereus has a native JSON type that validates JSON syntax and provides deep equality comparison:

```typescript
// Create table with JSON column
await db.exec(`
  create table users (
    id integer primary key,
    profile json
  )
`);

// Insert JSON data - validated and normalized
await db.exec(`
  insert into users values
    (1, '{"name":"Alice","age":30}'),
    (2, json('{"name":"Bob","age":25}'))
`);

// Enforce JSON structure with CHECK constraints
await db.exec(`
  create table events (
    id integer primary key,
    data json check (json_schema(data, '[{x:integer,y:number}]'))
  )
`);

// Valid insert - matches schema
await db.exec(`
  insert into events values (1, '[{"x": 1, "y": 2.5}, {"x": 2, "y": 3.14}]')
`);

// Invalid insert - fails CHECK constraint
try {
  await db.exec(`
    insert into events values (2, '[{"x": "wrong", "y": 2.5}]')
  `);
} catch (err) {
  console.log('CHECK constraint failed'); // x must be integer
}

// JSON values are compared by content, not string representation
// These two are considered equal despite different key order:
await db.exec(`insert into users values (3, '{"x":1,"y":2}')`);
await db.exec(`insert into users values (4, '{"y":2,"x":1}')`);

// Query JSON data
for await (const user of db.eval("select * from users")) {
  console.log(user.profile); // Normalized JSON string
}

// Use JSON functions to extract values
for await (const row of db.eval(`
  select
    id,
    json_extract(profile, '$.name') as name,
    json_extract(profile, '$.age') as age
  from users
`)) {
  console.log(`${row.name} is ${row.age} years old`);
}

// json() conversion function validates and normalizes
const normalized = await db.prepare("select json(?) as data").get(['{"x":1}']);
console.log(normalized.data); // '{"x":1}' (normalized)
```

**JSON Features:**
- Validates JSON syntax on insert/update
- Normalizes JSON (consistent formatting)
- Deep equality comparison (content-based, not string-based)
- Works with all existing JSON functions (json_extract, json_valid, etc.)

### Working with BLOBs

Binary data is represented as `Uint8Array`:

```typescript
// Insert binary data
const imageData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG header
await db.exec("insert into files (name, data) values (?, ?)",
  ["image.jpg", imageData]);

// Retrieve binary data
const file = await db.prepare("select data from files where name = ?").get(["image.jpg"]);
console.log(file.data instanceof Uint8Array); // true
console.log(file.data); // Uint8Array(4) [255, 216, 255, 224]

// Generate random binary data
const random = await db.prepare("select randomblob(16) as random_bytes").get();
console.log(random.random_bytes instanceof Uint8Array); // true
```

### Working with Large Integers

JavaScript `number` type is limited to safe integers (±2^53 - 1). For larger integers, Quereus uses `bigint`:

```typescript
// Small integers use number
const small = await db.prepare("select 42 as value").get();
console.log(typeof small.value); // "number"

// Large integers use bigint
const large = await db.prepare("select 9007199254740992 as value").get();
console.log(typeof large.value); // "bigint"

// You can pass bigint as parameters
await db.exec("insert into counters (id, count) values (?, ?)",
  [1, 9007199254740992n]);
```

### NULL Handling

SQL `NULL` is represented as JavaScript `null`:

```typescript
// NULL values in results
const user = await db.prepare("select name, email from users where id = ?").get([1]);
console.log(user.email === null); // true if email is NULL

// NULL in parameters
await db.exec("insert into users (name, email) values (?, ?)",
  ["John", null]); // email will be NULL

// NULL checks in SQL
const hasEmail = await db.prepare(
  "select count(*) as count from users where email is not null"
).get();
```

### Type Coercion

Quereus follows SQL type coercion rules:

```typescript
// Numeric strings are coerced in comparisons
const result = await db.prepare("select 42 = '42' as equal").get();
console.log(result.equal); // true (boolean)

// String concatenation with ||
const concat = await db.prepare("select 'Value: ' || 42 as text").get();
console.log(concat.text); // "Value: 42" (string)

// Arithmetic operations coerce to numbers
const math = await db.prepare("select '10' + '20' as sum").get();
console.log(math.sum); // 30 (number)
```

### Row Representation: Arrays vs Objects

Internally, Quereus represents rows as **arrays of values** (`Row = SqlValue[]`), but the high-level API converts them to **objects** for convenience:

```typescript
// stmt.get() returns a single object (Record<string, SqlValue>)
const user = await db.prepare("select id, name, email from users where id = ?").get([1]);
// user is: { id: 1, name: "Alice", email: "alice@example.com" }
console.log(user.name); // "Alice"

// stmt.all() returns an async iterator of objects
const stmt = await db.prepare("select id, name from users");
for await (const user of stmt.all()) {
  console.log(user.name); // Each row is an object
}
await stmt.finalize();

// db.eval() also returns an async iterator of objects
for await (const user of db.eval("select * from users")) {
  console.log(user.name); // Each user is an object
}
```

**Key Points:**
- All query methods return rows as objects with column names as keys
- `get()` returns a single object (or undefined)
- `all()` and `eval()` return async iterators for streaming

### Async Iteration and Streaming

Quereus uses **async iterators** for streaming query results, allowing you to process large result sets without loading everything into memory:

```typescript
// db.eval returns AsyncIterableIterator<Record<string, SqlValue>>
const iterator = db.eval("select * from large_table");

// Use for-await-of to stream rows
for await (const row of iterator) {
  console.log(row); // Each row is an object
  // Rows are streamed - not all loaded into memory at once
}

// Or manually control iteration
const iter = db.eval("select * from users");
const first = await iter.next(); // { value: { id: 1, name: "Alice" }, done: false }
const second = await iter.next(); // { value: { id: 2, name: "Bob" }, done: false }
```

**Runtime Value Types:**

At the runtime level, Quereus works with these value types:

```typescript
// SqlValue: primitive values
type SqlValue = string | number | bigint | boolean | Uint8Array | null;

// Row: array of values
type Row = SqlValue[];

// RuntimeValue: what instructions can work with
type RuntimeValue = SqlValue | Row | AsyncIterable<Row> | ((ctx: RuntimeContext) => OutputValue);

// SqlParameters: how you pass parameters
type SqlParameters = Record<string, SqlValue> | SqlValue[];
```

This means:
- **Scalar queries** return a single `SqlValue`
- **Table queries** return `AsyncIterable<Row>` (streamed rows)
- **Parameters** can be positional arrays or named objects

### Multi-Statement Execution

When executing multiple statements with `db.eval`, **only the last statement's results are returned**:

```typescript
// Only the SELECT results are returned
for await (const row of db.eval(`
  create table temp_data (id integer, value text);
  insert into temp_data values (1, 'a'), (2, 'b');
  select * from temp_data;
`)) {
  console.log(row); // { id: 1, value: 'a' }, then { id: 2, value: 'b' }
}

// The CREATE and INSERT are executed, but their results are discarded
// Only the final SELECT produces rows to iterate

// If the last statement doesn't return rows, the iterator is empty
for await (const row of db.eval(`
  create table users (id integer, name text);
  insert into users values (1, 'Alice');
`)) {
  // This loop never executes - INSERT doesn't return rows
}

// Use db.exec for multi-statement DDL/DML without results
await db.exec(`
  create table users (id integer, name text);
  insert into users values (1, 'Alice');
`);
```

**Best Practices:**
- Use `db.eval()` when you need results from the last statement
- Use `db.exec()` for DDL/DML statements that don't return results
- For multiple statements with results, execute them separately

### TypeScript Type Safety

For better type safety, you can define interfaces for your result types:

```typescript
interface User {
  id: number;
  name: string;
  email: string | null;
  created_at: string; // Date/time as string
}

const user = await db.prepare("select * from users where id = ?").get([1]) as User;
console.log(user.name.toUpperCase()); // TypeScript knows name is a string

// For async iteration
for await (const user of db.eval("select * from users") as AsyncIterableIterator<User>) {
  console.log(user.email?.toLowerCase()); // TypeScript knows the shape
}
```
