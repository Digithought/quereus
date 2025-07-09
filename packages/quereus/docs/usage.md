# Quereus Usage Guide

Quereus provides a lightweight, TypeScript-native SQL interface inspired by SQLite with a focus on virtual tables that can be backed by any data source. This document explains how to use Quereus effectively in your applications.

## Basic Usage

### Creating a Database

```typescript
import { Database } from 'quereus';
// Make sure to import other necessary types if using them directly
// import { type SqlValue, StatusCode, QuereusError, MisuseError } from 'quereus';

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

#### Fetching All Rows (`stmt.all`)

To get all results buffered into an array, prepare the statement and use `stmt.all()`.

```typescript
const stmt = await db.prepare("select * from users where role = ?");
try {
  const admins = await stmt.all(["admin"]); // Get all rows as an array of objects
  console.log(`Found ${admins.length} admins`);
} finally {
  await stmt.finalize();
}
```

#### Streaming Results with `step()` (Low Level)

For maximum control, you can still use the manual `step()` loop with a prepared statement:

```typescript
const stmt = await db.prepare("select * from large_table where category = ?");
stmt.bind(1, "electronics"); // Bind parameters first
try {
  while (await stmt.step() === StatusCode.ROW) {
    const row = stmt.getAsObject();
    // Process each row individually
    processRow(row);
  }
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

### `db.exec(sql: string): Promise<void>`
Executes one or more SQL statements separated by semicolons. Primarily intended for DDL, transaction control, or simple SQL without parameters or results. For parameterized queries or retrieving results, use `prepare` or `eval`.

### `db.prepare(sql: string): Promise<Statement>`
Prepares an SQL statement for execution, returning a `Statement` object. This is the entry point for using the `Statement` API (`run`, `get`, `all`, `step`, `bind`, etc.).

### `db.eval(sql: string, params?: SqlValue[] | Record<string, SqlValue>): AsyncIterableIterator<Record<string, SqlValue>>`
A high-level async generator for executing a query and iterating over its results. Handles statement preparation, parameter binding, and automatic finalization. See the iteration example above.

### `db.beginTransaction(mode?)`, `db.commit()`, `db.rollback()`
Standard transaction control methods.

### `db.registerVtabModule(...)`, `db.createScalarFunction(...)`, `db.createAggregateFunction(...)`, `db.registerCollation(...)`
Methods for extending database functionality.

### `db.setInstructionTracer(tracer: InstructionTracer | null)`
Sets an instruction tracer for debugging and performance analysis. The tracer will be used for all statement executions on this database instance.

### `db.close()`
Closes the database connection and finalizes all open statements.

## Statement API Reference

Quereus provides both high-level and low-level APIs for working with prepared statements.

### High-Level API

These methods bind parameters, execute the statement, and handle results in a single call:

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

#### `stmt.all(params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue>[]>`

Executes the statement and returns all result rows as an array of objects.

```typescript
const users = await stmt.all([30]); // e.g., "select * from users where age > ?"
console.log(`Found ${users.length} users`);
users.forEach(user => console.log(user.name));
```

### Low-Level API

For more control over execution:

#### `stmt.bind(key: number | string, value: SqlValue): stmt`

Binds a single parameter by position (1-based) or name.

```typescript
stmt.bind(1, "value"); // Bind first parameter
stmt.bind(":name", "John"); // Bind named parameter
```

#### `stmt.bindAll(params: SqlValue[] | Record<string, SqlValue>): stmt`

Binds multiple parameters at once.

```typescript
stmt.bindAll([1, "text", null]); // Positional
stmt.bindAll({ ":id": 1, ":name": "John" }); // Named
```

#### `stmt.step(): Promise<StatusCode>`

Advances to the next row or completion. Returns `StatusCode.ROW`, `StatusCode.DONE`, or an error code.

```typescript
const status = await stmt.step();
if (status === StatusCode.ROW) {
  // Process the current row
}
```

#### `stmt.getArray(): SqlValue[]`

Gets current row values as an array (after `step()` returns `ROW`).

#### `stmt.getAsObject(): Record<string, SqlValue>`

Gets current row as an object (after `step()` returns `ROW`).

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
db.registerVtabModule('json_data', new JsonTableModule());

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

**Note:** When using a default module with `create table`, the module's `xCreate` function receives the table definition (columns, constraints) parsed from the `create table` statement itself, rather than relying solely on arguments passed via `using (...)` or `pragma default_vtab_args`. The `memory` module is designed to work this way.

See the [Memory Table documentation](./memory-table.md) for more details on the built-in memory table implementation.

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
