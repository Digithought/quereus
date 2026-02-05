---
description: Comprehensive review of functions subsystem (builtins, aggregates, UDFs)
dependencies: none
priority: 3
---

# Functions Subsystem Review Plan

This document provides a comprehensive adversarial review plan for the functions subsystem, covering builtin scalar functions, aggregate functions, user-defined functions (UDFs), and related utilities.

## 1. Architecture Overview

### Key Components

The functions subsystem consists of:

1. **Builtin Functions** (`src/func/builtins/`): 15+ files implementing core SQL functions
   - `datetime.ts` (~411 lines) - Date/time functions
   - `math.ts` (~210 lines) - Mathematical functions  
   - `string.ts` (~478 lines) - String manipulation
   - `aggregate.ts` (~257 lines) - Aggregate function base implementations
   - `comparison.ts` (~119 lines) - Type coercion and comparison
   - `json.ts` (~320 lines) - JSON manipulation functions
   - `schema.ts` (~254 lines) - Schema introspection functions
   - `core.ts` (~100 lines) - Core utility functions
   - Plus: `typeof.ts`, `datetime-modifier.ts`, `conditional.ts`, `hex.ts`, `debug.ts`, `type-constructors.ts`

2. **Aggregate Functions** (`src/func/aggregates/`): 10+ files
   - `count.ts`, `sum.ts`, `avg.ts`, `min.ts`, `max.ts`
   - `group_concat.ts`, `total.ts`, `string_agg.ts`
   - Window aggregates support

3. **Function Registration** (`src/func/registry.ts`): Central function lookup and registration

4. **Supporting Infrastructure**:
   - `src/func/validation.ts`: Argument validation
   - `src/func/coercion.ts`: Type coercion utilities
   - `src/schema/function.ts`: UDF registration system

## 2. Architecture Assessment

### Strengths
- Clean separation between function categories (math, string, datetime, etc.)
- Consistent use of `FunctionImplementation` interface
- Good type coercion support via `coercion.ts`
- Aggregate functions properly separated with accumulator pattern

### Concerns

1. **Tight Coupling with Runtime Context**
   - Many functions directly access `ctx.database` or schema information
   - Makes unit testing harder
   - Examples: `schema.ts` functions access database internals

2. **Inconsistent Error Handling**
   - Some functions throw `Error`, others return `null`, some use `QuereusError`
   - No standardized error code usage across functions
   - Missing input validation in some edge cases

3. **Large Files with Multiple Responsibilities**
   - `datetime.ts` (411 lines): Could split datetime parsing vs formatting
   - `string.ts` (478 lines): Could split basic vs Unicode operations
   - `json.ts` (320 lines): Could split extraction vs modification operations

## 3. Specific Files and Line Ranges to Review

### High Priority

#### `src/func/builtins/datetime.ts` (411 lines)
- **Lines 50-150**: `date()`, `time()`, `datetime()` parsing logic - complex with many edge cases
- **Lines 200-300**: Modifier application logic - deeply nested conditionals
- **Lines 350-411**: Timezone handling - potential bugs with DST transitions
- **Issues**:
  - `datetime()` function has 5+ overload patterns handled in single function
  - Error messages don't indicate which modifier failed
  - No validation of modifier syntax before processing

#### `src/func/builtins/string.ts` (478 lines)
- **Lines 100-180**: `substr()` implementation - boundary conditions
- **Lines 200-280**: `replace()` implementation - regex edge cases
- **Lines 350-420**: `printf()` implementation - format string parsing
- **Issues**:
  - `printf()` has limited format specifier support vs SQLite
  - `instr()` doesn't handle multi-byte characters consistently
  - `length()` behavior differs from SQLite for blobs

#### `src/func/builtins/aggregate.ts` (257 lines)
- **Lines 50-120**: `count()` implementation - DISTINCT handling
- **Lines 150-200**: `sum()`/`total()` - NULL vs empty result difference
- **Issues**:
  - DISTINCT implementation uses string serialization (potential collision issues)
  - No overflow detection for `sum()` with large integers
  - `avg()` precision loss with large datasets

#### `src/func/aggregates/*.ts`
- **All files**: Review accumulator state management
- **Issues identified**:
  - Memory not bounded for DISTINCT operations
  - Window function reset logic not tested for edge cases

### Medium Priority

#### `src/func/builtins/json.ts` (320 lines)
- **Lines 50-150**: `json_extract()` - path parsing edge cases
- **Lines 200-280**: `json_set()`/`json_replace()` - mutation semantics
- **Issues**:
  - Path syntax differs subtly from SQLite
  - No depth limit on recursive operations
  - Array index handling inconsistent with negative indices

#### `src/func/builtins/comparison.ts` (119 lines)
- **Lines 30-80**: Type coercion rules - verify SQLite compatibility
- **Lines 80-119**: Collation handling
- **Issues**:
  - Numeric affinity determination differs from SQLite in edge cases
  - BLOB comparison may not be byte-by-byte

#### `src/func/registry.ts`
- Function lookup performance with many registered functions
- Case sensitivity handling for function names
- Overload resolution when argument counts match

### Lower Priority

#### `src/func/builtins/math.ts` (210 lines)
- Generally well-implemented
- Review: `round()` banker's rounding vs half-up
- Review: `abs()` handling of MIN_SAFE_INTEGER

#### `src/func/builtins/schema.ts` (254 lines)
- Schema introspection functions
- Security: Verify no sensitive information exposed
- Review: `typeof()` vs SQLite type affinity rules

## 4. DRY Violations

### Repeated Patterns

1. **Argument Validation Pattern** (found in 10+ files):
```typescript
if (args.length < 1 || args.length > 3) {
  throw new Error(`function requires 1-3 arguments`);
}
```
**Refactoring**: Use `validateArgs(args, { min: 1, max: 3, name: 'funcName' })`

2. **NULL Short-Circuit Pattern** (found in 20+ functions):
```typescript
if (args[0] === null || args[1] === null) return null;
```
**Refactoring**: Use `withNullPropagation(fn)` wrapper

3. **Type Coercion Pattern** (found in 15+ functions):
```typescript
const val = typeof args[0] === 'string' ? parseFloat(args[0]) : args[0];
```
**Refactoring**: Use `coerceToNumber(args[0])` consistently

4. **Error Message Pattern** (inconsistent across files):
```typescript
// Some use:
throw new Error('invalid argument');
// Others use:
throw new QuereusError(StatusCode.ERROR, 'invalid argument');
// Some return:
return null;
```
**Refactoring**: Standardize on `QuereusError` with function-specific error codes

### Specific Duplication

- `datetime.ts:50-80` and `datetime.ts:120-150`: Similar parsing logic
- `string.ts:100-130` and `string.ts:200-230`: Similar substring extraction
- `aggregate.ts` and `aggregates/*.ts`: Accumulator initialization patterns

## 5. Test Coverage Gaps

### Missing Test Categories

1. **Edge Case Tests**:
   - Empty strings/arrays
   - NULL propagation
   - Integer overflow
   - Unicode edge cases (surrogates, combining characters)
   - Maximum/minimum values

2. **SQLite Compatibility Tests**:
   - Side-by-side comparison with SQLite output
   - Type affinity differences
   - Date/time format variations

3. **Performance Tests**:
   - Large string operations
   - Many-argument variadic functions
   - Deep JSON paths

### Specific Tests Needed

#### datetime.ts
```typescript
// Test file: test/func/datetime.spec.ts
describe('datetime functions', () => {
  // Edge cases
  it('should handle leap seconds')
  it('should handle DST transitions')
  it('should handle dates before 1970')
  it('should handle dates after 2038')
  it('should handle invalid month/day combinations')
  it('should handle timezone abbreviations')
  
  // Modifiers
  it('should apply multiple modifiers in order')
  it('should handle localtime modifier')
  it('should handle start of month/year/day')
  it('should handle weekday modifier edge cases')
  
  // Format strings
  it('should handle all strftime format codes')
  it('should handle unknown format codes')
});
```

#### string.ts
```typescript
// Test file: test/func/string.spec.ts  
describe('string functions', () => {
  // substr
  it('should handle negative start index')
  it('should handle length beyond string end')
  it('should handle multi-byte characters')
  
  // printf
  it('should handle all format specifiers')
  it('should handle width and precision')
  it('should handle positional arguments')
  
  // Unicode
  it('should handle emoji correctly')
  it('should handle combining characters')
  it('should handle RTL text')
});
```

#### aggregate.ts
```typescript
// Test file: test/func/aggregate.spec.ts
describe('aggregate functions', () => {
  // DISTINCT
  it('should handle DISTINCT with NULLs')
  it('should handle DISTINCT with equivalent values')
  it('should handle DISTINCT with many values (memory)')
  
  // Window functions
  it('should reset state between partitions')
  it('should handle empty partitions')
  it('should handle single-row partitions')
  
  // Edge cases
  it('should handle sum overflow')
  it('should handle avg with one value')
  it('should handle empty input')
});
```

## 6. Documentation Gaps

### Missing Documentation

1. **Function Reference** (`docs/functions.md`):
   - Complete function list with signatures
   - Differences from SQLite
   - Examples for each function
   - Error conditions

2. **UDF Guide** (`docs/udf.md` or in `docs/functions.md`):
   - How to register custom functions
   - Available context and utilities
   - Type handling and coercion
   - Performance considerations

3. **Code Comments**:
   - JSDoc for all exported functions
   - Complexity explanations in datetime/string parsing
   - SQLite compatibility notes inline

### Specific Documentation Needed

- `datetime.ts`: Document supported date formats and modifiers
- `json.ts`: Document JSON path syntax differences from SQLite
- `aggregate.ts`: Document accumulator lifecycle and window semantics
- `registry.ts`: Document function lookup algorithm and precedence

## 7. Refactoring Candidates

### High Priority

1. **Extract Argument Validation** (`src/func/validation.ts`)
   - Create `validateArgs()` with schema-based validation
   - Include type checking, null handling, range validation
   - Standardize error messages

2. **Consolidate Type Coercion** (`src/func/coercion.ts`)
   - Ensure all coercion goes through central utilities
   - Document SQLite affinity rules
   - Add strict mode option

3. **Split datetime.ts**
   - `datetime-parse.ts`: Parsing and normalization
   - `datetime-format.ts`: Formatting and strftime
   - `datetime-modify.ts`: Modifiers and arithmetic
   - `datetime.ts`: Main entry points

### Medium Priority

4. **Split string.ts**
   - `string-basic.ts`: substr, replace, trim, etc.
   - `string-unicode.ts`: Unicode-aware operations
   - `string-format.ts`: printf and formatting

5. **Standardize Error Handling**
   - Define function-specific error codes
   - Create error factory functions
   - Update all functions to use standard errors

6. **Add NULL Propagation Wrapper**
   - Create `withNullPropagation(fn)` utility
   - Apply to all functions that should propagate NULL
   - Reduce boilerplate in function implementations

### Lower Priority

7. **Extract JSON Path Parser**
   - Separate path parsing from extraction logic
   - Add path validation
   - Support for extended path syntax

8. **Optimize Aggregate DISTINCT**
   - Use proper hash-based deduplication
   - Add memory limits with spill-to-disk option
   - Profile and optimize common cases

## 8. TODO

### Phase 1: Critical Fixes
- [ ] Standardize error handling across all functions (use QuereusError with codes)
- [ ] Fix DISTINCT implementation to avoid string serialization collisions
- [ ] Add input validation to all functions (use common validation utilities)
- [ ] Fix `printf()` to support all SQLite format specifiers
- [ ] Add integer overflow detection to `sum()` aggregate

### Phase 2: Test Coverage
- [ ] Create comprehensive datetime edge case tests
- [ ] Create comprehensive string function tests (including Unicode)
- [ ] Create aggregate function tests with DISTINCT and window cases
- [ ] Create SQLite compatibility test suite (side-by-side comparison)
- [ ] Add JSON function path parsing edge case tests
- [ ] Add performance benchmarks for string and datetime operations

### Phase 3: Refactoring
- [ ] Extract common argument validation utility
- [ ] Add NULL propagation wrapper and apply to all functions
- [ ] Split datetime.ts into focused modules
- [ ] Split string.ts into focused modules
- [ ] Consolidate type coercion patterns

### Phase 4: Documentation
- [ ] Create complete function reference documentation
- [ ] Document SQLite compatibility differences
- [ ] Add JSDoc to all exported functions
- [ ] Create UDF authoring guide
- [ ] Document aggregate accumulator lifecycle

### Phase 5: Optimization
- [ ] Profile and optimize datetime parsing
- [ ] Optimize aggregate DISTINCT with hash-based deduplication
- [ ] Add memory limits to unbounded operations
- [ ] Review and optimize JSON operations for deep paths
