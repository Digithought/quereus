# Memory Table Module Documentation

The Memory Table Module provides virtual tables backed by memory for the SQLiter engine. These tables support standard SQL operations and can be used for high-performance in-memory data storage that requires SQL query capabilities.

## Module Registration

Before using memory tables, you must register the module:

```typescript
import { Database } from 'sqliter/core/database';
import { MemoryTableModule } from 'sqliter/vtab/memoryTable';

const db = new Database();
const memoryModule = new MemoryTableModule();
db.registerVtabModule('memory', memoryModule);
```

## Creating Memory Tables

Memory tables are created using the `CREATE VIRTUAL TABLE` SQL statement:

```typescript
await db.exec(`
  CREATE VIRTUAL TABLE table_name USING memory(
    column1 type1 [constraints],
    column2 type2 [constraints],
    ...
  )
`);
```

### Supported Column Types

- `INTEGER` - Whole numbers
- `REAL` - Floating-point numbers
- `TEXT` - Text strings
- `BLOB` - Binary data

### Supported Constraints

- `PRIMARY KEY` - Designates a column as the primary key
- `NOT NULL` - Requires the column to have a value
- `DEFAULT value` - Sets a default value for the column
- `UNIQUE` - Ensures all values in the column are unique

## Data Operations

### INSERT

```typescript
await db.exec(`
  INSERT INTO table_name (column1, column2, ...)
  VALUES (value1, value2, ...)
`);

// Or multiple rows at once
await db.exec(`
  INSERT INTO table_name (column1, column2, ...)
  VALUES
  (row1_value1, row1_value2, ...),
  (row2_value1, row2_value2, ...),
  ...
`);
```

### SELECT

```typescript
// Simple select
await db.exec(`SELECT * FROM table_name`);

// With conditions
await db.exec(`SELECT column1, column2 FROM table_name WHERE condition`);

// With ordering
await db.exec(`SELECT * FROM table_name ORDER BY column1 [ASC|DESC]`);

// With limit and offset
await db.exec(`SELECT * FROM table_name LIMIT limit_value OFFSET offset_value`);

// With grouping and aggregation
await db.exec(`
  SELECT column1, COUNT(*) as count
  FROM table_name
  GROUP BY column1
`);
```

### UPDATE

```typescript
await db.exec(`
  UPDATE table_name
  SET column1 = value1, column2 = value2, ...
  WHERE condition
`);
```

### DELETE

```typescript
await db.exec(`DELETE FROM table_name WHERE condition`);
```

## Transaction Support

Memory tables support transactions for atomic operations:

```typescript
try {
  await db.exec('BEGIN TRANSACTION');
  
  // Multiple operations here...
  await db.exec(`INSERT INTO table_name (column1) VALUES ('value1')`);
  await db.exec(`UPDATE table_name SET column2 = 'value2' WHERE condition`);
  
  await db.exec('COMMIT');
} catch (error) {
  await db.exec('ROLLBACK');
  console.error('Transaction failed:', error);
}
```

## Performance Considerations

1. **Memory Usage**: All data is stored in memory, so large datasets may consume significant RAM.

2. **Speed**: Memory tables are typically faster than disk-based tables because there's no disk I/O.

3. **Persistence**: Data in memory tables is lost when the program terminates. If persistence is needed, you must explicitly save the data.

4. **Indexing**: Primary key columns are automatically indexed for fast retrieval.

## Memory Management

Memory tables automatically manage their own memory. As rows are added, updated, or deleted, the memory is adjusted accordingly. When a table is dropped, all associated memory is freed.

## Example Use Cases

### Temporary Data Storage

```typescript
// Create a temporary results table
await db.exec(`
  CREATE VIRTUAL TABLE temp_results USING memory(
    id INTEGER PRIMARY KEY,
    result_value REAL,
    timestamp TEXT
  )
`);

// Process data and store results
for (const item of dataToProcess) {
  const result = processItem(item);
  await db.exec(`
    INSERT INTO temp_results (result_value, timestamp)
    VALUES (${result}, datetime('now'))
  `);
}

// Query aggregate results
await db.exec(`
  SELECT AVG(result_value) as average
  FROM temp_results
`);

// Clean up
await db.exec(`DROP TABLE temp_results`);
```

### In-Memory Caching

```typescript
// Create a cache table
await db.exec(`
  CREATE VIRTUAL TABLE cache USING memory(
    key TEXT PRIMARY KEY,
    value TEXT,
    expires INTEGER
  )
`);

// Add to cache
function setCache(key, value, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  db.exec(`
    INSERT OR REPLACE INTO cache (key, value, expires)
    VALUES (?, ?, ?)
  `, [key, value, expires]);
}

// Get from cache
async function getCache(key) {
  const now = Math.floor(Date.now() / 1000);
  
  // First clean expired entries
  await db.exec(`DELETE FROM cache WHERE expires < ?`, [now]);
  
  // Then fetch if available
  let result = null;
  await db.exec(
    `SELECT value FROM cache WHERE key = ? AND expires >= ?`,
    [key, now],
    (row) => {
      result = row[0];
    }
  );
  
  return result;
}
```

## Error Handling

Memory tables will throw exceptions for the following conditions:

- Attempting to insert a duplicate primary key
- Violating a NOT NULL constraint
- Type conversion errors
- Syntax errors in SQL statements

Example error handling:

```typescript
try {
  await db.exec(`
    INSERT INTO products (id, name, price)
    VALUES (1, 'Duplicate Product', 29.99)
  `);
} catch (error) {
  if (error.message.includes('UNIQUE constraint failed')) {
    console.error('Product with this ID already exists');
  } else {
    console.error('Error inserting product:', error);
  }
}
```
