# Function Registration in Quereus

Quereus provides a simple and powerful way to register custom SQL functions. The function registration system is designed to be intuitive and supports scalar functions, table-valued functions, and aggregate functions with native async support.

## Function Types

### 1. Scalar Functions

Scalar functions take SQL values as input and return a single SQL value. They're the most common type of function.

```typescript
export const reverseFunc = createScalarFunction(
  { name: 'reverse', numArgs: 1, deterministic: true },
  (str: SqlValue): SqlValue => {
    if (typeof str !== 'string') return null;
    return str.split('').reverse().join('');
  }
);
```

**Key features:**
- Direct return of SQL values
- Native async support with Promise return types
- Automatic type handling and conversion
- Simple error handling via exceptions

### 2. Table-Valued Functions (TVFs)

Table-valued functions return multiple rows and can be used in FROM clauses. They return `AsyncIterable<Row>`.

```typescript
export const generateSeries = createTableValuedFunction(
  { name: 'generate_series', numArgs: 2, deterministic: true },
  async function* (start: SqlValue, end: SqlValue): AsyncIterable<Row> {
    const startNum = Number(start);
    const endNum = Number(end);
    
    if (isNaN(startNum) || isNaN(endNum)) return;
    
    for (let i = startNum; i <= endNum; i++) {
      yield [i]; // Each row is an array of SqlValue
    }
  }
);
```

**Usage in SQL:**
```sql
SELECT * FROM generate_series(1, 10);
SELECT value FROM generate_series(1, 100) WHERE value % 2 = 0;
```

### 3. Aggregate Functions

Aggregate functions use a functional reducer pattern that's easy to understand and compose.

```typescript
export const stringConcat = createAggregateFunction(
  { name: 'string_concat', numArgs: 1, initialValue: [] },
  (acc: string[], value: SqlValue) => {
    if (typeof value === 'string') acc.push(value);
    return acc;
  },
  (acc: string[]) => acc.join(',')
);
```

## Configuration Options

### Scalar Function Options

```typescript
interface ScalarFuncOptions {
  name: string;           // Function name as called in SQL
  numArgs: number;        // Number of arguments (-1 for variable)
  flags?: FunctionFlags;  // Optional behavior flags
  deterministic?: boolean; // Whether function is deterministic (default: true)
}
```

### Table-Valued Function Options

```typescript
interface TableValuedFuncOptions {
  name: string;
  numArgs: number;
  flags?: FunctionFlags;
  deterministic?: boolean;
}
```

### Aggregate Function Options

```typescript
interface AggregateFuncOptions {
  name: string;
  numArgs: number;
  flags?: FunctionFlags;
  initialValue?: any;     // Initial accumulator value
}
```

## Async Support

Functions naturally support async operations:

```typescript
export const fetchDataFunc = createScalarFunction(
  { name: 'fetch_data', numArgs: 1, deterministic: false },
  async (url: SqlValue): Promise<SqlValue> => {
    const response = await fetch(url as string);
    return await response.text();
  }
);
```

## Performance Benefits

The function registration system is optimized for performance:

1. **Direct Function Calls**: Functions are called directly without context overhead
2. **Optimized Emitters**: The runtime detects and uses the most efficient execution path
3. **Sub-Program Tracking**: Automatic tracking of sub-programs for debugging

## Type System

Functions work with Quereus's SQL type system:

```typescript
type SqlValue = null | string | number | bigint | Uint8Array | boolean;
type Row = SqlValue[];
```

Type conversion is handled automatically, but you can perform explicit checks:

```typescript
export const safeNumberFunc = createScalarFunction(
  { name: 'safe_number', numArgs: 1, deterministic: true },
  (value: SqlValue): SqlValue => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const num = Number(value);
      return isNaN(num) ? null : num;
    }
    return null;
  }
);
```

## Error Handling

Functions can handle errors by:
1. Returning `null` for invalid inputs
2. Throwing exceptions for serious errors

```typescript
export const divideFunc = createScalarFunction(
  { name: 'divide', numArgs: 2, deterministic: true },
  (a: SqlValue, b: SqlValue): SqlValue => {
    const numA = Number(a);
    const numB = Number(b);
    
    if (isNaN(numA) || isNaN(numB)) return null;
    if (numB === 0) throw new Error('Division by zero');
    
    return numA / numB;
  }
);
```

## Registration

Functions are registered by adding them to the `BUILTIN_FUNCTIONS` array or registering them dynamically:

```typescript
import { BUILTIN_FUNCTIONS } from './func/builtins/index.js';

// Add to builtin functions
BUILTIN_FUNCTIONS.push(myCustomFunction);

// Or register dynamically (if supported by your setup)
database.registerFunction(myCustomFunction);
```

## Examples

The builtin functions provide excellent examples of the registration system in action. See:
- `src/func/builtins/scalar.ts` - Scalar function examples
- `src/func/builtins/aggregate.ts` - Aggregate function examples  
- `src/func/builtins/json.ts` - Complex JSON manipulation functions
- `src/func/builtins/index.ts` - Table-valued function examples
