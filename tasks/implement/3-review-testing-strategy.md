---
description: Comprehensive review of testing strategy and test coverage
dependencies: none
priority: 3
---

# Testing Strategy Review Plan

This document provides a comprehensive adversarial review plan for the testing strategy and test coverage across the Quereus project.

## 1. Scope

The testing review covers:

- **Unit Tests** - Component-level testing
- **Integration Tests** - Cross-component testing
- **End-to-End Tests** - Full pipeline testing
- **SQLLogic Tests** - SQL compatibility testing
- **Property-Based Tests** - Fuzz/property testing
- **Performance Tests** - Benchmark testing
- **Test Infrastructure** - Test utilities and helpers

## 2. Current Testing Assessment

### Test Frameworks

**In use:**
- Mocha - Test runner
- Chai - Assertions
- fast-check - Property-based testing
- SQLLogic format - SQL tests

**Test locations:**
- `packages/quereus/test/` - Main test directory
- `packages/*/test/` - Package-specific tests
- `test/logic/` - SQLLogic test files

### Coverage Summary

| Area | Unit Tests | Integration Tests | Notes |
|------|------------|-------------------|-------|
| Parser | ? | ? | Needs assessment |
| Planner | ? | ? | Needs assessment |
| Optimizer | Low | Low | Identified gap |
| Runtime | Low | Low | Identified gap |
| VTab | ? | ? | Needs assessment |
| Schema | ? | ? | Needs assessment |
| Functions | ? | ? | Needs assessment |
| Core API | ? | ? | Needs assessment |

## 3. Test File Inventory

### Existing Test Files to Review

**Main package tests:**
- `packages/quereus/test/*.spec.ts`
- `packages/quereus/test/logic/*.sqllogic`

**Package-specific tests:**
- `packages/quereus-plugin-indexeddb/test/`
- `packages/quereus-store/test/`
- Other packages

### Test Organization Assessment

**Current structure:**
- Review how tests are organized
- Assess naming conventions
- Check test isolation

**Issues to identify:**
- Missing test categories
- Poorly organized tests
- Flaky tests
- Slow tests

## 4. Coverage Gaps by Component

### Parser Tests

**Needed:**
- Lexer unit tests (token generation)
- Parser unit tests (each statement type)
- Error recovery tests
- Location tracking tests
- Edge case syntax tests

**Example tests:**
```typescript
// test/parser/lexer.spec.ts
describe('Lexer', () => {
  it('tokenizes identifiers')
  it('tokenizes strings with escapes')
  it('tokenizes numbers')
  it('tokenizes operators')
  it('handles comments')
  it('tracks locations')
})

// test/parser/statements.spec.ts
describe('Statement parsing', () => {
  it('parses SELECT')
  it('parses INSERT')
  it('parses UPDATE')
  it('parses DELETE')
  it('parses CREATE TABLE')
  // ... etc
})
```

### Planner Tests

**Needed:**
- Scope resolution tests
- Type inference tests
- Plan node construction tests
- Error case tests

**Example tests:**
```typescript
// test/planner/scope.spec.ts
describe('Scope resolution', () => {
  it('resolves simple column reference')
  it('resolves qualified column reference')
  it('resolves alias')
  it('handles ambiguous reference')
  it('handles unknown column')
})

// test/planner/type-inference.spec.ts
describe('Type inference', () => {
  it('infers literal types')
  it('infers expression types')
  it('handles NULL propagation')
  it('infers aggregate result types')
})
```

### Optimizer Tests

**Needed:**
- Individual rule tests
- Rule composition tests
- Cost estimation tests
- Edge case handling

**Example tests:**
```typescript
// test/optimizer/rules/predicate-pushdown.spec.ts
describe('Predicate pushdown rule', () => {
  it('pushes simple equality')
  it('pushes compound conditions')
  it('does not push non-pushable')
  it('handles NULL correctly')
})

// test/optimizer/cost.spec.ts
describe('Cost estimation', () => {
  it('estimates scan cost')
  it('estimates index lookup cost')
  it('estimates join cost')
})
```

### Runtime Tests

**Needed:**
- Scheduler tests
- Emitter tests (per emitter)
- Context management tests
- Error handling tests

**Example tests:**
```typescript
// test/runtime/scheduler.spec.ts
describe('Scheduler', () => {
  it('executes simple query')
  it('handles async operations')
  it('propagates errors')
  it('cleans up on error')
})

// test/runtime/emitters/join.spec.ts
describe('Join emitter', () => {
  it('emits inner join')
  it('emits left outer join')
  it('emits right outer join')
  it('emits full outer join')
  it('handles empty inputs')
})
```

### VTab Tests

**Needed:**
- Memory table tests
- MVCC isolation tests
- Cursor tests
- Constraint handling tests

**Example tests:**
```typescript
// test/vtab/memory/crud.spec.ts
describe('MemoryTable CRUD', () => {
  it('inserts row')
  it('updates row')
  it('deletes row')
  it('handles constraints')
})

// test/vtab/memory/mvcc.spec.ts
describe('MVCC isolation', () => {
  it('isolates uncommitted changes')
  it('handles concurrent reads')
  it('handles concurrent writes')
  it('rolls back correctly')
})
```

### Function Tests

**Needed:**
- Each function category
- Edge cases
- NULL handling
- Type coercion

**Example tests:**
```typescript
// test/func/datetime.spec.ts
describe('Datetime functions', () => {
  it('parses date strings')
  it('formats dates')
  it('applies modifiers')
  it('handles edge cases')
})
```

### Core API Tests

**Needed:**
- Database lifecycle
- Statement execution
- Transaction handling
- Event system

**Example tests:**
```typescript
// test/core/database.spec.ts
describe('Database', () => {
  it('creates database')
  it('executes queries')
  it('handles transactions')
  it('emits events')
  it('closes cleanly')
})
```

## 5. Test Quality Assessment

### Test Smells to Find

1. **Flaky Tests**
   - Tests that sometimes pass/fail
   - Timing-dependent tests
   - Order-dependent tests

2. **Slow Tests**
   - Tests taking > 1 second
   - Unnecessary setup/teardown
   - Missing parallelization

3. **Incomplete Tests**
   - Missing assertions
   - Incomplete edge cases
   - Missing error cases

4. **Poor Test Design**
   - Tests testing multiple things
   - Overly complex setup
   - Missing test isolation

### Test Patterns to Encourage

1. **Arrange-Act-Assert**
   ```typescript
   it('should do something', () => {
     // Arrange
     const input = createInput();
     
     // Act
     const result = doSomething(input);
     
     // Assert
     expect(result).to.equal(expected);
   });
   ```

2. **Descriptive Names**
   ```typescript
   // Good
   it('returns null when input is empty')
   
   // Bad
   it('test 1')
   ```

3. **Isolated Tests**
   - Each test independent
   - No shared mutable state
   - Clean setup/teardown

## 6. Property-Based Testing

### Areas for Property Tests

**Parser:**
- Round-trip: parse → format → parse
- Valid syntax always parses
- Invalid syntax fails gracefully

**Type system:**
- Coercion properties
- Comparison properties
- NULL propagation

**Query execution:**
- Determinism
- Consistency
- Idempotency

### Example Property Tests

```typescript
// test/properties/parser.spec.ts
import fc from 'fast-check';

describe('Parser properties', () => {
  it('parses any valid identifier', () => {
    fc.assert(fc.property(
      fc.stringOf(fc.constantFrom(...validIdentifierChars)),
      (id) => {
        const result = parse(`SELECT ${id} FROM t`);
        expect(result).to.not.be.null;
      }
    ));
  });
});

// test/properties/types.spec.ts
describe('Type coercion properties', () => {
  it('coercion is idempotent', () => {
    fc.assert(fc.property(
      fc.anything(),
      (value) => {
        const once = coerceToType(value, 'TEXT');
        const twice = coerceToType(once, 'TEXT');
        expect(twice).to.equal(once);
      }
    ));
  });
});
```

## 7. SQLLogic Testing

### Current SQLLogic Tests

**Review:**
- Coverage of SQL features
- Edge case coverage
- Performance characteristics

### SQLLogic Test Expansion

**Areas to add:**
- More edge cases
- Error conditions
- Concurrency scenarios

**Example SQLLogic tests:**
```
# test/logic/null-handling.test
statement ok
CREATE TABLE t (a INTEGER, b TEXT)

statement ok
INSERT INTO t VALUES (NULL, 'a'), (1, NULL), (NULL, NULL)

query I rowsort
SELECT a FROM t WHERE a IS NULL
----
NULL
NULL

query I rowsort
SELECT a FROM t WHERE a IS NOT NULL
----
1
```

## 8. Test Infrastructure

### Current Infrastructure

**Review:**
- Test helpers
- Test fixtures
- Mocking utilities
- CI/CD integration

### Infrastructure Improvements

**Test utilities:**
```typescript
// test/helpers/database.ts
export function createTestDatabase(options?: TestDbOptions): Database
export function withTransaction<T>(db: Database, fn: () => T): T
export function seedTestData(db: Database, data: TestData): void
```

**Test fixtures:**
```typescript
// test/fixtures/schemas.ts
export const simpleSchema = `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`;
export const complexSchema = `...`;

// test/fixtures/data.ts
export const simpleData = [{ id: 1, name: 'a' }, ...];
```

## 9. TODO

### Phase 1: Assessment
- [ ] Inventory all existing tests
- [ ] Measure current coverage
- [ ] Identify flaky tests
- [ ] Identify slow tests
- [ ] Document test gaps

### Phase 2: Infrastructure
- [ ] Create test helper utilities
- [ ] Create standard fixtures
- [ ] Set up coverage reporting
- [ ] Improve CI/CD integration
- [ ] Add parallelization if missing

### Phase 3: Unit Test Coverage
- [ ] Add parser unit tests
- [ ] Add planner unit tests
- [ ] Add optimizer rule tests
- [ ] Add runtime emitter tests
- [ ] Add VTab unit tests
- [ ] Add function tests
- [ ] Add utility tests

### Phase 4: Integration Tests
- [ ] Add parser-planner tests
- [ ] Add planner-optimizer tests
- [ ] Add optimizer-runtime tests
- [ ] Add runtime-VTab tests
- [ ] Add end-to-end tests

### Phase 5: Property Tests
- [ ] Add parser property tests
- [ ] Add type system property tests
- [ ] Add query execution property tests
- [ ] Integrate with fast-check

### Phase 6: SQLLogic Tests
- [ ] Review existing SQLLogic tests
- [ ] Add missing feature coverage
- [ ] Add edge case tests
- [ ] Add error condition tests

### Phase 7: Quality
- [ ] Fix flaky tests
- [ ] Optimize slow tests
- [ ] Improve test names
- [ ] Add missing assertions
- [ ] Document test patterns
