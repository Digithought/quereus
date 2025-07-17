# Characteristics-Based Optimizer Migration Plan

This document outlines the practical steps for migrating the Quereus optimizer from fragile node-specific dependencies to robust characteristics-based patterns.

## Overview

We are establishing a new optimization paradigm that focuses on **what nodes can do** rather than **what nodes are**. This migration will:

1. Replace hard-coded `instanceof` checks with interface-based capability detection
2. Use physical properties for optimization decisions
3. Enable symbolic refactoring without breaking optimizer rules
4. Make the system more extensible for new node types

## Current Problematic Patterns

### Hard-Coded Type Checks
```typescript
// ❌ Fragile patterns found in codebase
if (node instanceof FilterNode) { /* ... */ }
if (node.nodeType === PlanNodeType.Aggregate) { /* ... */ }
if (!(node instanceof JoinNode)) return null;
```

### Index-Based Property Access
```typescript
// ❌ Fragile dynamic references
const predicate = (node as any).predicate;
const joinType = (node as FilterNode).joinType;
```

### Node-Specific Rule Logic
```typescript
// ❌ Rules tied to specific implementations
function ruleForSpecificNode(node: SpecificNode) {
  return node.specificProperty ? transform(node) : null;
}
```

## New Characteristics-Based Patterns

### Physical Property-Based Decisions
```typescript
// ✅ Robust characteristics-based checks
if (PlanNodeCharacteristics.hasSideEffects(node)) { /* handle mutation */ }
if (PlanNodeCharacteristics.hasOrderedOutput(node)) { /* use ordering */ }
```

### Interface-Based Capabilities
```typescript
// ✅ Capability-based detection
if (CapabilityDetectors.isAggregating(node)) {
  const aggregateExpressions = node.getAggregateExpressions();
  // ... handle any aggregation-capable node
}
```

### Extensible Rule Framework
```typescript
// ✅ Rules that work with any compatible node
function ruleBasedOnCharacteristics(node: PlanNode, context: OptContext): PlanNode | null {
  if (!CapabilityDetectors.canPushDownPredicate(node)) return null;
  if (PlanNodeCharacteristics.hasSideEffects(node)) return null;
  
  return optimizePredicate(node as PredicateCapable, context);
}
```

## Implementation Files

### Core Framework
- ✅ `src/planner/framework/characteristics.ts` - Main characteristics system
- ✅ `docs/optimizer-conventions.md` - Updated development guidelines
- ✅ `test/optimizer/characteristics.spec.ts` - Test framework

### Refactored Rules (Examples)
- ✅ `src/planner/rules/cache/rule-mutating-subquery-cache.ts` - Uses JoinCapable
- ✅ `src/planner/rules/aggregate/rule-aggregate-streaming.ts` - Uses AggregationCapable

## Migration Phases

### Phase 1: Foundation (✅ Complete)
1. ✅ **Create characteristics framework** - Core utilities and interfaces
2. ✅ **Establish patterns** - Documentation and guidelines
3. ✅ **Demonstrate with examples** - Refactor 2-3 key rules
4. ✅ **Create test infrastructure** - Validate characteristics system
5. ✅ **Fix all linter errors** - Type-safe interfaces and proper inheritance
6. ✅ **Verify build and tests** - All TypeScript builds clean, tests pass

### Phase 2: Interface Implementation (✅ Complete)
**Summary**: Updated all priority plan nodes to implement capability interfaces, enabling robust characteristics-based optimization rules.

**Completed Implementations:**

✅ **JoinNode** - Already implemented `JoinCapable`
- `getJoinType()`: Returns 'inner' | 'left' | 'right' | 'full' | 'cross'
- `getJoinCondition()`: Returns join condition or null
- `getLeftSource()` / `getRightSource()`: Returns join operands

✅ **FilterNode** - Implemented `PredicateCapable`  
- `getPredicate()`: Returns the WHERE clause predicate
- `withPredicate()`: Creates new FilterNode with different predicate
- Enables predicate pushdown optimization

✅ **AggregateNode** - Already implemented `AggregationCapable`
- `getGroupingKeys()`: Returns GROUP BY expressions
- `getAggregateExpressions()`: Returns aggregate functions with attribute IDs
- `requiresOrdering()` / `canStreamAggregate()`: Optimization hints

✅ **ProjectNode** - Implemented `ProjectionCapable`
- `getProjections()`: Returns SELECT list with attribute IDs
- `withProjections()`: Creates new ProjectNode with different projections
- Preserves attribute ID stability across transformations

✅ **SortNode** - Implemented `SortCapable`
- `getSortKeys()`: Returns ORDER BY expressions with directions
- `withSortKeys()`: Creates new SortNode with different sort criteria
- Enables sort optimization and elimination

✅ **SeqScanNode** - Implemented `TableAccessCapable`
- `tableSchema`: Exposes accessed table metadata
- `getAccessMethod()`: Returns 'sequential'
- Enables access path optimization decisions

✅ **IndexScanNode** - Implemented `TableAccessCapable`  
- `tableSchema`: Exposes accessed table metadata
- `getAccessMethod()`: Returns 'index-scan'
- Enables index-aware optimizations

✅ **IndexSeekNode** - Implemented `TableAccessCapable`
- `tableSchema`: Exposes accessed table metadata  
- `getAccessMethod()`: Returns 'index-seek'
- Enables point lookup optimizations

**Impact:**
- **Eliminates fragile `instanceof` checks** in optimization rules
- **Enables extensibility** - new node types work automatically with existing rules
- **Improves maintainability** - rules self-document their requirements
- **Provides type safety** - compile-time verification of capability interfaces
- **All 95 tests pass** - no regression in functionality

### Phase 3: Rule Migration (📋 Next)
Update remaining optimization rules to use characteristics:

**High Priority Rules:**
- `rule-select-access-path.ts` - Use TableAccessCapable
- `rule-cte-optimization.ts` - Use caching characteristics
- `rule-materialization-advisory.ts` - Use performance characteristics

**Medium Priority:**
- Predicate pushdown rules (when implemented)
- Join reordering rules (when implemented)
- Projection optimization rules

### Phase 4: Builder Updates (✅ Complete)
**Summary**: Successfully migrated all plan builders from fragile `instanceof` checks to robust characteristics-based patterns, eliminating hard-coded type dependencies in the planning phase.

**Completed Implementations:**

✅ **select-aggregates.ts** - Updated `instanceof ColumnReferenceNode` checks
- Replaced with `CapabilityDetectors.isColumnReference()` calls
- Enables projection optimization rules to work with any column reference capability

✅ **select-window.ts** - Updated `instanceof WindowFunctionCallNode` check
- Replaced with `CapabilityDetectors.isWindowFunction()` calls  
- Added proper type casting after capability detection
- Fixed duplicate import issues

✅ **select.ts** - Updated `instanceof InternalRecursiveCTERefNode` check
- Replaced with `CapabilityDetectors.isRecursiveCTERef()` calls
- Enables CTE optimization rules to work with any recursive CTE reference capability

✅ **select-projections.ts** - Updated multiple `instanceof` checks
- `instanceof AggregateFunctionCallNode` → `CapabilityDetectors.isAggregateFunction()`
- `instanceof WindowFunctionCallNode` → `CapabilityDetectors.isWindowFunction()`
- Added proper type casting for function collection logic

✅ **select-modifiers.ts** - Updated `instanceof ColumnReferenceNode` check
- Replaced with `CapabilityDetectors.isColumnReference()` calls
- Enables ORDER BY optimization to work with any column reference capability

✅ **function-call.ts** - Updated `instanceof AggregateFunctionCallNode` check  
- Replaced with `CapabilityDetectors.isAggregateFunction()` calls
- Enables aggregate function matching to work with any aggregate function capability

**Enhanced Capability Detectors:**

✅ **Precise Type Discrimination** - Enhanced detectors to distinguish between similar node types:
- `isWindowFunction()` checks `nodeType === 'WindowFunctionCall'` to distinguish from aggregate functions
- `isAggregateFunction()` checks for `args` and `functionSchema` properties to distinguish from window functions
- Both types have similar properties (`functionName`, `isDistinct`) but serve different purposes

✅ **Null Safety** - Added defensive programming:
- All detectors now check `if (!node) return false` to handle undefined/null cases
- Eliminates runtime errors when detectors are called on invalid inputs

**Impact:**
- **Eliminates all remaining `instanceof` checks** in plan builders  
- **Future-proof builders** - new node types implementing capabilities work automatically
- **Type safety** - compile-time verification of capability interfaces
- **Improved maintainability** - builders self-document their node requirements
- **All 95 tests pass** - zero regression in functionality
- **Enhanced debugging** - clearer capability-based error messages

### Phase 5: Validation & Testing (📋 Planned)
1. **Comprehensive testing** - All characteristics work correctly
2. **Performance validation** - No regression in optimization quality
3. **Integration testing** - End-to-end SQL queries work as expected
4. **Documentation updates** - All examples use new patterns

## Benefits Validation

### Before: Fragile Dependencies
- Rule breaks when node property is renamed
- New node types require rule modifications
- Hard to understand rule requirements
- Tight coupling between optimizer and node structure

### After: Robust Characteristics
- Rules work regardless of internal property names
- New node types work automatically if they implement interfaces
- Rules self-document their requirements through capability checks
- Clean separation between optimization logic and node implementation

## Risk Mitigation

### Compatibility During Migration
- Keep both old and new patterns during transition
- Gradual migration without breaking existing functionality
- Comprehensive test coverage at each phase

### Performance Considerations
- Characteristics detection is O(1) interface checks
- Physical properties are cached, not recomputed
- No significant overhead vs. instanceof checks

### Rollback Strategy
- Each phase is independent and can be reverted
- Existing rules continue to work during migration
- Git commits are granular for easy rollback

## Examples of Success

### Mutating Subquery Cache Rule
**Before:**
```typescript
if (!(node instanceof JoinNode)) return null;
if (rightSide.nodeType === PlanNodeType.Cache) return null;
```

**After:**
```typescript
if (!CapabilityDetectors.isJoin(node)) return null;
if (CapabilityDetectors.isCached(rightSide) && rightSide.isCached()) return null;
```

**Benefits:**
- Works with any join-capable node, not just JoinNode
- Clear intent: "this rule works with joins that can be cached"
- Extensible: new join implementations work automatically

### Aggregate Streaming Rule  
**Before:**
```typescript
if (!(node instanceof AggregateNode)) return null;
const groupBy = node.groupBy;
```

**After:**
```typescript
if (!CapabilityDetectors.isAggregating(node)) return null;
if (PlanNodeCharacteristics.hasSideEffects(node)) return null;
const groupingKeys = (node as AggregationCapable).getGroupingKeys();
```

**Benefits:**
- Works with any aggregation-capable node
- Additional safety check for side effects
- Self-documenting rule requirements

## Next Steps

1. **Immediate (Phase 2):** Update 3-5 key plan nodes to implement capability interfaces
2. **Short-term:** Migrate 5-10 more optimization rules to use characteristics
3. **Medium-term:** Complete node interface implementation and rule migration
4. **Long-term:** Establish linting rules to prevent regression to old patterns

## Success Metrics

- **Code Quality:** Elimination of all `instanceof` checks in optimizer rules
- **Extensibility:** Ability to add new node types without modifying existing rules
- **Maintainability:** Rules clearly document their requirements through capability checks
- **Performance:** No degradation in optimization quality or execution speed
- **Safety:** Ability to refactor node properties without breaking optimizer

This migration establishes a foundation for sustainable, extensible optimization that will serve the project well as it grows in complexity and scope.
