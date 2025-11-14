# Quereus Type System

## Overview

Quereus implements a **logical type system** that separates type semantics from physical storage representation. This design provides strict type safety and extensibility while maintaining runtime performance.

### Core Principles

1. **Logical vs Physical Separation**: Types define validation and comparison semantics (logical) while values are stored using a small set of physical representations
2. **Strict Typing**: All type checking is strict - no implicit coercion between incompatible types
3. **Type-Specific Collations**: Collations are associated with specific types (primarily TEXT-based types)
4. **Plugin Extensibility**: Custom types can be registered via plugins
5. **Performance First**: Type information enables optimized comparisons without runtime type detection

### Design Decisions

- **Collations**: Type-specific. TEXT types support BINARY/NOCASE/RTRIM; numeric and temporal types have natural ordering
- **Type Enforcement**: Always strict - values must match declared types or be explicitly converted via conversion functions
- **Type Conversion**: Use functions like `integer()`, `text()`, `date()` instead of CAST syntax (though CAST is supported for compatibility)
- **Date/Time**: Native DATE, TIME, DATETIME types using Temporal API internally, stored as ISO 8601 strings
- **JSON**: Native JSON type with object storage (future)
- **Constraints**: Length, precision, and other restrictions handled via CHECK constraints, not type definitions

---

## Type System Architecture

### Physical Types

Physical types represent how values are stored in memory and on disk:

```typescript
export enum PhysicalType {
  NULL = 0,
  INTEGER = 1,    // number | bigint
  REAL = 2,       // number (floating point)
  TEXT = 3,       // string
  BLOB = 4,       // Uint8Array
  BOOLEAN = 5,    // boolean
  OBJECT = 6,     // object (for JSON, custom types)
}

export type SqlValue = string | number | bigint | boolean | Uint8Array | null | object;
```

### Logical Types

Logical types define the semantics and behavior of values:

```typescript
export interface LogicalType {
  // Identity
  name: string;                              // e.g., "DATE", "INTEGER", "TEXT"
  physicalType: PhysicalType;                // Physical storage representation

  // Validation
  validate?(value: SqlValue): boolean;       // Check if value is valid for this type
  parse?(value: SqlValue): SqlValue;         // Convert/normalize value to canonical form

  // Comparison
  compare?(a: SqlValue, b: SqlValue, collation?: CollationFunction): number;
  supportedCollations?: readonly string[];   // Which collations apply to this type

  // Serialization
  serialize?(value: SqlValue): SqlValue;     // Convert for storage/export
  deserialize?(value: SqlValue): SqlValue;   // Convert from storage

  // Metadata
  isNumeric?: boolean;
  isTextual?: boolean;
  isTemporal?: boolean;
}
```

### Column Schema

Columns reference logical types:

```typescript
export interface ColumnSchema {
  name: string;
  logicalType: LogicalType;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: Expression | null;
  collation?: string;  // Must be in logicalType.supportedCollations
  // ... other fields
}
```

### Scalar Type

Plan nodes use ScalarType which includes the logical type:

```typescript
export interface ScalarType {
  typeClass: 'scalar';
  logicalType: LogicalType;
  nullable: boolean;
  collationName?: string;
  isReadOnly?: boolean;
}
```

This ensures type information flows through the entire planning and execution pipeline.

---

## Built-in Types

### Numeric Types

**INTEGER**
- Physical: `PhysicalType.INTEGER`
- Values: `number` (safe integers) or `bigint`
- Comparison: Numeric ordering
- Collations: None

**REAL**
- Physical: `PhysicalType.REAL`
- Values: `number` (floating point)
- Comparison: Numeric ordering with NaN handling
- Collations: None

**BOOLEAN**
- Physical: `PhysicalType.BOOLEAN`
- Values: `boolean` (true/false)
- Comparison: false < true
- Collations: None

### Text Types

**TEXT**
- Physical: `PhysicalType.TEXT`
- Values: `string`
- Comparison: Collation-based
- Collations: BINARY (default), NOCASE, RTRIM, custom

### Binary Types

**BLOB**
- Physical: `PhysicalType.BLOB`
- Values: `Uint8Array`
- Comparison: Byte-by-byte
- Collations: None

### Temporal Types

**DATE**
- Physical: `PhysicalType.TEXT` (ISO 8601 string: "YYYY-MM-DD")
- Values: ISO date strings
- Validation: Must parse as valid Temporal.PlainDate
- Comparison: Lexicographic (ISO strings sort correctly)
- Collations: None

**TIME**
- Physical: `PhysicalType.TEXT` (ISO 8601 string: "HH:MM:SS.sss")
- Values: ISO time strings
- Validation: Must parse as valid Temporal.PlainTime
- Comparison: Lexicographic
- Collations: None

**DATETIME**
- Physical: `PhysicalType.TEXT` (ISO 8601 string: "YYYY-MM-DDTHH:MM:SS.sss")
- Values: ISO datetime strings
- Validation: Must parse as valid Temporal.PlainDateTime
- Comparison: Lexicographic
- Collations: None

**TIMESPAN**
- Physical: `PhysicalType.TEXT` (ISO 8601 duration string: "PT1H30M", "P1DT2H")
- Values: ISO 8601 duration strings
- Validation: Must parse as valid Temporal.Duration
- Comparison: Total duration comparison (normalized to seconds)
- Collations: None
- Arithmetic: Supports addition/subtraction with DATE, TIME, DATETIME types
- Human-readable parsing: `timespan('1 hour 30 minutes')` → `"PT1H30M"`

### Special Types

**NULL**
- Physical: `PhysicalType.NULL`
- Values: `null` only
- Used for expressions that always return NULL

**JSON** (Future)
- Physical: `PhysicalType.OBJECT`
- Values: JSON-serializable objects/arrays
- Validation: Must be valid JSON
- Comparison: Deep equality, no ordering
- Collations: None

---

## Type Validation

Values are validated at INSERT/UPDATE boundaries:

```typescript
export function validateValue(value: SqlValue, type: LogicalType): SqlValue {
  if (value === null) return null;

  // Type-specific validation
  if (type.validate && !type.validate(value)) {
    throw new QuereusError(
      `Type mismatch: expected ${type.name}, got ${typeof value}`,
      StatusCode.MISMATCH
    );
  }

  // Type-specific parsing/normalization
  if (type.parse) {
    return type.parse(value);
  }

  return value;
}
```

### Explicit Conversion

Use type conversion functions for explicit conversion:

```sql
-- Convert string to integer
SELECT integer('123');

-- Convert timestamp to date
SELECT date(1234567890);

-- Convert string to real
SELECT real('3.14');

-- Invalid conversion throws error
SELECT integer('abc');  -- Error: Type mismatch

-- Conversion functions are just regular scalar functions
SELECT text(42);           -- '42'
SELECT boolean(1);         -- true
SELECT datetime('2024-01-15T10:30:00');
```

**Built-in Conversion Functions**:
- `integer(value)` - Convert to INTEGER
- `real(value)` - Convert to REAL
- `text(value)` - Convert to TEXT
- `boolean(value)` - Convert to BOOLEAN
- `blob(value)` - Convert to BLOB
- `date(value)` - Convert to DATE
- `time(value)` - Convert to TIME
- `datetime(value)` - Convert to DATETIME
- `timespan(value)` - Convert to TIMESPAN (supports ISO 8601 durations and human-readable strings)

Note: CAST syntax is also supported for SQL compatibility, but conversion functions are preferred.

---

## Type-Aware Comparisons

### Comparison Rules

1. **NULL Handling**: NULL compares less than any non-NULL value
2. **Type Matching**: Both values must have the same logical type
3. **Type-Specific Logic**: Each type defines its own comparison semantics
4. **Collation Support**: TEXT types use collation functions

```typescript
export function compareTypedValues(
  a: SqlValue,
  b: SqlValue,
  typeA: LogicalType,
  typeB: LogicalType,
  collation?: CollationFunction
): number {
  // NULL handling
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;

  // Type mismatch error
  if (typeA !== typeB) {
    throw new QuereusError(
      `Type mismatch in comparison: ${typeA.name} vs ${typeB.name}`,
      StatusCode.MISMATCH
    );
  }

  // Use type-specific comparison
  if (typeA.compare) {
    return typeA.compare(a, b, collation);
  }

  // Fallback to default comparison
  return defaultCompare(a, b, typeA.physicalType);
}
```

### Performance Characteristics

Type-aware comparisons enable optimized execution:

- **No runtime type detection**: Type is known at index/sort creation time
- **Direct comparator calls**: Comparator functions are resolved once and reused
- **Type-specific optimizations**: Each type can implement optimal comparison logic

---

## Collations and Types

### Type-Specific Collations

Collations are associated with specific types:

```typescript
const TEXT_TYPE: LogicalType = {
  name: 'TEXT',
  supportedCollations: ['BINARY', 'NOCASE', 'RTRIM'],
  compare: (a, b, collation) => collation(a as string, b as string),
};

const INTEGER_TYPE: LogicalType = {
  name: 'INTEGER',
  supportedCollations: undefined,  // No collations for numeric types
  compare: (a, b) => compareNumbers(a, b),
};
```

### Collation Validation

Schema creation validates collation compatibility:

```typescript
if (column.collation && column.logicalType.supportedCollations) {
  if (!column.logicalType.supportedCollations.includes(column.collation)) {
    throw new QuereusError(
      `Collation ${column.collation} not supported for type ${column.logicalType.name}`,
      StatusCode.ERROR
    );
  }
}
```

### Custom Collations for Custom Types

Plugins can define type-specific collations:

```typescript
const PHONENUMBER_TYPE: LogicalType = {
  name: 'PHONENUMBER',
  physicalType: PhysicalType.TEXT,
  supportedCollations: ['AREA_CODE', 'COUNTRY_CODE'],
  compare: (a, b, collation) => {
    // Custom comparison logic based on collation
  },
};
```

---

## Plugin System

### Registering Custom Types

Plugins can register custom logical types:

```typescript
// Example: UUID type plugin
export default function register(db: Database) {
  return {
    types: [
      {
        type: 'type',
        definition: {
          name: 'UUID',
          physicalType: PhysicalType.TEXT,

          validate: (v) =>
            typeof v === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),

          parse: (v) => {
            if (typeof v === 'string') return v.toLowerCase();
            throw new TypeError('Invalid UUID');
          },

          compare: (a, b) => (a as string).localeCompare(b as string),
        }
      }
    ]
  };
}
```

### Using Custom Types

```sql
-- After loading UUID plugin
CREATE TABLE users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL
);

INSERT INTO users VALUES ('550e8400-e29b-41d4-a716-446655440000', 'Alice');
```

---

## Polymorphic Function Type Inference

Quereus supports polymorphic functions that work over multiple type signatures without duplicating implementations.

### Type Inference API

Functions can define type inference logic at planning time:

```typescript
export interface ScalarFunctionSchema {
  name: string;
  numArgs: number;

  // Option A: Fixed return type
  returnType?: ScalarType;

  // Option B: Type inference function (for polymorphic functions)
  inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;

  // Optional: Validate argument types at planning time
  validateArgTypes?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => boolean;

  implementation: ScalarFunc;
}
```

### Examples

**Simple case: Fixed types**
```typescript
export const sqrtFunc = createScalarFunction({
  name: 'sqrt',
  numArgs: 1,
  returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false }
}, sqrtImpl);
```

**Polymorphic case: Type inference**
```typescript
export const absFunc = createScalarFunction({
  name: 'abs',
  numArgs: 1,
  inferReturnType: (argTypes) => ({
    typeClass: 'scalar',
    logicalType: argTypes[0], // Return same type as input
    nullable: false
  }),
  validateArgTypes: (argTypes) => argTypes[0].isNumeric
}, absImpl);
```

### Built-in Polymorphic Functions

The following built-in functions use type inference:

- **Numeric functions**: `abs()`, `round()`, `nullif()`, `sqrt()`, `floor()`, `ceil()`, `ceiling()`, `clamp()`
- **Common type resolution**: `coalesce()`, `iif()`, `greatest()`, `least()`, `choose()`
- **String functions**: `length()`, `upper()`, `lower()`, `trim()`, `ltrim()`, `rtrim()`, `substr()`, `substring()`, `replace()`, `reverse()`, `lpad()`, `rpad()`, `instr()`
- **Aggregate functions**: `MIN()`, `MAX()`
- **Arithmetic operators**: `+`, `-`, `*`, `/`, `%` with numeric type promotion (INTEGER + INTEGER → INTEGER, INTEGER + REAL → REAL, etc.)

### Type Promotion Rules

Arithmetic operators follow these type promotion rules:

- `INTEGER op INTEGER` → `INTEGER`
- `INTEGER op REAL` → `REAL`
- `REAL op INTEGER` → `REAL`
- `REAL op REAL` → `REAL`

---

## Implementation Files

**Core Type System**:
- `src/types/logical-type.ts` - Core type definitions and interfaces
- `src/types/registry.ts` - Type registry and lookup
- `src/types/builtin-types.ts` - Built-in type definitions (INTEGER, REAL, TEXT, BLOB, BOOLEAN, DATE, TIME, DATETIME, TIMESPAN)
- `src/types/temporal-types.ts` - Temporal type implementations
- `src/func/builtins/conversion.ts` - Type conversion functions

**Type Inference**:
- `src/common/type-inference.ts` - Type inference utilities (`findCommonType`, `promoteNumericTypes`)
- `src/planner/build-function-call.ts` - Planning-time type inference for function calls

---

## Future Enhancements

### Comparison System Optimization

**Goal**: Pre-resolve comparators at index/sort creation time to eliminate runtime type detection.

**Current**: Comparisons use `compareSqlValues()` which performs runtime type detection on every call.

**Proposed**: Pre-create type-specific comparators at index creation time and store them in index metadata.

**Performance Target**: 2-3x speedup for index operations, joins, and sorts.

### JSON Type

**Goal**: Native JSON type with object storage.

**Considerations**:
- JSON schema validation (optional)
- JSONPath queries
- Indexing JSON properties
- Performance vs TEXT-based JSON
