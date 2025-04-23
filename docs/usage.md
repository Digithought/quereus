# SQLiter Usage Guide

SQLiter provides a lightweight, TypeScript-native SQL interface inspired by SQLite with a focus on virtual tables that can be backed by any data source. This document explains how to use SQLiter effectively in your applications.

## Basic Usage

### Creating a Database

```typescript
import { Database } from 'sqliter';
// Make sure to import other necessary types if using them directly
// import { type SqlValue, StatusCode, SqliteError, MisuseError } from 'sqliter';

// Create an in-memory database
const db = new Database();
```

### Executing Simple Statements (`db.exec`)

Use `db.exec(sql)` for executing statements without fetching results, especially for DDL (`CREATE`, `DROP`), transaction control (`BEGIN`, `COMMIT`), or simple `INSERT`/`UPDATE`/`DELETE` statements with or without parameters.

```typescript
// Execute DDL
await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
await db.exec("CREATE INDEX idx_users_email ON users(email)");

// Simple INSERT
await db.exec("INSERT INTO users (name, email) VALUES (?, ?)", ["User A", "example@sample.com"]);

// Transaction control
await db.exec("BEGIN");
// ... operations ...
await db.exec("COMMIT");
```

### Inserting Data (Recommended: Prepared Statements)

For inserting data, especially multiple rows or with parameters, using prepared statements is safer and often more efficient.

```typescript
// Insert multiple rows with a prepared statement
const stmt = await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)");
try {
  await stmt.run(["Alice Smith", "alice@example.com"]);
  await stmt.run(["Bob Johnson", "bob@example.com"]);
} finally {
  await stmt.finalize(); // Always finalize when done
}
```

### Querying Data

SQLiter provides several ways to query data, depending on your needs.

#### Iterating Over Results (`db.eval`)

The most idiomatic way to process multiple result rows is using `db.eval`, which returns an async iterator. It automatically handles statement preparation, parameter binding, and finalization.

```typescript
try {
  // Using positional parameters
  for await (const user of db.eval("SELECT name, email FROM users WHERE status = ? ORDER BY name", ["active"])) {
    console.log(`Active user: ${user.name} (${user.email})`);
    // row is Record<string, SqlValue>
  }

  // Using named parameters
  for await (const project of db.eval("SELECT * FROM projects WHERE owner = :owner AND deadline < :date", 
                                    { ":owner": "Alice Smith", ":date": Date.now() })) {
    console.log(`Project: ${project.name}`);
  }

  // No parameters
  for await (const item of db.eval("SELECT * FROM inventory")) {
     // ...
  }
} catch (e) {
  console.error("Query failed:", e);
  // Handle errors (e.g., SqliteError, MisuseError)
}
```

#### Fetching a Single Row (`stmt.get`)

If you expect only one row (or just need the first one), prepare the statement and use `stmt.get()`.

```typescript
const stmt = await db.prepare("SELECT * FROM users WHERE id = ?");
try {
  const user = await stmt.get([1]); // Get first row only (or undefined if none)
  if (user) {
    console.log(user.name); // "John Doe"
  }
} finally {
  await stmt.finalize();
}

// Using named parameters
const stmt2 = await db.prepare("SELECT * FROM users WHERE email = :email");
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
const stmt = await db.prepare("SELECT * FROM users WHERE role = ?");
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
const stmt = await db.prepare("SELECT * FROM large_table WHERE category = ?");
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
await db.exec("BEGIN TRANSACTION");
try {
  await db.exec("INSERT INTO users (name) VALUES (?)", ["User 1"]);
  await db.exec("INSERT INTO users (name) VALUES (?)", ["User 2"]);
  await db.exec("COMMIT");
} catch (e) {
  await db.exec("ROLLBACK");
  throw e;
}

// Transaction with savepoints
await db.exec("BEGIN TRANSACTION");
try {
  await db.exec("INSERT INTO users (name) VALUES (?)", ["User 3"]);
  
  await db.exec("SAVEPOINT save1");
  try {
    await db.exec("INSERT INTO users (name) VALUES (?)", ["User 4"]);
    // Some condition to decide whether to keep these changes
    if (shouldRollback) {
      await db.exec("ROLLBACK TO save1");
    } else {
      await db.exec("RELEASE save1");
    }
  } catch (e) {
    await db.exec("ROLLBACK TO save1");
    // Continue with the outer transaction
  }
  
  await db.exec("COMMIT");
} catch (e) {
  await db.exec("ROLLBACK");
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

### `db.close()`
Closes the database connection and finalizes all open statements.

## Statement API Reference

SQLiter provides both high-level and low-level APIs for working with prepared statements.

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
const user = await stmt.get([1]); // e.g., "SELECT * FROM users WHERE id = ?"
if (user) {
  console.log(user.name, user.email);
}
```

#### `stmt.all(params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue>[]>`

Executes the statement and returns all result rows as an array of objects.

```typescript
const users = await stmt.all([30]); // e.g., "SELECT * FROM users WHERE age > ?"
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

One of SQLiter's key features is its support for virtual tables, which allow you to expose any data source as a SQL table:

```typescript
// Register a virtual table module
db.registerVtabModule('json_data', new JsonTableModule());

// Create a virtual table using the module
await db.exec(`
  CREATE VIRTUAL TABLE products USING json_data(
    '{"data": [{"id": 1, "name": "Product A"}, {"id": 2, "name": "Product B"}]}'
  )
`);

// Query it like a regular table
const products = await db.prepare("SELECT * FROM products WHERE id > ?").all([1]);
```

See the [Memory Table documentation](./memory-table.md) for more details on the built-in memory table implementation.

## User-Defined Functions

SQLiter allows you to define custom SQL functions:

```typescript
// Register a scalar function
db.createScalarFunction("reverse", { numArgs: 1, deterministic: true }, 
  (text) => {
    if (typeof text !== 'string') return text;
    return text.split('').reverse().join('');
  }
);

// Use it in SQL
const result = await db.prepare("SELECT reverse(name) FROM users").all();
```

## Error Handling

SQLiter throws specific error types that you can catch and handle:

```typescript
try {
  await db.exec("INSERT INTO nonexistent_table VALUES (1)");
} catch (err) {
  if (err instanceof SqliteError) {
    console.error(`SQLite error (code ${err.code}): ${err.message}`);
  } else if (err instanceof MisuseError) {
    console.error(`API misuse: ${err.message}`);
  } else {
    console.error(`Unknown error: ${err}`);
  }
}
``` 
