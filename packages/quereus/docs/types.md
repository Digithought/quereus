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

### Performance Benefits

Type-aware comparisons eliminate runtime type detection:

```typescript
// OLD: Runtime type detection on every comparison
function compareSqlValuesFast(a: SqlValue, b: SqlValue): number {
  const classA = getStorageClass(a);  // Expensive!
  const classB = getStorageClass(b);  // Expensive!
  // ...
}

// NEW: Type known at index/sort creation time
const comparator = column.logicalType.compare ?? getDefaultComparator(column.logicalType);
// comparator is called directly, no type detection needed
```

**Estimated speedup**: 2-3x for index operations, joins, and sorts.

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

## Implementation Phases

### Phase 1: Type System Foundation

**Goal**: Establish core type infrastructure

**New Files**:
- `src/types/logical-type.ts` - Core type definitions and interfaces
- `src/types/registry.ts` - Type registry and lookup
- `src/types/builtin-types.ts` - Built-in type definitions (INTEGER, REAL, TEXT, BLOB, BOOLEAN)
- `src/types/validation.ts` - Type validation utilities

**Modified Files**:
- `src/common/types.ts` - Extend `SqlValue` to include `object`
- `src/schema/column.ts` - Add `logicalType` field, keep `affinity` for transition
- `src/schema/table.ts` - Update schema creation to use logical types

**Deliverables**:
- Type registry with built-in types
- Column schema supports logical types
- Type validation framework in place

### Phase 2: Comparison System Refactor

**Goal**: Make comparisons type-aware and eliminate runtime type detection

**Modified Files**:
- `src/util/comparison.ts` - Add `compareTypedValues()` function
- `src/vtab/memory/index.ts` - Use type-aware comparisons in indexes
- `src/vtab/memory/utils/primary-key.ts` - Type-aware primary key comparison
- `src/vtab/memory/layer/base.ts` - Pre-create type-specific comparators

**Key Changes**:
- Add `compareTypedValues()` that takes logical types as parameters
- Pre-resolve comparators at index/sort creation time
- Eliminate `getStorageClass()` calls in hot paths

**Performance Target**: 2-3x speedup for index operations

### Phase 3: Validation Integration

**Goal**: Enforce type validation at INSERT/UPDATE boundaries

**Modified Files**:
- `src/runtime/emit/insert.ts` - Add type validation before storage
- `src/runtime/emit/update.ts` - Add type validation
- `src/util/affinity.ts` - Deprecate affinity functions, redirect to type validation

**Key Changes**:
- Call `validateValue()` on all inserted/updated values
- Throw `StatusCode.MISMATCH` errors for type violations
- Remove coercion logic from INSERT/UPDATE paths

**Breaking Change**: Queries that relied on implicit coercion will fail

### Phase 4: Temporal Types & Conversion Functions

**Goal**: Implement native DATE, TIME, DATETIME types and type conversion functions

**New Files**:
- `src/types/temporal-types.ts` - Temporal type definitions
- `src/func/builtins/conversion.ts` - Type conversion functions

**Modified Files**:
- `src/func/builtins/datetime.ts` - Update `date()`, `time()`, `datetime()` to be conversion functions
- `src/func/builtins/index.ts` - Register conversion functions
- `src/common/type-inference.ts` - Recognize DATE/TIME/DATETIME keywords
- `src/parser/parser.ts` - Parse temporal type names

**Implementation**:
```typescript
export const DATE_TYPE: LogicalType = {
  name: 'DATE',
  physicalType: PhysicalType.TEXT,
  isTemporal: true,

  validate: (v) => {
    if (typeof v !== 'string') return false;
    try {
      Temporal.PlainDate.from(v);
      return true;
    } catch {
      return false;
    }
  },

  parse: (v) => {
    if (typeof v === 'string') {
      const date = Temporal.PlainDate.from(v);
      return date.toString(); // ISO 8601 format
    }
    if (typeof v === 'number') {
      // Unix timestamp
      const instant = Temporal.Instant.fromEpochSeconds(v);
      return instant.toZonedDateTimeISO('UTC').toPlainDate().toString();
    }
    throw new TypeError('Cannot convert to DATE');
  },

  compare: (a, b) => (a as string).localeCompare(b as string),
};
```

**Conversion Functions**:
```typescript
// src/func/builtins/conversion.ts
export const INTEGER_FUNC: ScalarFunction = {
  name: 'integer',
  deterministic: true,
  execute: (args) => {
    const value = args[0];
    if (value === null) return null;

    if (typeof value === 'number') return Math.trunc(value);
    if (typeof value === 'bigint') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed)) throw new QuereusError('Cannot convert to INTEGER', StatusCode.MISMATCH);
      return parsed;
    }
    throw new QuereusError('Cannot convert to INTEGER', StatusCode.MISMATCH);
  }
};

// Similar for real(), text(), boolean(), date(), time(), datetime()
```

### Phase 5: Plugin System

**Goal**: Enable custom type registration via plugins

**New Files**:
- `src/types/plugin-interface.ts` - Type plugin interface

**Modified Files**:
- `src/util/plugin-loader.ts` - Support type plugins
- `src/vtab/manifest.ts` - Add `TypePluginInfo`
- `src/core/database.ts` - Add `registerType()` method
- `src/index.ts` - Export type plugin interfaces

**Plugin Interface**:
```typescript
export interface TypePluginInfo {
  type: 'type';
  definition: LogicalType;
}

export interface PluginRegistrations {
  vtables?: VTablePluginInfo[];
  functions?: FunctionPluginInfo[];
  collations?: CollationPluginInfo[];
  types?: TypePluginInfo[];  // NEW
}
```

### Phase 6: JSON Type (Future)

**Goal**: Native JSON type with object storage

**New Files**:
- `src/types/json-type.ts` - JSON type definition

**Modified Files**:
- `src/func/builtins/json.ts` - Update to work with native JSON type
- `src/util/comparison.ts` - Add JSON comparison (deep equality)
- `src/util/serialization.ts` - Handle JSON serialization

**Considerations**:
- JSON schema validation (optional)
- JSONPath queries
- Indexing JSON properties
- Performance vs TEXT-based JSON

---

## Code Cleanup Opportunities

### 1. Comparison Performance

**Current**: Runtime type detection on every comparison
```typescript
function compareSqlValuesFast(a: SqlValue, b: SqlValue): number {
  const classA = getStorageClass(a);  // Called millions of times
  const classB = getStorageClass(b);
  // ...
}
```

**New**: Type known at creation time
```typescript
// At index creation
const comparator = column.logicalType.compare ?? getDefaultComparator(column.logicalType);

// At comparison time (no type detection!)
const result = comparator(a, b);
```

**Impact**: 2-3x speedup for index operations, joins, sorts

### 2. Coercion Elimination

**Files to simplify**:
- `src/util/coercion.ts` - Can be removed entirely
- `src/util/affinity.ts` - Deprecated, replaced by type validation
- `src/runtime/emit/binary.ts` - Remove `coerceForComparison()` calls
- `src/runtime/emit/between.ts` - Remove coercion logic

**Benefit**: Simpler codebase, predictable behavior

### 3. Type Inference Simplification

**Current**: String matching on type names
```typescript
export function getAffinity(typeName: string | undefined): SqlDataType {
  if (!typeName) return SqlDataType.BLOB;
  const typeUpper = typeName.toUpperCase();
  if (typeUpper.includes('INT')) return SqlDataType.INTEGER;
  // ... more string matching
}
```

**New**: Direct registry lookup
```typescript
export function getLogicalType(typeName: string): LogicalType {
  return typeRegistry.get(typeName.toUpperCase()) ?? BLOB_TYPE;
}
```

**Benefit**: Faster, more accurate, extensible

### 4. Index Comparison Optimization

**Current** (`src/vtab/memory/index.ts:98`):
```typescript
const comparison = compareSqlValues(arrA[i], arrB[i], specCol.collation || 'BINARY');
```

**New**:
```typescript
// At index creation
const comparators = specColumns.map(sc => {
  const column = tableSchema.columns[sc.index];
  const collation = sc.collation ? resolveCollation(sc.collation) : undefined;
  return column.logicalType.compare
    ? (a, b) => column.logicalType.compare!(a, b, collation)
    : getDefaultComparator(column.logicalType.physicalType);
});

// At comparison time
const comparison = comparators[i](arrA[i], arrB[i]);
```

**Benefit**: No collation resolution, no type detection per comparison

### 5. Primary Key Comparison

**Current** (`src/vtab/memory/utils/primary-key.ts`):
```typescript
const compare = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
  return compareSqlValuesFast(a as SqlValue, b as SqlValue, collationFunc) * descMultiplier;
};
```

**New**:
```typescript
const pkColumn = schema.columns[pkColIndex];
const baseCompare = pkColumn.logicalType.compare ?? getDefaultComparator(pkColumn.logicalType.physicalType);
const compare = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
  return baseCompare(a as SqlValue, b as SqlValue, collationFunc) * descMultiplier;
};
```

**Benefit**: Type-specific comparison, no runtime dispatch
