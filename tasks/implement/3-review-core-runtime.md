---
description: Comprehensive review of runtime subsystem (emitters, scheduler, execution)
dependencies: none
priority: 3
---

# Runtime Subsystem Review

Comprehensive adversarial review of the runtime execution engine covering architecture, code quality, test coverage, and defect analysis.

## Architecture Overview

The runtime subsystem executes query plans through three phases:
1. **Emission**: Plan nodes → Instructions (via emitters in `emit/`)
2. **Scheduling**: Instruction dependency resolution and execution order
3. **Execution**: Instruction execution with context management

### Key Components

**Core Execution Engine:**
- `scheduler.ts` (488 lines) - Instruction execution with sync/async handling, tracing, and metrics
- `emitters.ts` (184 lines) - Emitter dispatch, registration, and instrumentation
- `register.ts` (153 lines) - Emitter registration for ~50 plan node types

**Context Management:**
- `context-helpers.ts` (192 lines) - Row context push/pop utilities, attribute resolution
- `emission-context.ts` (320 lines) - Schema dependency tracking and validation
- `types.ts` (243 lines) - Runtime type definitions, tracers, context trackers

**Specialized Infrastructure:**
- `deferred-constraint-queue.ts` (197 lines) - Deferred constraint evaluation with layer support
- `cache/shared-cache.ts` (170 lines) - Streaming cache with threshold-based abandonment
- `async-util.ts` (284 lines) - Async iterable utilities (tee, buffered, merge, etc.)
- `utils.ts` (179 lines) - Virtual table connection management, Hermes compatibility

**Emitters** (~50 files in `emit/`):
- Simple scalar emitters: `literal.ts`, `binary.ts`, `unary.ts`, `parameter.ts`
- Relational emitters: `scan.ts`, `filter.ts`, `project.ts`, `join.ts`, `sort.ts`
- Complex emitters: `aggregate.ts` (582 lines), `window.ts` (459 lines), `recursive-cte.ts` (112 lines)
- DML/DDL emitters: `insert.ts`, `update.ts`, `delete.ts`, `create-table.ts`, etc.

## Critical Findings

### 1. Scheduler Code Duplication (HIGH PRIORITY)

**Location**: `scheduler.ts` lines 100-290

**Issue**: Three nearly identical execution paths with ~90% code duplication:
- `runOptimized()` - lines 100-126
- `runWithTracing()` - lines 172-218  
- `runWithMetrics()` - lines 292-335

Plus async variants with similar duplication.

**Impact**: 
- Maintenance burden (bug fixes must be applied 6 times)
- Inconsistent behavior risk
- Difficult to add new execution modes

**Refactoring Strategy**:
- Extract common execution loop into `executeInstructionSequence()`
- Use strategy pattern for tracing/metrics hooks
- Single async path with unified promise handling

### 2. Large Complex Emitters (MEDIUM PRIORITY)

**Aggregate Emitter** (`emit/aggregate.ts` - 582 lines):
- Lines 78-553: Single massive `run()` function with deeply nested logic
- Lines 166-284: No-GROUP-BY case (118 lines)
- Lines 285-551: GROUP-BY case (266 lines) with complex context management
- Multiple descriptor management patterns (lines 86-112)
- Context cleanup deferred via callbacks (lines 294-401)

**Issues**:
- Hard to test individual code paths
- Context management complexity increases bug risk
- Representative row tracking logic duplicated

**Window Emitter** (`emit/window.ts` - 459 lines):
- Frame bounds calculation has TODOs (lines 386, 390, 405, 408)
- Hard-coded offset values instead of expression evaluation
- Materialization strategy not documented

**Refactoring Opportunities**:
- Extract GROUP-BY vs no-GROUP-BY into separate functions
- Extract context setup/teardown into helpers
- Extract frame calculation into separate module
- Add unit tests for frame bounds edge cases

### 3. Context Management Patterns (MEDIUM PRIORITY)

**Inconsistent Context Cleanup**:

**Good Patterns** (found in `filter.ts`, `distinct.ts`):
```typescript
yield* withRowContextGenerator(ctx, descriptor, source, async function* (row) {
  // Process row
});
```

**Problematic Patterns** (found in `aggregate.ts`):
- Manual context.set/delete with deferred cleanup callbacks (lines 294-401)
- Multiple overlapping descriptors (lines 86-112, 269-283, 368-383)
- Representative row tracking adds complexity

**Context Leak Detection**:
- `scheduler.ts` lines 92-95: Only warns, doesn't fail
- `context-helpers.ts`: No validation of push/pop balance
- Missing: Automated tests for context leaks

### 4. Error Handling Gaps (MEDIUM PRIORITY)

**Missing Error Context**:
- `scheduler.ts` line 207: Error traced but original context lost
- `scan.ts` lines 56-59, 82-85: Errors wrapped but stack traces may be lost
- `deferred-constraint-queue.ts` line 103: Constraint errors don't include row context

**Async Generator Error Propagation**:
- `scheduler.ts` lines 84-96: Plan stack tracking wraps iterables but errors may not propagate correctly
- `emitters.ts` lines 88-96: Finally block ensures stack pop, but what if generator throws during iteration?

### 5. Potential Bugs (MEDIUM PRIORITY)

**Join Emitter** (`emit/join.ts`):
- Lines 82-91: Right/full outer join TODO - not implemented
- Line 90: Comment says "TODO: Implement proper right outer join semantics"
- **Impact**: RIGHT JOIN and FULL OUTER JOIN may not work correctly

**Window Frame Bounds** (`emit/window.ts`):
- Lines 386, 390, 405, 408: TODOs for frame offset evaluation
- Currently hard-coded to `1`
- **Impact**: Window functions with `ROWS BETWEEN N PRECEDING` won't work correctly for N != 1

**Deferred Constraint Queue** (`deferred-constraint-queue.ts`):
- Line 181: `findConnection()` uses table name matching but connectionId preferred
- May match wrong connection if multiple tables have same name

## Test Coverage Gaps

**No Dedicated Runtime Tests Found**:
- Searched for `*.spec.ts` and `*.test.ts` files - none found in `runtime/`
- Runtime execution tested indirectly through `test/logic.spec.ts`

**Missing Test Categories**:

1. **Scheduler Tests**:
   - Empty instruction list
   - Single instruction execution
   - Dependency chain execution
   - Promise rejection handling
   - Context leak detection
   - Metrics collection accuracy
   - Tracing completeness

2. **Emitter Tests** (per emitter):
   - Basic execution
   - Error handling
   - Context management
   - Edge cases (empty input, null values, etc.)

3. **Context Helper Tests**:
   - Push/pop balance
   - Attribute resolution order (newest → oldest)
   - Nested context handling
   - Row slot cleanup

4. **Deferred Constraint Tests**:
   - Layer rollback/release
   - Constraint evaluation order
   - Error handling
   - Connection matching

## Documentation Gaps

**Runtime.md Coverage**:
- ✅ Good: Value types, adding plan nodes, context helpers
- ✅ Good: Common patterns, debugging pitfalls
- ⚠️ Missing: Scheduler execution modes (optimized vs tracing vs metrics)
- ⚠️ Missing: Error handling best practices
- ⚠️ Missing: Performance considerations (when to use row slots vs generators)
- ⚠️ Missing: Memory management guidelines

**Emitter Pattern Documentation**:
- No standard emitter template/checklist
- No guidance on when to use `createRowSlot` vs `withRowContextGenerator`
- No examples of complex emitter patterns (aggregate, window)

## Specific Files and Line Ranges to Review

### High Priority

1. **`scheduler.ts`** (entire file, 488 lines)
   - Lines 100-290: Code duplication refactoring
   - Lines 92-95: Context leak detection (should error, not warn?)
   - Lines 152-154: Promise.all usage safety

2. **`emit/aggregate.ts`** (entire file, 582 lines)
   - Lines 78-553: Function decomposition
   - Lines 169-181, 406-418, 431-443: DRY violations
   - Lines 294-401: Context cleanup safety

3. **`emit/join.ts`** (lines 82-91)
   - Right/full outer join implementation

4. **`emit/window.ts`** (lines 361-415)
   - Frame bounds calculation TODOs

### Medium Priority

5. **`context-helpers.ts`** (entire file, 192 lines)
   - Add context leak detection tests
   - Validate push/pop balance

6. **`deferred-constraint-queue.ts`** (lines 181-194)
   - Connection matching logic

7. **`emit/recursive-cte.ts`** (entire file, 112 lines)
   - Memory usage with large result sets
   - Iteration limit handling

8. **`emission-context.ts`** (lines 240-308)
   - Schema validation efficiency

## Refactoring Candidates with Justification

### 1. Extract Scheduler Execution Loop (HIGH)

**Current**: 6 nearly identical execution methods
**Proposed**: Single execution loop with strategy hooks

**Benefits**:
- Eliminate 400+ lines of duplication
- Single place to fix bugs
- Easier to add new execution modes

### 2. Decompose Aggregate Emitter (HIGH)

**Current**: 582-line file with 475-line function
**Proposed**: Extract into:
- `executeNoGroupByAggregate()`
- `executeGroupByAggregate()`
- `createAccumulators()`
- `finalizeAggregates()`
- `evaluateAggregateArgs()`

**Benefits**: Testable units, clearer code flow, easier to maintain

### 3. Extract Window Frame Calculation (MEDIUM)

**Current**: Frame bounds in window.ts with TODOs
**Proposed**: `window-frame.ts` module with `calculateFrameBounds()`, `evaluateFrameOffset()`

**Benefits**: Complete frame specification support, testable independently

### 4. Create Emitter Base Utilities (MEDIUM)

**Current**: Common patterns duplicated across emitters
**Proposed**: `emitter-helpers.ts` with:
- `createStreamingEmitter()` - Standard streaming pattern
- `createContextAwareEmitter()` - Context management wrapper
- `createValidatedEmitter()` - Schema validation wrapper

**Benefits**: Consistent emitter patterns, less boilerplate, fewer bugs

### 5. Add Context Leak Detection (MEDIUM)

**Current**: Warning only in scheduler
**Proposed**: 
- Strict mode that throws on leaks
- Test helper to verify no leaks
- Context tracking in all emitters

**Benefits**: Catch bugs early, prevent memory leaks, better debugging

## TODO

### Phase 1: Critical Refactoring
- [ ] **Refactor scheduler execution loop** (`scheduler.ts`)
  - Extract common execution logic into `executeInstructionSequence()`
  - Create execution hook interfaces for tracing/metrics
  - Reduce from 6 methods to 2 (sync/async) with hooks
  - Add tests for all execution modes

- [ ] **Fix join emitter right/full outer join** (`emit/join.ts`)
  - Implement proper right outer join semantics
  - Track matched right rows
  - Add tests for all join types

- [ ] **Implement window frame offset evaluation** (`emit/window.ts`)
  - Replace hard-coded offsets with expression evaluation
  - Add tests for various frame specifications
  - Document frame calculation algorithm

### Phase 2: Code Quality Improvements
- [ ] **Decompose aggregate emitter** (`emit/aggregate.ts`)
  - Extract `executeNoGroupByAggregate()`
  - Extract `executeGroupByAggregate()`
  - Extract helper functions (createAccumulators, finalizeAggregates, etc.)
  - Add unit tests for each function

- [ ] **Eliminate DRY violations**
  - Extract accumulator initialization (`aggregate.ts` lines 169-181, 406-418, 431-443)
  - Extract distinct tree creation (`aggregate.ts` lines 184-189, 419-424, 444-449)
  - Extract finalization logic (`aggregate.ts` lines 251-263, 345-362, 499-510)

- [ ] **Create emitter base utilities** (`emitter-helpers.ts`)
  - `createStreamingEmitter()` - Standard streaming pattern
  - `createContextAwareEmitter()` - Context management wrapper
  - Update emitters to use utilities

- [ ] **Fix deferred constraint connection matching** (`deferred-constraint-queue.ts`)
  - Improve connection matching logic (lines 181-194)
  - Add tests for connection matching edge cases

### Phase 3: Test Coverage
- [ ] **Create scheduler test suite** (`test/runtime/scheduler.spec.ts`)
  - Basic execution tests
  - Async execution tests
  - Context leak detection tests
  - Metrics collection tests
  - Tracing tests

- [ ] **Create context helper test suite** (`test/runtime/context-helpers.spec.ts`)
  - Attribute resolution tests
  - Row slot tests
  - Context generator tests
  - Nested context tests

- [ ] **Create emitter test suites**
  - Aggregate emitter tests (`test/runtime/emit/aggregate.spec.ts`)
  - Window emitter tests (`test/runtime/emit/window.spec.ts`)
  - Join emitter tests (`test/runtime/emit/join.spec.ts`)
  - Deferred constraint tests (`test/runtime/deferred-constraint-queue.spec.ts`)

- [ ] **Add integration tests**
  - End-to-end query execution tests
  - Error propagation tests
  - Context leak detection in real queries

### Phase 4: Documentation Updates
- [ ] **Update runtime.md**
  - Add scheduler execution modes section
  - Add error handling best practices
  - Add performance guidelines
  - Add emitter template/checklist

- [ ] **Add JSDoc comments**
  - Document scheduler public methods
  - Document context helper functions
  - Document deferred constraint queue API

- [ ] **Create emitter authoring guide**
  - When to use which context helper
  - Common patterns and pitfalls
  - Testing guidelines

### Phase 5: Performance and Memory
- [ ] **Add memory pressure detection**
  - Monitor async iterable memory usage
  - Add backpressure mechanisms
  - Document memory limits

- [ ] **Optimize window function materialization**
  - Consider streaming for large partitions
  - Add partition size limits
  - Document memory implications

- [ ] **Review connection pooling**
  - Add connection pool limits
  - Improve connection reuse
  - Add connection lifecycle tests

### Phase 6: Validation and Hardening
- [ ] **Add instruction graph validation**
  - Detect circular dependencies
  - Validate DAG structure
  - Add validation tests

- [ ] **Improve error context**
  - Preserve stack traces
  - Add instruction context to errors
  - Improve error messages

- [ ] **Add strict context leak detection**
  - Option to throw on leaks (not just warn)
  - Test helper for leak detection
  - Document leak detection usage

- [ ] **Final review pass**
  - Code review all changes
  - Performance testing
  - Documentation review
  - Test coverage verification
