---
description: Comprehensive review of core API (Database, Statement, Results)
dependencies: none
priority: 3
---

# Core API Review Plan

This document provides a comprehensive adversarial review plan for the Quereus core API, focusing on the public-facing interfaces for database operations.

## 1. Scope

The core API includes:

- **Database Class** (`src/core/database.ts`) - Main entry point, connection management
- **Statement Class** (`src/core/statement.ts`) - Prepared statement execution
- **Results Handling** (`src/core/results.ts`) - Query result iteration and access
- **Database Events** (`src/core/database-events.ts`) - Change notification system
- **Database Internal** (`src/core/database-internal.ts`) - Internal implementation details
- **Transaction Support** (`src/core/transaction.ts`) - Transaction management

## 2. Architecture Assessment

### Database Class (`database.ts`)

**Strengths:**
- Clean public API surface
- Supports both sync and async operations
- Transaction support with savepoints
- Event emission for change tracking

**Concerns:**
- Internal state management complexity
- Connection lifecycle management
- Error handling consistency

### Statement Class (`statement.ts`)

**Strengths:**
- Parameter binding support (named and positional)
- Multiple execution modes (run, get, all, iterate)
- Prepared statement caching

**Concerns:**
- Statement lifecycle (finalization)
- Parameter type coercion
- Error context in execution failures

### Results Handling (`results.ts`)

**Strengths:**
- Iterator-based for memory efficiency
- Row object construction

**Concerns:**
- Column type preservation
- Large result set handling
- Resource cleanup

### Event System (`database-events.ts`)

**Strengths:**
- Table-level change tracking
- Batch change support

**Concerns:**
- Event ordering guarantees
- Memory leaks from listeners
- Performance with many listeners

## 3. Specific Files and Line Ranges to Review

### High Priority

**`src/core/database.ts`** (~500 lines)
- Lines 1-100: Class definition and constructor
- Lines 100-200: `exec()` and `prepare()` methods
- Lines 200-300: Transaction methods (begin, commit, rollback)
- Lines 300-400: Schema access and introspection
- Lines 400-500: Event handling and lifecycle

**Issues to check:**
- Constructor initialization order
- Connection state validation
- Transaction nesting correctness
- Event listener cleanup

**`src/core/statement.ts`** (~350 lines)
- Lines 1-80: Class definition and binding
- Lines 80-160: `run()` method implementation
- Lines 160-240: `get()` and `all()` methods
- Lines 240-350: `iterate()` and iteration logic

**Issues to check:**
- Parameter binding type safety
- Statement reuse after finalization
- Iterator cleanup on early exit
- Error context preservation

**`src/core/database-events.ts`** (~150 lines)
- Lines 1-50: Event type definitions
- Lines 50-100: Listener registration
- Lines 100-150: Event dispatch logic

**Issues to check:**
- Listener memory management
- Event ordering
- Error handling in listeners
- Batch event coalescing

### Medium Priority

**`src/core/database-internal.ts`** (~300 lines)
- Lines 1-100: Internal state management
- Lines 100-200: Schema cache management
- Lines 200-300: Connection handling

**`src/core/results.ts`** (~200 lines)
- Lines 1-80: Result set construction
- Lines 80-150: Row iteration
- Lines 150-200: Column access

**`src/core/transaction.ts`** (~150 lines)
- Lines 1-80: Transaction state
- Lines 80-150: Savepoint management

### Lower Priority

**`src/core/index.ts`** (~30 lines)
- Public export organization

## 4. DRY Violations and Code Quality Issues

### Repeated Patterns

1. **State Validation** (multiple files)
   ```typescript
   if (this._finalized) throw new Error('Statement finalized');
   if (!this._db) throw new Error('Database closed');
   ```
   **Found in**: statement.ts, database.ts, transaction.ts
   **Recommendation**: Create state validation decorators or helper

2. **Parameter Binding** (statement.ts)
   - Similar logic for named vs positional parameters
   **Recommendation**: Unify into single binding resolver

3. **Event Emission** (database.ts, database-events.ts)
   - Similar patterns for different event types
   **Recommendation**: Create generic event emitter wrapper

### Large Functions

1. **`Database.exec()`** (~60 lines)
   - Handles multiple statements
   - Transaction management interleaved
   - Should decompose into statement parsing and execution

2. **`Statement.iterate()`** (~80 lines)
   - Complex generator with cleanup logic
   - Resource management interleaved
   - Should extract iterator wrapper

### Error Handling Inconsistencies

**In database.ts:**
- Some methods throw `Error`
- Some throw `QuereusError`
- Some return error results

**Recommendation:** Standardize on `QuereusError` with codes

## 5. Test Coverage Gaps

### Missing Tests for database.ts

```typescript
// test/core/database.spec.ts
describe('Database', () => {
  describe('construction', () => {
    it('creates with default options')
    it('creates with custom schema')
    it('handles invalid options')
  })
  
  describe('exec()', () => {
    it('executes single statement')
    it('executes multiple statements')
    it('handles syntax errors')
    it('handles execution errors')
    it('returns last insert rowid')
    it('returns changes count')
  })
  
  describe('prepare()', () => {
    it('creates prepared statement')
    it('handles invalid SQL')
    it('caches prepared statements')
  })
  
  describe('transactions', () => {
    it('begins transaction')
    it('commits transaction')
    it('rolls back transaction')
    it('handles nested transactions via savepoints')
    it('handles transaction errors')
  })
  
  describe('close()', () => {
    it('closes database')
    it('rejects operations after close')
    it('cleans up resources')
  })
})
```

### Missing Tests for statement.ts

```typescript
// test/core/statement.spec.ts
describe('Statement', () => {
  describe('binding', () => {
    it('binds positional parameters')
    it('binds named parameters')
    it('binds mixed parameters')
    it('handles missing parameters')
    it('handles extra parameters')
    it('coerces parameter types')
  })
  
  describe('run()', () => {
    it('executes INSERT')
    it('executes UPDATE')
    it('executes DELETE')
    it('returns changes and lastInsertRowid')
  })
  
  describe('get()', () => {
    it('returns single row')
    it('returns undefined for no match')
    it('handles multiple matches')
  })
  
  describe('all()', () => {
    it('returns all rows')
    it('returns empty array for no matches')
    it('handles large result sets')
  })
  
  describe('iterate()', () => {
    it('yields rows one at a time')
    it('cleans up on completion')
    it('cleans up on early exit')
    it('cleans up on error')
  })
  
  describe('finalize()', () => {
    it('finalizes statement')
    it('rejects operations after finalize')
  })
})
```

### Missing Tests for events

```typescript
// test/core/events.spec.ts
describe('Database Events', () => {
  describe('change events', () => {
    it('emits on INSERT')
    it('emits on UPDATE')
    it('emits on DELETE')
    it('includes correct table name')
    it('includes row data')
  })
  
  describe('listener management', () => {
    it('adds listeners')
    it('removes listeners')
    it('handles multiple listeners')
    it('handles listener errors')
  })
  
  describe('batching', () => {
    it('batches multiple changes')
    it('maintains change order')
  })
})
```

### Integration Tests Needed

```typescript
// test/core/integration.spec.ts
describe('API Integration', () => {
  describe('transaction isolation', () => {
    it('isolates changes within transaction')
    it('shows changes after commit')
    it('hides changes after rollback')
  })
  
  describe('concurrent access', () => {
    it('handles concurrent reads')
    it('handles concurrent writes')
    it('handles read during write')
  })
  
  describe('error recovery', () => {
    it('recovers from query error')
    it('recovers from constraint violation')
    it('maintains consistent state')
  })
})
```

## 6. Documentation Gaps

### Missing Documentation

1. **API Reference** (`docs/api.md`)
   - Complete method signatures
   - Parameter descriptions
   - Return value semantics
   - Error conditions

2. **Usage Examples**
   - Basic CRUD operations
   - Transaction patterns
   - Event handling
   - Error handling

3. **Best Practices**
   - Connection management
   - Statement caching
   - Transaction boundaries
   - Memory management

4. **Migration Guide**
   - From better-sqlite3
   - From sql.js
   - From other SQLite wrappers

### Code Comments Needed

- JSDoc for all public methods
- Inline comments for complex logic
- Error condition documentation

## 7. Refactoring Candidates

### High Priority

1. **Extract State Validation**
   ```typescript
   // New utility
   function assertNotFinalized(stmt: Statement): void
   function assertDatabaseOpen(db: Database): void
   function assertInTransaction(db: Database): void
   ```

2. **Unify Parameter Binding**
   ```typescript
   // Before: separate handling
   if (typeof params === 'object') { /* named */ }
   else if (Array.isArray(params)) { /* positional */ }
   
   // After: unified resolver
   const resolvedParams = resolveParameters(params, parameterNames);
   ```

3. **Standardize Error Handling**
   ```typescript
   // Consistent QuereusError usage
   throw new QuereusError(StatusCode.SQLITE_ERROR, message, { sql, params });
   ```

### Medium Priority

4. **Extract Result Iterator**
   ```typescript
   // Wrapper for consistent cleanup
   class ResultIterator implements AsyncIterableIterator<Row> {
     constructor(private source: AsyncIterable<Row>, private cleanup: () => void)
     // ...
   }
   ```

5. **Event System Enhancement**
   ```typescript
   // Type-safe event emitter
   class TypedEventEmitter<Events extends Record<string, any>> {
     on<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): void
     off<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): void
     emit<K extends keyof Events>(event: K, data: Events[K]): void
   }
   ```

### Lower Priority

6. **Statement Pool**
   - Automatic statement caching
   - LRU eviction
   - Size limits

7. **Connection Pool**
   - Multiple database connections
   - Read replica support
   - Load balancing

## 8. Potential Bugs

### High Probability

1. **Statement Reuse After Error**
   - May leave statement in inconsistent state
   - Verify reset() called after error

2. **Iterator Resource Leak**
   - Early exit from iterate() may not cleanup
   - Verify finally block always runs

3. **Event Listener Accumulation**
   - Listeners not removed may accumulate
   - Memory leak potential

### Medium Probability

4. **Transaction State Corruption**
   - Nested transaction handling
   - Savepoint naming conflicts
   - Rollback to wrong savepoint

5. **Parameter Type Coercion**
   - Unexpected type conversions
   - Precision loss for large numbers
   - Date handling

6. **Concurrent Access Issues**
   - Transaction interleaving
   - Statement sharing
   - Event ordering

## 9. Security Considerations

### Input Validation
- SQL injection via dynamic SQL in exec()
- Parameter escaping verification
- Table/column name validation

### Resource Limits
- Statement count limits
- Result set size limits
- Transaction timeout

### Sensitive Data
- Parameter logging
- Error message content
- Event payload content

## 10. TODO

### Phase 1: Critical Fixes
- [ ] Standardize error handling (use QuereusError consistently)
- [ ] Fix iterator cleanup on early exit
- [ ] Add state validation helpers
- [ ] Document public API with JSDoc

### Phase 2: Test Coverage
- [ ] Create comprehensive Database tests
- [ ] Create comprehensive Statement tests
- [ ] Create event system tests
- [ ] Create integration tests
- [ ] Add edge case coverage

### Phase 3: Refactoring
- [ ] Extract state validation utilities
- [ ] Unify parameter binding logic
- [ ] Create typed event emitter
- [ ] Extract result iterator wrapper

### Phase 4: Documentation
- [ ] Complete API reference
- [ ] Add usage examples
- [ ] Document best practices
- [ ] Create migration guides

### Phase 5: Enhancements
- [ ] Add statement pooling
- [ ] Add connection pooling
- [ ] Add query timeout support
- [ ] Add query cancellation

### Phase 6: Security
- [ ] Audit for SQL injection
- [ ] Add resource limits
- [ ] Review error messages for sensitive data
- [ ] Add security documentation
