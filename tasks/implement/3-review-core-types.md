---
description: Comprehensive review of type system (logical types, physical types, coercion)
dependencies: none
priority: 3
---

# Type System Review Plan

This document provides a comprehensive adversarial review plan for the Quereus type system, covering logical types, physical types, type coercion, comparisons, and SQL VALUES handling.

## 1. Architecture Overview

The type system is split across several key areas:

### Core Type Definitions (`src/common/types.ts`)
- `SqlValue` - Union type for runtime values (text, integer, real, blob, null)
- `LogicalType` - Rich type enumeration (INTEGER, TEXT, REAL, BLOB, NULL, BOOLEAN, DATETIME variants, JSON, etc.)
- `PhysicalType` - Storage-level types (INTEGER, REAL, TEXT, BLOB, NULL)
- `RelationType` - Row types for relational operators

### Type Utilities
- `src/util/coercion.ts` - Type coercion functions
- `src/util/comparison.ts` - Value comparison with affinity rules
- `src/util/types.ts` - Type inference and compatibility utilities
- `src/runtime/utils.ts` - Runtime type helpers

### Integration Points
- Parser: Literal type inference
- Planner: Expression type propagation
- Runtime: Value coercion and comparison
- Schema: Column type definitions
- Virtual Tables: External type mapping

## 2. Specific Files and Line Ranges to Review

### High Priority Files

**`src/common/types.ts`** (~700 lines)
- Lines 1-100: SqlValue, LogicalType, PhysicalType definitions
- Lines 100-200: RelationType and Attribute definitions
- Lines 400-500: Type mapping utilities
- **Issues to check**:
  - Completeness of LogicalType enum vs actual SQL types
  - Consistency between LogicalType and PhysicalType mappings
  - Type guard functions for narrowing

**`src/util/coercion.ts`** (~300 lines)
- Lines 1-100: `coerceToType()` main function
- Lines 100-200: String parsing (numbers, dates, bools)
- Lines 200-300: Cross-type coercions
- **Issues to check**:
  - Edge cases in number parsing (NaN, Infinity, scientific notation)
  - Date/time string format variations
  - Blob encoding/decoding consistency
  - Loss of precision in real→integer

**`src/util/comparison.ts`** (~350 lines)
- Lines 1-100: `compareValues()` with affinity resolution
- Lines 100-200: Type-specific comparators
- Lines 200-300: Collation handling
- Lines 300-350: NULL handling in comparisons
- **Issues to check**:
  - SQLite affinity rules compliance
  - NULL comparison semantics (three-valued logic)
  - Cross-type comparison ordering
  - Collation application consistency

**`src/util/types.ts`** (~200 lines)
- Lines 1-80: Type inference from literals
- Lines 80-150: Type compatibility checking
- Lines 150-200: Type unification for expressions
- **Issues to check**:
  - Literal type inference edge cases
  - Type compatibility rules for operations
  - Type widening in UNION operations

### Medium Priority Files

**`src/runtime/utils.ts`** (~180 lines)
- Runtime type checking and conversion
- Connection management utilities
- **Issues to check**:
  - Runtime type validation completeness
  - Error messages for type mismatches

**`src/parser/parser.ts`** (type-related sections)
- Lines ~1200-1300: Literal parsing
- Lines ~2500-2700: CAST expression parsing
- **Issues to check**:
  - Literal type assignment consistency
  - CAST target type parsing

**`src/planner/type-utils.ts`** (~150 lines)
- Expression type propagation
- Type unification for set operations
- **Issues to check**:
  - Type inference through complex expressions
  - NULL type handling in expressions

## 3. Code Quality Issues

### DRY Violations

1. **Type Checking Pattern** (multiple files)
   ```typescript
   // Found in: coercion.ts, comparison.ts, types.ts
   if (typeof value === 'number') { ... }
   else if (typeof value === 'string') { ... }
   else if (value instanceof Uint8Array) { ... }
   ```
   **Recommendation**: Create `getPhysicalType(value: SqlValue): PhysicalType` utility

2. **NULL Handling** (many locations)
   ```typescript
   // Repeated pattern
   if (value === null) return null;
   ```
   **Recommendation**: Create `withNullCheck<T>(fn: (v: NonNullable<SqlValue>) => T)` wrapper

3. **Affinity Resolution** (comparison.ts, coercion.ts)
   - Similar affinity determination logic in multiple places
   **Recommendation**: Consolidate into `resolveAffinity(type1, type2): TypeAffinity`

4. **Date Parsing** (coercion.ts, datetime.ts)
   - Date string parsing duplicated
   **Recommendation**: Single date parsing utility in `datetime-utils.ts`

### Large Functions

1. **`coerceToType()`** (~100 lines)
   - Handles all type conversions in one function
   - Complex switch/if chains
   **Recommendation**: Split into `coerceToInteger()`, `coerceToText()`, etc.

2. **`compareValues()`** (~80 lines)
   - Multiple responsibility (affinity + comparison + null)
   **Recommendation**: Decompose into focused functions

### Type Safety Issues

1. **`SqlValue` Union Type**
   - `number | string | Uint8Array | bigint | null`
   - Easy to miss handling a variant
   **Recommendation**: Add exhaustiveness checks, type guards

2. **Type Assertions**
   - Several `as` casts that could fail at runtime
   **Recommendation**: Replace with type guards

3. **Missing Type Narrowing**
   - Some functions don't properly narrow types after checks
   **Recommendation**: Use discriminated unions or type predicates

## 4. Test Coverage Gaps

### Existing Test Locations
- `test/logic/*.sqllogic` - Integration tests via SQL
- Need to verify: dedicated unit tests for type utilities

### Missing Unit Tests

**coercion.ts**
```typescript
// Test file: test/util/coercion.spec.ts
describe('coerceToType', () => {
  describe('to INTEGER', () => {
    it('should convert exact strings: "123" → 123')
    it('should handle scientific notation: "1e5" → 100000')
    it('should truncate reals: 1.9 → 1')
    it('should handle negative: "-42" → -42')
    it('should handle bigint within safe range')
    it('should reject non-numeric strings → null or error?')
    it('should handle MAX_SAFE_INTEGER edge')
    it('should handle Infinity → ?')
    it('should handle NaN → ?')
  })
  
  describe('to REAL', () => {
    it('should convert integer strings: "123" → 123.0')
    it('should handle scientific notation: "1.5e-10"')
    it('should handle special values: "Infinity", "-Infinity", "NaN"')
    it('should handle precision edge cases')
  })
  
  describe('to TEXT', () => {
    it('should convert integers: 123 → "123"')
    it('should convert reals: 1.5 → "1.5"')
    it('should convert blobs: Uint8Array → hex string?')
    it('should handle boolean-like: true → "1" or "true"?')
  })
  
  describe('to BLOB', () => {
    it('should convert hex strings: "ABCD" → Uint8Array')
    it('should handle odd-length hex strings')
    it('should handle non-hex strings → error?')
    it('should pass through Uint8Array unchanged')
  })
  
  describe('to BOOLEAN', () => {
    it('should convert 0 → false, non-0 → true')
    it('should convert "true"/"false" strings')
    it('should convert "0"/"1" strings')
  })
  
  describe('to DATETIME', () => {
    it('should parse ISO 8601 formats')
    it('should parse SQLite date formats')
    it('should handle timezone offsets')
    it('should handle date-only vs datetime')
  })
})
```

**comparison.ts**
```typescript
// Test file: test/util/comparison.spec.ts
describe('compareValues', () => {
  describe('same types', () => {
    it('should compare integers correctly')
    it('should compare reals with precision')
    it('should compare strings with collation')
    it('should compare blobs byte-by-byte')
    it('should handle NULL comparisons (three-valued)')
  })
  
  describe('cross-type with affinity', () => {
    it('should apply NUMERIC affinity: "123" vs 123')
    it('should apply TEXT affinity: 123 vs "123"')
    it('should handle BLOB affinity')
    it('should follow SQLite type ordering: NULL < INT < REAL < TEXT < BLOB')
  })
  
  describe('collation', () => {
    it('should apply NOCASE collation')
    it('should apply BINARY collation')
    it('should apply RTRIM collation')
    it('should handle custom collations')
  })
  
  describe('edge cases', () => {
    it('should compare -0 and 0 as equal')
    it('should handle NaN comparisons')
    it('should handle Infinity comparisons')
    it('should compare empty string vs NULL')
    it('should compare empty blob vs NULL')
  })
})
```

**types.ts**
```typescript
// Test file: test/util/types.spec.ts
describe('type utilities', () => {
  describe('inferLiteralType', () => {
    it('should infer INTEGER from integer literals')
    it('should infer REAL from decimal literals')
    it('should infer TEXT from quoted strings')
    it('should infer BLOB from X\'...\'')
    it('should infer NULL from NULL keyword')
    it('should infer BOOLEAN from TRUE/FALSE')
  })
  
  describe('typeCompatible', () => {
    it('should allow INTEGER → REAL promotion')
    it('should allow TEXT affinity for any type')
    it('should reject BLOB → numeric')
    it('should handle NULL compatibility')
  })
  
  describe('unifyTypes', () => {
    it('should find common type for UNION')
    it('should widen INTEGER + REAL → REAL')
    it('should handle mixed NULL types')
  })
})
```

### Integration Tests Needed

```typescript
// Test file: test/types/integration.spec.ts
describe('type system integration', () => {
  describe('schema type enforcement', () => {
    it('should reject invalid type for strict column')
    it('should coerce values for affinity column')
    it('should store exact type for ANY column')
  })
  
  describe('expression type propagation', () => {
    it('should infer correct type through operators')
    it('should propagate NULL type correctly')
    it('should handle CAST expressions')
    it('should infer aggregate result types')
  })
  
  describe('cross-layer consistency', () => {
    it('should preserve type through parser→planner→runtime')
    it('should maintain type through VTab boundaries')
    it('should round-trip through serialization')
  })
})
```

### SQLite Compatibility Tests

```typescript
// Test file: test/types/sqlite-compat.spec.ts
describe('SQLite type compatibility', () => {
  // Run same queries against SQLite and Quereus
  it('should match SQLite affinity rules')
  it('should match SQLite comparison ordering')
  it('should match SQLite coercion behavior')
  it('should match SQLite NULL handling')
  // Document any intentional differences
})
```

## 5. Documentation Gaps

### Missing Documentation

1. **Type System Overview** (`docs/types.md`)
   - Explain LogicalType vs PhysicalType distinction
   - Document type hierarchy and conversions
   - Show type affinity rules
   - Explain datetime type family

2. **Coercion Rules** (in `docs/types.md` or separate)
   - Complete coercion matrix
   - Implicit vs explicit coercion
   - Edge cases and error handling

3. **Comparison Semantics** (in `docs/types.md`)
   - Three-valued logic for NULLs
   - Cross-type comparison ordering
   - Collation effects

4. **SQLite Compatibility Notes**
   - Where we match SQLite exactly
   - Where we intentionally differ
   - Migration guidance

### Code Comments Needed

- `types.ts`: JSDoc for all type definitions
- `coercion.ts`: Document each coercion path
- `comparison.ts`: Document affinity resolution algorithm
- All utilities: Note SQLite compatibility status

## 6. Refactoring Candidates

### High Priority

1. **Extract Type Guards** (`src/common/type-guards.ts`)
   ```typescript
   export function isInteger(value: SqlValue): value is number { ... }
   export function isText(value: SqlValue): value is string { ... }
   export function isBlob(value: SqlValue): value is Uint8Array { ... }
   export function getPhysicalType(value: SqlValue): PhysicalType { ... }
   ```

2. **Consolidate Affinity Resolution**
   ```typescript
   // src/util/affinity.ts
   export function resolveAffinity(type1: LogicalType, type2: LogicalType): TypeAffinity
   export function applyAffinity(value: SqlValue, affinity: TypeAffinity): SqlValue
   ```

3. **Split Coercion by Target Type**
   ```typescript
   // Instead of one large coerceToType()
   export function coerceToInteger(value: SqlValue): number | null
   export function coerceToReal(value: SqlValue): number | null
   export function coerceToText(value: SqlValue): string | null
   export function coerceToBlob(value: SqlValue): Uint8Array | null
   ```

### Medium Priority

4. **Type Validation Layer**
   ```typescript
   // src/util/type-validation.ts
   export function validateType(value: SqlValue, expectedType: LogicalType): ValidationResult
   export function assertType(value: SqlValue, expectedType: LogicalType): asserts value
   ```

5. **Datetime Type Utilities**
   ```typescript
   // src/util/datetime-types.ts
   // Consolidate date type handling from coercion.ts and datetime.ts
   export function parseDatetime(value: string, format?: string): DatetimeValue
   export function formatDatetime(value: DatetimeValue, format: string): string
   ```

### Lower Priority

6. **Type Metadata Registry**
   ```typescript
   // Store type properties (size, affinity rules, coercion support)
   const TYPE_METADATA: Record<LogicalType, TypeMetadata> = { ... }
   ```

7. **Custom Type Support**
   - Allow plugins to register custom types
   - Define type extension points

## 7. Potential Bugs to Investigate

### High Probability

1. **Integer Overflow** (`coercion.ts`)
   - Converting large strings to integer
   - Arithmetic with bigint edge cases
   - Need to verify MAX_SAFE_INTEGER handling

2. **Floating Point Precision** (`comparison.ts`)
   - Equality comparison of reals
   - Sorting stability with near-equal values

3. **Date Parsing Edge Cases** (`coercion.ts`)
   - Ambiguous date formats (01/02/03)
   - Timezone handling across DST boundaries
   - Year 2038 problem for 32-bit timestamps

### Medium Probability

4. **Collation Consistency**
   - NOCASE with Unicode characters
   - RTRIM behavior with tabs/newlines
   - Custom collation registration

5. **Blob Handling**
   - Hex string parsing (case sensitivity)
   - Empty blob vs NULL distinction
   - Binary comparison with different lengths

6. **NULL Propagation**
   - Three-valued logic in all operators
   - Aggregate NULL handling (COUNT vs SUM)
   - DISTINCT with NULL values

## 8. TODO

### Phase 1: Foundation
- [ ] Create dedicated type guard utilities (`type-guards.ts`)
- [ ] Consolidate affinity resolution logic (`affinity.ts`)
- [ ] Add exhaustiveness checks for SqlValue handling
- [ ] Replace type assertions with proper guards

### Phase 2: Coercion Improvements
- [ ] Split `coerceToType()` into type-specific functions
- [ ] Add comprehensive input validation
- [ ] Document all coercion paths with examples
- [ ] Add edge case handling (NaN, Infinity, etc.)
- [ ] Consolidate date parsing logic

### Phase 3: Comparison Improvements
- [ ] Verify SQLite affinity rules compliance
- [ ] Add floating-point comparison tolerance option
- [ ] Document NULL comparison semantics
- [ ] Add collation extensibility

### Phase 4: Test Coverage
- [ ] Create `test/util/coercion.spec.ts` with edge cases
- [ ] Create `test/util/comparison.spec.ts` with affinity tests
- [ ] Create `test/util/types.spec.ts` with inference tests
- [ ] Create SQLite compatibility test suite
- [ ] Add cross-layer integration tests
- [ ] Add fuzzing for type coercion

### Phase 5: Documentation
- [ ] Create comprehensive `docs/types.md`
- [ ] Document SQLite compatibility matrix
- [ ] Add JSDoc to all type utilities
- [ ] Create type migration guide

### Phase 6: Advanced Features
- [ ] Add type validation layer
- [ ] Implement custom type registration
- [ ] Add type metadata registry
- [ ] Profile and optimize hot paths
