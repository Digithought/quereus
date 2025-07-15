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
1. **Create characteristics framework** - Core utilities and interfaces
2. **Establish patterns** - Documentation and guidelines
3. **Demonstrate with examples** - Refactor 2-3 key rules
4. **Create test infrastructure** - Validate characteristics system

### Phase 2: Interface Implementation (🚧 Next)
Update plan nodes to implement capability interfaces:

```typescript
// Priority nodes to update:
- JoinNode → implement JoinCapable
- FilterNode → implement PredicateCapable  
- AggregateNode → implement AggregationCapable
- SeqScanNode, IndexScanNode → implement TableAccessCapable
- ProjectNode → implement ProjectionCapable
- SortNode → implement SortCapable
```

Example implementation:
```typescript
export class JoinNode extends RelationalNode implements JoinCapable {
  // ... existing implementation

  // Add JoinCapable interface methods
  getJoinType(): 'inner' | 'left' | 'right' | 'full' | 'cross' {
    return this.joinType;
  }

  getJoinCondition(): ScalarPlanNode | null {
    return this.condition;
  }

  getLeftSource(): RelationalPlanNode {
    return this.left;
  }

  getRightSource(): RelationalPlanNode {
    return this.right;
  }
}
```

### Phase 3: Rule Migration (📋 Planned)
Update remaining optimization rules to use characteristics:

**High Priority Rules:**
- `rule-select-access-path.ts` - Use TableAccessCapable
- `rule-cte-optimization.ts` - Use caching characteristics
- `rule-materialization-advisory.ts` - Use performance characteristics

**Medium Priority:**
- Predicate pushdown rules (when implemented)
- Join reordering rules (when implemented)
- Projection optimization rules

### Phase 4: Builder Updates (📋 Planned)
Update plan builders to avoid hard-coded type checks:

```typescript
// Current pattern in builders:
if (scalarNode instanceof ColumnReferenceNode) {
  // ... handle column reference
}

// New pattern:
if (CapabilityDetectors.isColumnReference(scalarNode)) {
  // ... handle any column reference capability
}
```

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