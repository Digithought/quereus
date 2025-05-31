# Function Registration in Quereus

Quereus provides a simple and powerful way to register custom SQL functions. The function registration system is designed to be intuitive and supports scalar functions, table-valued functions, and aggregate functions with native async support.

## Function Types

### 1. Scalar Functions

Scalar functions take SQL values as input and return a single SQL value. They're the most common type of function.

```typescript
export const reverseFunc = createScalarFunction(
  { 
    name: 'reverse', 
    numArgs: 1, 
    deterministic: true,
    returnType: {
      typeClass: 'scalar',
      affinity: SqlDataType.TEXT,
      nullable: true,
      isReadOnly: true
    }
  },
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
  { 
    name: 'generate_series', 
    numArgs: 2, 
    deterministic: true,
    returnType: {
      typeClass: 'relation',
      isReadOnly: true,
      isSet: false, // Can return duplicate values
      columns: [
        {
          name: 'value',
          type: {
            typeClass: 'scalar',
            affinity: SqlDataType.INTEGER,
            nullable: false,
            isReadOnly: true
          },
          generated: true
        }
      ],
      keys: [],
      rowConstraints: []
    }
  },
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
  { 
    name: 'string_concat', 
    numArgs: 1, 
    initialValue: [],
    returnType: {
      typeClass: 'scalar',
      affinity: SqlDataType.TEXT,
      nullable: true,
      isReadOnly: true
    }
  },
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
  name: string;                // Function name as called in SQL
  numArgs: number;             // Number of arguments (-1 for variable)
  flags?: FunctionFlags;       // Optional behavior flags
  deterministic?: boolean;     // Whether function is deterministic (default: true)
  returnType?: ScalarType;     // Return type specification
}
```

**Example with explicit return type:**
```typescript
const mathFunc = createScalarFunction(
  {
    name: 'custom_math',
    numArgs: 2,
    returnType: {
      typeClass: 'scalar',
      affinity: SqlDataType.REAL,
      nullable: false,
      isReadOnly: true
    }
  },
  (a: SqlValue, b: SqlValue) => Number(a) * Number(b)
);
```

### Table-Valued Function Options

```typescript
interface TableValuedFuncOptions {
  name: string;
  numArgs: number;
  flags?: FunctionFlags;
  deterministic?: boolean;
  returnType?: RelationType;   // Relation type with column definitions
}
```

**Example with column specification:**
```typescript
const userDataFunc = createTableValuedFunction(
  {
    name: 'user_data',
    numArgs: 1,
    returnType: {
      typeClass: 'relation',
      isReadOnly: true,
      isSet: false,
      columns: [
        { 
          name: 'id', 
          type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true },
          generated: true 
        },
        { 
          name: 'name', 
          type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true },
          generated: true 
        }
      ],
      keys: [[]],  // No primary keys defined
      rowConstraints: []
    }
  },
  async function* (input: SqlValue): AsyncIterable<Row> {
    // Function implementation
  }
);
```

### Aggregate Function Options

```typescript
interface AggregateFuncOptions {
  name: string;
  numArgs: number;
  flags?: FunctionFlags;
  initialValue?: any;          // Initial accumulator value
  returnType?: ScalarType;     // Return type specification
}
```

## Type System Integration

Functions work seamlessly with Quereus's type system through the `BaseType` hierarchy:

```typescript
// Scalar type for functions returning single values
type ScalarType = {
  typeClass: 'scalar';
  affinity: SqlDataType;
  nullable: boolean;
  isReadOnly: boolean;
  collationName?: string;
}

// Relation type for table-valued functions
type RelationType = {
  typeClass: 'relation';
  isReadOnly: boolean;
  isSet: boolean;              // true for sets (no duplicates), false for bags
  columns: RelationColumn[];   // Column definitions
  keys: number[][];           // Key constraints
  rowConstraints: any[];      // Row-level constraints
}
```

## Async Support

Functions naturally support async operations:

```typescript
export const fetchDataFunc = createScalarFunction(
  { 
    name: 'fetch_data', 
    numArgs: 1, 
    deterministic: false,
    returnType: {
      typeClass: 'scalar',
      affinity: SqlDataType.TEXT,
      nullable: true,
      isReadOnly: true
    }
  },
  async (url: SqlValue): Promise<SqlValue> => {
    const response = await fetch(url as string);
    return await response.text();
  }
);
```

## Type Safety and Validation

The new function schema system provides compile-time and runtime type safety:

```typescript
import { isScalarFunctionSchema, isTableValuedFunctionSchema } from '../schema/function.js';

// Type guards ensure proper function usage
if (isTableValuedFunctionSchema(functionSchema)) {
  // Safe to access returnType.columns
  const columns = functionSchema.returnType.columns;
}
```

## Performance Benefits

The function registration system is optimized for performance:

1. **Direct Function Calls**: Functions are called directly without context overhead
2. **Optimized Emitters**: The runtime detects and uses the most efficient execution path
3. **Type-Safe Execution**: Consistent type system eliminates runtime type checking overhead
4. **Sub-Program Tracking**: Automatic tracking of sub-programs for debugging

## Error Handling

Functions can handle errors by:
1. Returning `null` for invalid inputs
2. Throwing exceptions for serious errors

```typescript
export const divideFunc = createScalarFunction(
  { 
    name: 'divide', 
    numArgs: 2, 
    deterministic: true,
    returnType: {
      typeClass: 'scalar',
      affinity: SqlDataType.REAL,
      nullable: true,
      isReadOnly: true
    }
  },
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

// Or register dynamically
database.registerFunction(myCustomFunction);
```