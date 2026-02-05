---
description: Comprehensive review of virtual table subsystem (VTab interface, Memory table, cursors)
dependencies: none
priority: 3
---

# Virtual Table Subsystem Review Plan

This document provides a comprehensive adversarial review plan for the virtual table subsystem, which is central to Quereus's architecture.

## 1. Scope

The virtual table subsystem includes:

### Core VTab Interface (`src/vtab/`)
- `types.ts` - VTab type definitions and interfaces
- `manifest.ts` - Module manifest system
- `cursor.ts` - Cursor interfaces and utilities
- `events.ts` - VTab event system
- `constraint-info.ts` - Query constraint handling
- `index-info.ts` - Index information structure
- `module-wrapper.ts` - Module lifecycle management

### Memory Table Implementation (`src/vtab/memory/`)
- `index.ts` - Main MemoryTable implementation
- `layer/` - MVCC isolation layers
- `utils/` - Primary key, indexing utilities
- `cursor/` - Memory table cursors

### Supporting Infrastructure
- `src/vtab/table-function.ts` - Table-valued functions
- `src/vtab/create-module.ts` - Module creation utilities

## 2. Architecture Assessment

### VTab Interface Design

**Strengths:**
- Clean separation of module vs table vs cursor
- Flexible constraint and index info system
- Event-based change notification
- Supports both query-based and index-style access

**Concerns:**
- Complex interface hierarchy may be hard to implement
- Constraint pushdown API complexity
- Connection lifecycle management
- Error handling patterns

### Memory Table Implementation

**Strengths:**
- MVCC isolation via layers
- Efficient B-tree indexing (digitree)
- Supports primary keys and secondary indexes
- Change tracking for reactive queries

**Concerns:**
- Memory growth with many versions
- Layer cleanup complexity
- Index maintenance overhead
- Transaction rollback complexity

### Module Wrapper System

**Strengths:**
- Automatic lifecycle management
- Connection pooling potential
- Manifest-based configuration

**Concerns:**
- Wrapper overhead
- State synchronization
- Error propagation

## 3. Specific Files and Line Ranges to Review

### High Priority

**`src/vtab/types.ts`** (~300 lines)
- Lines 1-100: Core interfaces (VTabModule, VTable, VTabCursor)
- Lines 100-200: Constraint and index structures
- Lines 200-300: Event and result types

**Issues to check:**
- Interface completeness for all use cases
- Type safety of constraint values
- Optional vs required methods
- Async method consistency

**`src/vtab/memory/index.ts`** (~600 lines)
- Lines 1-100: MemoryTable class definition
- Lines 100-250: CRUD operations (insert, update, delete)
- Lines 250-400: Query execution (xBestIndex, xFilter)
- Lines 400-500: Index management
- Lines 500-600: Transaction support

**Issues to check:**
- Layer lifecycle management
- Index consistency during mutations
- Primary key validation
- Event emission correctness

**`src/vtab/memory/layer/transaction.ts`** (~250 lines)
- Lines 1-80: TransactionLayer class
- Lines 80-160: Mutation tracking
- Lines 160-250: Merge and rollback logic

**Issues to check:**
- Version isolation correctness
- Merge conflict handling
- Rollback completeness
- Memory cleanup

**`src/vtab/constraint-info.ts`** (~200 lines)
- Lines 1-100: Constraint representation
- Lines 100-200: Constraint evaluation utilities

**Issues to check:**
- All operator types handled
- NULL handling in constraints
- Collation propagation
- Type coercion

### Medium Priority

**`src/vtab/memory/utils/primary-key.ts`** (~150 lines)
- Primary key generation
- Key comparison
- Key validation

**`src/vtab/memory/cursor/scan.ts`** (~200 lines)
- Full table scan implementation
- Filter application
- Row iteration

**`src/vtab/memory/cursor/index.ts`** (~180 lines)
- Index-based access
- Range scan
- Point lookup

**`src/vtab/events.ts`** (~100 lines)
- Event type definitions
- Event emission
- Listener management

**`src/vtab/module-wrapper.ts`** (~150 lines)
- Module wrapping logic
- Lifecycle hooks
- Connection management

### Lower Priority

**`src/vtab/manifest.ts`** (~80 lines)
- Manifest structure
- Validation

**`src/vtab/table-function.ts`** (~120 lines)
- Table function interface
- Parameter handling

**`src/vtab/create-module.ts`** (~100 lines)
- Module factory
- Registration

## 4. DRY Violations and Code Quality Issues

### Repeated Patterns

1. **Constraint Checking** (multiple files)
   ```typescript
   if (constraint.op === ConstraintOp.EQ) { ... }
   else if (constraint.op === ConstraintOp.LT) { ... }
   // etc.
   ```
   **Found in**: constraint-info.ts, memory/index.ts, cursor files
   **Recommendation**: Create constraint evaluation utility

2. **Layer Access Pattern** (memory/ files)
   ```typescript
   const layer = this.getCurrentLayer();
   // ... use layer
   ```
   **Recommendation**: Create layer accessor abstraction

3. **Event Emission** (multiple files)
   ```typescript
   this.emit('change', { table, operation, row });
   ```
   **Recommendation**: Create typed event emitter

### Large Functions

1. **`MemoryTable.xBestIndex()`** (~100 lines)
   - Constraint analysis
   - Index selection
   - Cost estimation
   - Should decompose into focused functions

2. **`MemoryTable.xFilter()`** (~80 lines)
   - Constraint application
   - Cursor creation
   - Should extract constraint application

3. **`TransactionLayer.merge()`** (~60 lines)
   - Version merging logic
   - Conflict detection
   - Should decompose by operation type

### Error Handling Inconsistencies

**In memory/index.ts:**
- Some throw Error
- Some throw QuereusError
- Some return error codes

**Recommendation:** Standardize on QuereusError

## 5. Test Coverage Gaps

### Missing Tests for VTab Interface

```typescript
// test/vtab/interface.spec.ts
describe('VTab Interface', () => {
  describe('module lifecycle', () => {
    it('creates module')
    it('connects to table')
    it('disconnects from table')
    it('destroys module')
  })
  
  describe('cursor operations', () => {
    it('opens cursor')
    it('iterates rows')
    it('closes cursor')
    it('handles multiple cursors')
  })
  
  describe('constraint handling', () => {
    it('passes constraints to xBestIndex')
    it('applies constraints in xFilter')
    it('handles unsupported constraints')
  })
})
```

### Missing Tests for MemoryTable

```typescript
// test/vtab/memory/table.spec.ts
describe('MemoryTable', () => {
  describe('CRUD operations', () => {
    it('inserts row')
    it('updates row')
    it('deletes row')
    it('handles primary key conflict')
    it('handles missing row')
  })
  
  describe('indexing', () => {
    it('uses primary key index')
    it('uses secondary index')
    it('falls back to scan')
    it('estimates cost correctly')
  })
  
  describe('transactions', () => {
    it('isolates changes')
    it('commits changes')
    it('rolls back changes')
    it('handles nested transactions')
  })
  
  describe('events', () => {
    it('emits on insert')
    it('emits on update')
    it('emits on delete')
    it('batches events')
  })
})
```

### Missing Tests for MVCC

```typescript
// test/vtab/memory/mvcc.spec.ts
describe('MVCC', () => {
  describe('isolation', () => {
    it('isolates uncommitted changes')
    it('shows committed changes')
    it('handles concurrent modifications')
  })
  
  describe('layer management', () => {
    it('creates transaction layer')
    it('merges on commit')
    it('discards on rollback')
    it('cleans up old versions')
  })
  
  describe('conflict detection', () => {
    it('detects write-write conflict')
    it('handles read-write conflict')
    it('resolves conflicts correctly')
  })
})
```

### Integration Tests Needed

```typescript
// test/vtab/integration.spec.ts
describe('VTab Integration', () => {
  describe('with query engine', () => {
    it('handles SELECT queries')
    it('handles INSERT queries')
    it('handles UPDATE queries')
    it('handles DELETE queries')
    it('handles JOIN queries')
  })
  
  describe('constraint pushdown', () => {
    it('pushes equality constraints')
    it('pushes range constraints')
    it('pushes IN constraints')
    it('handles non-pushable constraints')
  })
  
  describe('with transactions', () => {
    it('participates in transactions')
    it('handles transaction rollback')
    it('handles savepoints')
  })
})
```

## 6. Documentation Gaps

### Missing Documentation

1. **VTab Implementation Guide** (`docs/vtab.md`)
   - Interface requirements
   - Lifecycle methods
   - Constraint handling
   - Best practices

2. **Memory Table Internals** (`docs/memory-table.md`)
   - MVCC design
   - Layer architecture
   - Index structures
   - Performance characteristics

3. **Event System** (`docs/vtab-events.md`)
   - Event types
   - Listener patterns
   - Batching behavior

4. **Constraint Pushdown** (`docs/constraint-pushdown.md`)
   - How pushdown works
   - Implementing xBestIndex
   - Cost estimation

### Code Comments Needed

- Interface method JSDoc
- Complex algorithm explanations
- Error condition documentation

## 7. Refactoring Candidates

### High Priority

1. **Extract Constraint Evaluation**
   ```typescript
   // New utility
   class ConstraintEvaluator {
     evaluate(constraint: Constraint, value: SqlValue): boolean
     canPushDown(constraint: Constraint, capabilities: Capabilities): boolean
   }
   ```

2. **Decompose xBestIndex**
   ```typescript
   // Before: monolithic function
   xBestIndex(indexInfo: IndexInfo): void
   
   // After: composed functions
   xBestIndex(indexInfo: IndexInfo): void {
     const usableConstraints = this.analyzeConstraints(indexInfo);
     const bestIndex = this.selectIndex(usableConstraints);
     const cost = this.estimateCost(bestIndex, usableConstraints);
     this.populateIndexInfo(indexInfo, bestIndex, cost);
   }
   ```

3. **Standardize Error Handling**
   ```typescript
   // Consistent error types
   class VTabError extends QuereusError {
     constructor(code: VTabErrorCode, message: string, context?: object)
   }
   ```

### Medium Priority

4. **Extract Layer Manager**
   ```typescript
   // Encapsulate layer logic
   class LayerManager {
     getCurrentLayer(): Layer
     beginTransaction(): TransactionLayer
     commit(layer: TransactionLayer): void
     rollback(layer: TransactionLayer): void
   }
   ```

5. **Create Typed Event Emitter**
   ```typescript
   // Type-safe events
   class VTabEventEmitter<Events extends VTabEvents> {
     on<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): void
   }
   ```

### Lower Priority

6. **Index Selection Optimization**
   - More sophisticated cost model
   - Statistics-based estimation
   - Adaptive selection

7. **Cursor Pool**
   - Cursor reuse
   - Connection pooling
   - Resource limits

## 8. Potential Bugs

### High Probability

1. **Layer Leak on Error**
   - Transaction layer not cleaned up on error
   - Memory accumulation

2. **Index Inconsistency**
   - Index not updated on all mutation paths
   - Phantom rows

3. **Event Ordering**
   - Events emitted in wrong order
   - Missing events

### Medium Probability

4. **Constraint Pushdown Edge Cases**
   - NULL handling in constraints
   - Collation mismatch
   - Type coercion issues

5. **Concurrent Access**
   - Race conditions in layer access
   - Lost updates
   - Dirty reads

6. **Memory Growth**
   - Old versions not cleaned up
   - Index memory leak
   - Event listener accumulation

## 9. Performance Considerations

### Known Issues
- Full table scan for non-indexed queries
- Memory overhead of MVCC
- Index maintenance cost

### Optimization Opportunities
- Lazy index building
- Batch mutation optimization
- Cursor caching
- Statistics maintenance

## 10. TODO

### Phase 1: Critical Fixes
- [ ] Fix layer cleanup on error
- [ ] Standardize error handling
- [ ] Add constraint validation
- [ ] Document VTab interface

### Phase 2: Test Coverage
- [ ] Create VTab interface tests
- [ ] Create MemoryTable unit tests
- [ ] Create MVCC isolation tests
- [ ] Create integration tests
- [ ] Add edge case coverage

### Phase 3: Refactoring
- [ ] Extract constraint evaluation utility
- [ ] Decompose xBestIndex
- [ ] Extract layer manager
- [ ] Create typed event emitter

### Phase 4: Documentation
- [ ] Complete VTab implementation guide
- [ ] Document Memory Table internals
- [ ] Document event system
- [ ] Add JSDoc to all interfaces

### Phase 5: Performance
- [ ] Profile critical paths
- [ ] Optimize index selection
- [ ] Add cursor caching
- [ ] Implement batch mutations

### Phase 6: Advanced Features
- [ ] Add statistics collection
- [ ] Implement cursor pool
- [ ] Add connection pool
- [ ] Support index hints
