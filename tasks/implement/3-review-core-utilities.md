---
description: Comprehensive review of utility modules (comparison, coercion, helpers)
dependencies: none
priority: 3
---

# Utilities Subsystem Review Plan

This document provides a comprehensive adversarial review plan for the utility modules in the Quereus core package.

## 1. Scope

The utilities subsystem includes:

- `src/util/comparison.ts` - Value comparison with affinity rules
- `src/util/coercion.ts` - Type coercion utilities
- `src/util/debug.ts` - Debug logging utilities
- `src/util/hermes.ts` - Hermes JS engine compatibility
- `src/util/plugin-helper.ts` - Plugin registration helpers
- `src/util/log.ts` - Logging infrastructure
- `src/util/index.ts` - Public exports

Additionally related utilities in:
- `src/common/errors.ts` - Error handling utilities
- `src/common/types.ts` - Type definitions (covered in types review)
- `src/runtime/utils.ts` - Runtime helpers

## 2. Architecture Assessment

### Comparison Module (`comparison.ts`)

**Strengths:**
- Implements SQLite-compatible type affinity rules
- Supports multiple collation sequences
- Handles NULL comparison semantics

**Concerns:**
- Complex function with multiple responsibilities
- Affinity determination interleaved with comparison logic
- Some edge cases may differ from SQLite behavior

### Coercion Module (`coercion.ts`)

**Strengths:**
- Comprehensive type conversion coverage
- Handles edge cases (empty strings, special numbers)

**Concerns:**
- Large function handling all conversions
- Date parsing logic may be incomplete
- Error handling inconsistent (some return null, some throw)

### Debug Module (`debug.ts`)

**Strengths:**
- Environment-based debug flag
- Clean API for conditional logging

**Concerns:**
- Limited functionality compared to debug libraries
- No namespacing or filtering support

### Plugin Helper (`plugin-helper.ts`)

**Strengths:**
- Simplifies plugin registration pattern
- Handles module/function registration

**Concerns:**
- Tightly coupled to specific plugin interfaces
- Limited documentation

## 3. Specific Files and Line Ranges to Review

### High Priority

**`src/util/comparison.ts`** (~200 lines)
- Lines 1-50: Main `compareValues()` function
- Lines 50-100: Type affinity resolution
- Lines 100-150: Type-specific comparison logic
- Lines 150-200: Collation handling

**Issues to investigate:**
- NULL handling in comparisons (should be undefined/unknown, not -1/0/1)
- Affinity rules matching SQLite exactly
- Blob comparison ordering
- Numeric string comparison (e.g., "10" vs "9")

**`src/util/coercion.ts`** (~250 lines)
- Lines 1-80: `coerceToType()` main entry
- Lines 80-150: Numeric coercion
- Lines 150-200: String/text coercion
- Lines 200-250: Blob and datetime coercion

**Issues to investigate:**
- Scientific notation parsing
- Date format handling (ISO, SQLite, custom)
- Blob hex encoding/decoding
- Boolean coercion rules

### Medium Priority

**`src/util/debug.ts`** (~50 lines)
- Entire file: Debug flag and utilities
- Consider expansion or replacement

**`src/util/plugin-helper.ts`** (~100 lines)
- Lines 1-50: `registerPluginModule()` 
- Lines 50-100: `registerPluginFunctions()`

**`src/util/log.ts`** (~80 lines)
- Logging level configuration
- Log output formatting

**`src/runtime/utils.ts`** (~180 lines)
- Lines 1-80: Connection management utilities
- Lines 80-130: Type checking helpers
- Lines 130-180: Hermes compatibility checks

### Lower Priority

**`src/util/hermes.ts`** (~30 lines)
- Hermes engine detection
- Platform-specific workarounds

**`src/util/index.ts`** (~20 lines)
- Export organization
- Public API surface

**`src/common/errors.ts`** (~150 lines)
- Error class definitions
- Error factory functions
- Status code mapping

## 4. DRY Violations and Code Quality Issues

### Repeated Patterns

1. **Type Checking Pattern** (multiple files)
   ```typescript
   if (typeof value === 'number') { ... }
   else if (typeof value === 'string') { ... }
   else if (value instanceof Uint8Array) { ... }
   else if (value === null) { ... }
   ```
   **Found in**: comparison.ts, coercion.ts, runtime/utils.ts
   **Recommendation**: Create `TypeSwitch` or exhaustive type guard

2. **NULL Early Return** (many locations)
   ```typescript
   if (a === null || b === null) return ...;
   ```
   **Recommendation**: Create `withNonNull()` wrapper

3. **Debug Logging Pattern**
   ```typescript
   if (DEBUG) console.log(...);
   ```
   **Recommendation**: Use structured logger with namespaces

### Large Functions

1. **`compareValues()`** (~80 lines)
   - Mixed responsibilities: affinity, comparison, collation
   - Should decompose into:
     - `determineAffinity(a, b)`
     - `compareWithAffinity(a, b, affinity)`
     - `applyCollation(result, collation)`

2. **`coerceToType()`** (~150 lines)
   - Single function handling all conversions
   - Should split by target type

### Error Handling Inconsistencies

**In coercion.ts:**
- Some invalid inputs return `null`
- Some throw errors
- No clear pattern for which

**Recommendation:** Establish convention:
- Invalid input → return `null` with optional warning
- Impossible conversion → throw `QuereusError`

## 5. Test Coverage Gaps

### Missing Tests for comparison.ts

```typescript
// test/util/comparison.spec.ts
describe('compareValues', () => {
  describe('same type comparisons', () => {
    it('compares integers correctly')
    it('compares reals with precision')
    it('compares strings with default collation')
    it('compares blobs byte-by-byte')
  })
  
  describe('NULL handling', () => {
    it('returns undefined for NULL comparisons') // three-valued logic
    it('handles NULL vs non-NULL')
    it('handles NULL vs NULL')
  })
  
  describe('affinity rules', () => {
    it('applies NUMERIC affinity: "123" vs 123')
    it('applies TEXT affinity when one is text')
    it('follows SQLite type ordering')
  })
  
  describe('collation', () => {
    it('applies NOCASE correctly')
    it('applies BINARY correctly')
    it('applies RTRIM correctly')
  })
  
  describe('edge cases', () => {
    it('handles Infinity')
    it('handles NaN')
    it('handles empty strings')
    it('handles empty blobs')
    it('handles very long strings')
  })
})
```

### Missing Tests for coercion.ts

```typescript
// test/util/coercion.spec.ts
describe('coerceToType', () => {
  describe('to INTEGER', () => {
    it('converts numeric strings')
    it('truncates reals')
    it('handles scientific notation')
    it('rejects non-numeric strings')
    it('handles MAX_SAFE_INTEGER boundary')
  })
  
  describe('to REAL', () => {
    it('converts integers')
    it('parses decimal strings')
    it('handles special values (Inf, NaN)')
  })
  
  describe('to TEXT', () => {
    it('converts numbers to strings')
    it('converts blobs to hex')
  })
  
  describe('to BLOB', () => {
    it('parses hex strings')
    it('handles case insensitivity')
    it('rejects invalid hex')
  })
  
  describe('to DATETIME', () => {
    it('parses ISO 8601')
    it('parses SQLite formats')
    it('handles timezones')
  })
})
```

### Missing Tests for Other Utilities

```typescript
// test/util/debug.spec.ts
describe('debug utilities', () => {
  it('respects DEBUG environment variable')
  it('formats debug output correctly')
})

// test/util/plugin-helper.spec.ts
describe('plugin helpers', () => {
  it('registers module correctly')
  it('registers functions correctly')
  it('handles registration errors')
})

// test/util/log.spec.ts
describe('logging', () => {
  it('respects log levels')
  it('formats messages correctly')
  it('handles structured data')
})
```

## 6. Documentation Gaps

### Missing Documentation

1. **API Reference** for each utility module
   - Function signatures with JSDoc
   - Parameter descriptions
   - Return value semantics
   - Error conditions

2. **Usage Examples**
   - Common patterns for comparison
   - Coercion edge cases
   - Debug logging best practices

3. **SQLite Compatibility Notes**
   - Where behavior matches SQLite
   - Intentional differences
   - Migration considerations

4. **Code Comments**
   - Algorithm explanations
   - Edge case handling rationale
   - Performance considerations

## 7. Refactoring Candidates

### High Priority

1. **Decompose `compareValues()`**
   ```typescript
   // Before: monolithic function
   export function compareValues(a, b, collation?): number
   
   // After: composed functions
   export function compareValues(a, b, collation?): number {
     const affinity = determineAffinity(a, b);
     const coercedA = applyAffinity(a, affinity);
     const coercedB = applyAffinity(b, affinity);
     const result = compareByType(coercedA, coercedB);
     return applyCollation(result, collation);
   }
   ```

2. **Split Coercion by Target Type**
   ```typescript
   // Before: single large function
   export function coerceToType(value, targetType)
   
   // After: type-specific functions
   export function coerceToInteger(value): number | null
   export function coerceToReal(value): number | null
   export function coerceToText(value): string | null
   export function coerceToBlob(value): Uint8Array | null
   ```

3. **Create Type Guard Utilities**
   ```typescript
   // New file: src/util/type-guards.ts
   export function isInteger(v: SqlValue): v is number
   export function isText(v: SqlValue): v is string
   export function isBlob(v: SqlValue): v is Uint8Array
   export function getPhysicalType(v: SqlValue): PhysicalType
   ```

### Medium Priority

4. **Improve Debug Module**
   ```typescript
   // Enhanced debug with namespaces
   const debug = createDebugger('quereus:parser');
   debug('parsing expression', expr);
   ```

5. **Standardize Error Utilities**
   ```typescript
   // Unified error creation
   export function createError(code: StatusCode, message: string, context?: object): QuereusError
   export function wrapError(error: Error, context: string): QuereusError
   ```

6. **Add Validation Utilities**
   ```typescript
   // New file: src/util/validation.ts
   export function validateNonNull<T>(value: T | null, name: string): T
   export function validateType(value: SqlValue, expected: LogicalType): void
   export function validateRange(value: number, min: number, max: number): void
   ```

### Lower Priority

7. **Logging Enhancement**
   - Structured logging with context
   - Log rotation support
   - Performance logging helpers

8. **Plugin Helper Expansion**
   - More registration patterns
   - Validation of plugin manifests
   - Plugin lifecycle hooks

## 8. Potential Bugs

### High Probability

1. **Comparison NULL Semantics**
   - Current: Returns -1, 0, or 1 for NULL comparisons
   - Should: Return undefined or use three-valued logic
   - Impact: Incorrect sort ordering with NULLs

2. **Scientific Notation Parsing**
   - May not handle all valid formats (e.g., `1e+10`, `1E10`)
   - May accept invalid formats

3. **Blob Hex Parsing**
   - Case sensitivity issues
   - Odd-length hex string handling
   - Non-ASCII character handling

### Medium Probability

4. **Floating Point Comparison**
   - Equality comparison with precision loss
   - -0 vs +0 handling
   - NaN comparison semantics

5. **Date Parsing Edge Cases**
   - Ambiguous formats
   - Timezone handling
   - Leap seconds

6. **Collation Edge Cases**
   - Unicode normalization
   - Locale-specific sorting
   - Multi-character collation elements

## 9. TODO

### Phase 1: Critical Fixes
- [ ] Fix NULL comparison semantics (three-valued logic)
- [ ] Standardize error handling (null vs throw)
- [ ] Add input validation to coercion functions
- [ ] Document SQLite compatibility status

### Phase 2: Refactoring
- [ ] Decompose `compareValues()` into focused functions
- [ ] Split coercion by target type
- [ ] Create type guard utilities
- [ ] Extract affinity resolution logic

### Phase 3: Test Coverage
- [ ] Create comprehensive comparison tests
- [ ] Create comprehensive coercion tests
- [ ] Add edge case coverage (NULL, NaN, Infinity)
- [ ] Add SQLite compatibility tests
- [ ] Add performance benchmarks

### Phase 4: Documentation
- [ ] Add JSDoc to all exported functions
- [ ] Create usage examples
- [ ] Document SQLite compatibility
- [ ] Add inline algorithm comments

### Phase 5: Enhancements
- [ ] Improve debug module with namespaces
- [ ] Add validation utilities
- [ ] Enhance logging infrastructure
- [ ] Expand plugin helpers

### Phase 6: Validation
- [ ] Review all comparison edge cases
- [ ] Verify coercion matches SQLite
- [ ] Test with SQLite side-by-side
- [ ] Performance profiling
