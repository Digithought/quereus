---
description: Comprehensive review of error handling patterns across codebase
dependencies: none
priority: 3
---

# Error Handling Review Plan

This document provides a comprehensive adversarial review plan for error handling patterns across the Quereus codebase.

## 1. Scope

The error handling review covers:

- Note: unless otherwise specified, file paths in this document are relative to `packages/quereus/`.
- **Error Types** (`src/common/errors.ts`) - Error class definitions
- **Status Codes** - SQLite-compatible status codes
- **Error Propagation** - How errors flow through the system
- **Error Context** - Information included in errors
- **Error Recovery** - How errors are handled and recovered from
- **User-Facing Messages** - Error message quality and actionability

## 2. Current Error System Assessment

### Error Class Hierarchy

**`QuereusError`** - Base error class
- Extends `Error`
- Includes status code
- Includes optional context

**Issues to investigate:**
- Consistency of error class usage
- Completeness of status codes
- Context richness
- Stack trace preservation

### Status Codes

Review SQLite-compatible codes:
- `SQLITE_OK` (0)
- `SQLITE_ERROR` (1)
- `SQLITE_BUSY` (5)
- `SQLITE_CONSTRAINT` (19)
- etc.

Custom Quereus codes:
- Document all custom codes
- Ensure no conflicts

## 3. Specific Files and Line Ranges to Review

### High Priority

**`src/common/errors.ts`** (~150 lines)
- Lines 1-50: Error class definitions
- Lines 50-100: Status code enum
- Lines 100-150: Error factory functions

**Issues to check:**
- All error types documented
- Status codes match SQLite where applicable
- Error context structure

**`src/parser/parser.ts`** (error sections)
- Lines handling parse errors
- Error recovery logic
- Error message generation

**Issues to check:**
- Error location information (line, column)
- Recovery attempts
- Message clarity

**`src/planner/planner.ts`** (error sections)
- Semantic error handling
- Type mismatch errors
- Unknown identifier errors

**Issues to check:**
- Error specificity
- Suggestions for fixes
- Context preservation

**`src/runtime/scheduler.ts`** (error sections)
- Execution error handling
- Async error propagation
- Resource cleanup on error

**Issues to check:**
- Error context includes query info
- Resources released on error
- Error not swallowed

### Medium Priority

**`src/vtab/memory/`** (error handling)
- Constraint violation errors
- Transaction errors
- Cursor errors

**`src/core/database.ts`** (error handling)
- API error wrapping
- User-facing error messages
- Error event emission

**`src/optimizer/`** (error handling)
- Optimization failure handling
- Graceful degradation

### Lower Priority

**Utility files** (error patterns)
- `src/util/comparison.ts`
- `src/util/coercion.ts`
- `src/util/types.ts`

## 4. Error Handling Patterns Analysis

### Pattern 1: Direct Throw

```typescript
throw new Error('Something went wrong');
```
**Issues:**
- Generic Error type
- No status code
- No context

**Recommendation:** Use QuereusError

### Pattern 2: QuereusError with Code

```typescript
throw new QuereusError(StatusCode.SQLITE_ERROR, 'Message');
```
**Issues:**
- May lack context
- May not include cause

**Recommendation:** Include context object

### Pattern 3: Error with Context

```typescript
throw new QuereusError(StatusCode.SQLITE_ERROR, 'Message', {
  sql: query,
  params: params,
  table: tableName
});
```
**Better:** Includes debugging information

### Pattern 4: Error Swallowing

```typescript
try {
  // operation
} catch (e) {
  // silent failure
}
```
**Issues:**
- Hides problems
- Makes debugging difficult

**Recommendation:** Log or rethrow

### Pattern 5: Return Null on Error

```typescript
function parse(input: string): Result | null {
  try {
    return doParse(input);
  } catch {
    return null;
  }
}
```
**Issues:**
- Error information lost
- Caller can't distinguish reasons

**Recommendation:** Use Result type or rethrow

## 5. Specific Issues to Find

### Error Swallowing

Search for patterns:
```typescript
catch (e) {
  // empty or just logging
}
```

Files likely to have issues:
- Async handlers
- Event listeners
- Cleanup code

### Inconsistent Error Types

Search for:
```typescript
throw new Error(...)  // Should be QuereusError
```

Expected in:
- Parser
- Planner
- Runtime
- Utilities

### Missing Error Context

Search for errors without helpful information:
```typescript
throw new QuereusError(code, 'Operation failed');
// Missing: what operation, what data, what state
```

### Unhelpful Error Messages

Look for:
- Technical jargon without explanation
- Missing suggestions for fixes
- No indication of error location

### Async Error Propagation

Verify:
- Promises don't swallow rejections
- Async iterators propagate errors
- Event handlers report errors

## 6. Test Coverage Gaps

### Missing Error Tests

```typescript
// test/errors/error-handling.spec.ts
describe('Error Handling', () => {
  describe('parser errors', () => {
    it('reports syntax error with location')
    it('suggests fixes for common mistakes')
    it('handles multiple errors')
  })
  
  describe('planner errors', () => {
    it('reports unknown table')
    it('reports unknown column')
    it('reports type mismatch')
  })
  
  describe('runtime errors', () => {
    it('reports constraint violation')
    it('reports division by zero')
    it('reports function error')
  })
  
  describe('error recovery', () => {
    it('recovers from parse error')
    it('rolls back on execution error')
    it('cleans up resources on error')
  })
})
```

### Error Propagation Tests

```typescript
// test/errors/propagation.spec.ts
describe('Error Propagation', () => {
  it('propagates through async operations')
  it('propagates through iterators')
  it('preserves error context')
  it('preserves stack trace')
  it('wraps underlying errors')
})
```

### User-Facing Error Tests

```typescript
// test/errors/messages.spec.ts
describe('Error Messages', () => {
  it('provides actionable messages')
  it('includes relevant context')
  it('is user-friendly')
  it('localizable (future)')
})
```

## 7. Documentation Gaps

### Missing Error Documentation

1. **Error Reference** (`docs/errors.md`)
   - All error codes
   - Common causes
   - Resolution steps

2. **Error Handling Guide**
   - How to catch errors
   - How to extract context
   - Recovery patterns

3. **Code Comments**
   - Document when functions throw
   - Document error conditions
   - Document recovery behavior

## 8. Refactoring Candidates

### High Priority

1. **Standardize Error Types**
   ```typescript
   // Define specific error classes
   class ParseError extends QuereusError { ... }
   class PlanError extends QuereusError { ... }
   class RuntimeError extends QuereusError { ... }
   class ConstraintError extends QuereusError { ... }
   ```

2. **Add Error Factory Functions**
   ```typescript
   function createParseError(message: string, location: Location): ParseError
   function createTypeError(expected: Type, actual: Type): PlanError
   function createConstraintError(constraint: string, table: string): ConstraintError
   ```

3. **Enhance Error Context**
   ```typescript
   interface ErrorContext {
     sql?: string;
     location?: { line: number; column: number };
     table?: string;
     column?: string;
     value?: SqlValue;
     cause?: Error;
   }
   ```

### Medium Priority

4. **Add Result Type**
   ```typescript
   type Result<T, E = QuereusError> = 
     | { ok: true; value: T }
     | { ok: false; error: E };
   ```

5. **Centralize Error Handling**
   ```typescript
   function handleError(error: unknown, context: ErrorContext): QuereusError
   function logError(error: QuereusError): void
   function formatError(error: QuereusError): string
   ```

### Lower Priority

6. **Error Localization**
   - Error message templates
   - Locale-aware formatting

7. **Error Telemetry**
   - Error tracking
   - Aggregation
   - Reporting

## 9. Acceptance Criteria

### Error System Standardized
- [ ] Zero `throw new Error(...)` usages (all use QuereusError)
- [ ] All error types extend QuereusError with appropriate codes
- [ ] Error context interface consistently used
- [ ] Error factory functions available for common cases

### Error Context Complete
- [ ] Parse errors include line/column location
- [ ] Query errors include SQL and parameters
- [ ] Schema errors include table/column names
- [ ] Runtime errors include value context where relevant
- [ ] Wrapped errors preserve original cause

### Error Handling Correct
- [ ] No error swallowing in async code (all caught errors logged or rethrown)
- [ ] Errors propagate correctly through iterators
- [ ] Resources cleaned up on error (cursors, transactions, etc.)
- [ ] Context leaks detected and prevented

### Error Messages Actionable
- [ ] Error messages suggest fixes where possible
- [ ] Technical details available in error context
- [ ] User-friendly messages for common errors
- [ ] Error codes documented with resolutions

## 10. Test Plan

### Error Type Tests
- [ ] All error types instantiate correctly (`test/errors/types.spec.ts`)
- [ ] Error codes match SQLite where applicable
- [ ] Error context serializes correctly
- [ ] Error stack traces preserved

### Error Propagation Tests
- [ ] Parser errors propagate with location (`test/errors/parser.spec.ts`)
- [ ] Planner errors propagate with AST context (`test/errors/planner.spec.ts`)
- [ ] Runtime errors propagate with query context (`test/errors/runtime.spec.ts`)
- [ ] Async errors propagate through promises (`test/errors/async.spec.ts`)
- [ ] Iterator errors propagate correctly (`test/errors/iterators.spec.ts`)

### Error Recovery Tests
- [ ] Parse errors allow recovery (`test/errors/recovery.spec.ts`)
- [ ] Transaction errors trigger rollback
- [ ] Resource cleanup on error verified
- [ ] Error context preserved through wrapping

### Error Message Tests
- [ ] Error messages are user-friendly (`test/errors/messages.spec.ts`)
- [ ] Error messages include suggestions
- [ ] Error context accessible programmatically
- [ ] Error codes documented

## 11. TODO

### Phase 1: Audit
- [ ] Inventory all error types (grep for `class.*Error`)
- [ ] Find all `throw new Error(...)` usages (grep pattern)
- [ ] Find all error swallowing patterns (`catch` with empty body)
- [ ] Document current status codes (`src/common/errors.ts`)
- [ ] Review async error handling (promises, generators, async iterators)

### Phase 2: Standardization
- [ ] Define error class hierarchy (ParseError, PlanError, RuntimeError, etc.)
- [ ] Define error context interface (see section 8)
- [ ] Create error factory functions (`createParseError`, `createTypeError`, etc.)
- [ ] Document error codes and meanings (`docs/errors.md`)
- [ ] Replace generic Error with QuereusError (systematic replacement)

### Phase 3: Context Enhancement
- [ ] Add SQL context to query errors (include SQL string and params)
- [ ] Add location to parse errors (line, column from AST)
- [ ] Add table/column to schema errors (from schema context)
- [ ] Add value context to runtime errors (problematic value)
- [ ] Preserve original cause in wrapped errors (cause property)

### Phase 4: Error Handling Fixes
- [ ] Fix error swallowing in async code (see `3-review-core-runtime.md`)
- [ ] Fix error propagation in iterators (generator error handling)
- [ ] Add proper cleanup on errors (finally blocks, resource tracking)
- [ ] Ensure resources released on error (cursors, transactions, connections)

### Phase 5: Test Coverage
- [ ] Add parser error tests (`test/errors/parser.spec.ts`)
- [ ] Add planner error tests (`test/errors/planner.spec.ts`)
- [ ] Add runtime error tests (`test/errors/runtime.spec.ts`)
- [ ] Add propagation tests (`test/errors/propagation.spec.ts`)
- [ ] Add recovery tests (`test/errors/recovery.spec.ts`)

### Phase 6: Documentation
- [ ] Create error reference (`docs/errors.md` - see `3-review-documentation.md`)
- [ ] Add JSDoc for all throwing functions (`@throws` annotations)
- [ ] Document recovery patterns (examples in docs)
- [ ] Add error handling examples (`examples/error-handling.ts`)

### Phase 7: User Experience
- [ ] Review error message clarity (user testing or review)
- [ ] Add suggestions in error messages (common fixes)
- [ ] Ensure actionable messages (what to do next)
- [ ] Consider error localization (future: i18n support)
