# Optimizer Conventions: Characteristics-Based Patterns

This document establishes sustainable patterns for the Quereus optimizer to avoid fragile node-specific dependencies and enable robust, extensible optimization rules.

## Philosophy: Characteristics Over Identity

The optimizer should make decisions based on **what nodes can do** (characteristics) rather than **what nodes are** (specific types). This approach:

- **Eliminates fragility**: No hard-coded assumptions about specific node types
- **Enables extensibility**: New node types automatically work with existing rules
- **Improves maintainability**: Rules are self-documenting about their requirements
- **Supports symbolic refactoring**: Member names can be changed without breaking dynamic references

## Core Principles

### 1. Physical Properties First
Use the physical properties system as the primary way to understand node capabilities:

```typescript
// ❌ Fragile: Hard-coded node type check
if (node instanceof UpdateNode || node instanceof DeleteNode) {
  // handle mutating operations
}

// ✅ Robust: Physical property check
if (PlanNode.hasSideEffects(node.physical)) {
  // handle operations with side effects
}
```

### 2. Interface-Based Capabilities
Define interfaces that capture what nodes can do, not what they are:

```typescript
// ❌ Fragile: Checking specific node types
if (node instanceof FilterNode || node instanceof JoinNode) {
  // Both have predicates, but different structures
}

// ✅ Robust: Interface for predicate capability
interface HasPredicate {
  getPredicate(): ScalarPlanNode | null;
}

function canPushDownPredicate(node: PlanNode): node is HasPredicate {
  return 'getPredicate' in node && typeof node.getPredicate === 'function';
}
```

### 3. Utility Functions for Characteristics
Create reusable functions that detect characteristics across node types:

```typescript
// ✅ Characteristic detection utilities
export class PlanNodeCharacteristics {
  static hasOrderedOutput(node: PlanNode): boolean {
    return node.physical.ordering !== undefined && node.physical.ordering.length > 0;
  }
  
  static isConstantValue(node: PlanNode): node is ConstantNode {
    return node.physical.constant === true && 'getValue' in node;
  }
  
  static estimatesRows(node: PlanNode): number {
    return node.physical.estimatedRows ?? DEFAULT_ROW_ESTIMATE;
  }
}
```

## Pattern Categories

### Access Path Selection

**Problem**: Rules need to identify table access patterns
**Solution**: Interface-based table access capabilities

```typescript
interface TableAccessNode extends RelationalPlanNode {
  readonly tableSchema: TableSchema;
  getAccessMethod(): 'sequential' | 'index-scan' | 'index-seek';
}

function isTableAccess(node: PlanNode): node is TableAccessNode {
  return isRelationalNode(node) && 'tableSchema' in node;
}
```

### Predicate Operations

**Problem**: Rules need to work with predicates across different node types
**Solution**: Unified predicate interface

```typescript
interface PredicateCapable {
  getPredicate(): ScalarPlanNode | null;
  withPredicate(newPredicate: ScalarPlanNode | null): PlanNode;
}

interface PredicateCombinable extends PredicateCapable {
  canCombinePredicates(): boolean;
  combineWith(other: ScalarPlanNode): ScalarPlanNode;
}
```

### Aggregation Detection

**Problem**: Multiple ways to represent aggregation operations
**Solution**: Aggregation capability interface

```typescript
interface AggregationCapable extends RelationalPlanNode {
  getGroupingKeys(): readonly ScalarPlanNode[];
  getAggregateExpressions(): readonly { expr: ScalarPlanNode; alias: string }[];
  requiresOrdering(): boolean;
}

function isAggregating(node: PlanNode): node is AggregationCapable {
  return isRelationalNode(node) && 'getGroupingKeys' in node;
}
```

### Caching Eligibility

**Problem**: Determining what can be cached
**Solution**: Physical properties + interface checks

```typescript
export class CachingAnalysis {
  static isCacheable(node: PlanNode): boolean {
    // Must be relational to cache results
    if (!isRelationalNode(node)) return false;
    
    // Already cached nodes don't need re-caching
    if (this.isAlreadyCached(node)) return false;
    
    // Check physical properties for side effects
    const physical = node.physical;
    if (PlanNode.hasSideEffects(physical)) {
      // Only cache if execution would be expensive and repeated
      return this.isExpensiveRepeatedOperation(node);
    }
    
    return true;
  }
  
  private static isAlreadyCached(node: PlanNode): boolean {
    return 'cacheStrategy' in node && node.cacheStrategy !== null;
  }
}
```

## Migration Patterns

### From instanceof to Interface Checks

```typescript
// Before: Hard-coded type checks
function oldRule(node: PlanNode): PlanNode | null {
  if (node instanceof FilterNode) {
    const filter = node as FilterNode;
    // ... work with filter.predicate
  } else if (node instanceof JoinNode) {
    const join = node as JoinNode;
    // ... work with join.condition
  }
  return null;
}

// After: Interface-based approach
function newRule(node: PlanNode): PlanNode | null {
  if (canPushDownPredicate(node)) {
    const predicate = node.getPredicate();
    if (predicate && canOptimizePredicate(predicate)) {
      return optimizePredicateNode(node, predicate);
    }
  }
  return null;
}
```

### From nodeType Checks to Property Checks

```typescript
// Before: Enumeration-based checks
if (node.nodeType === PlanNodeType.Sort || 
    node.nodeType === PlanNodeType.StreamAggregate) {
  // Handle ordered operations
}

// After: Property-based checks
if (PlanNodeCharacteristics.hasOrderedOutput(node)) {
  // Handle any node that produces ordered output
}
```

## Framework Utilities

### Core Characteristic Detectors

```typescript
export class PlanNodeCharacteristics {
  // Physical property shortcuts
  static hasSideEffects = PlanNode.hasSideEffects;
  static isReadOnly(node: PlanNode): boolean {
    return node.physical.readonly !== false;
  }
  static isDeterministic(node: PlanNode): boolean {
    return node.physical.deterministic !== false;
  }
  static isConstant(node: PlanNode): node is ConstantNode {
    return node.physical.constant === true && 'getValue' in node;
  }
  
  // Ordering capabilities
  static hasOrderedOutput(node: PlanNode): boolean {
    return node.physical.ordering !== undefined && node.physical.ordering.length > 0;
  }
  static preservesOrdering(node: PlanNode): boolean {
    // Check if node preserves input ordering
    const children = node.getChildren();
    return children.length === 1 && this.hasOrderedOutput(children[0]);
  }
  
  // Cardinality analysis
  static estimatesRows(node: PlanNode): number {
    return node.physical.estimatedRows ?? DEFAULT_ROW_ESTIMATE;
  }
  static guaranteesUniqueRows(node: PlanNode): boolean {
    return node.physical.uniqueKeys?.some(key => key.length === 0) === true;
  }
  
  // Relational capabilities
  static isRelational = isRelationalNode;
  static producesRows(node: PlanNode): node is RelationalPlanNode {
    return isRelationalNode(node);
  }
}
```

### Capability Interface Registry

```typescript
export class CapabilityRegistry {
  private static readonly detectors = new Map<string, (node: PlanNode) => boolean>();
  
  static register<T extends PlanNode>(
    capability: string,
    detector: (node: PlanNode) => node is T
  ): void {
    this.detectors.set(capability, detector);
  }
  
  static hasCapability(node: PlanNode, capability: string): boolean {
    const detector = this.detectors.get(capability);
    return detector ? detector(node) : false;
  }
  
  static getCapable<T extends PlanNode>(
    nodes: readonly PlanNode[], 
    capability: string
  ): T[] {
    const detector = this.detectors.get(capability);
    if (!detector) return [];
    return nodes.filter(detector) as T[];
  }
}

// Usage in rules:
CapabilityRegistry.register('predicate-pushdown', canPushDownPredicate);
CapabilityRegistry.register('table-access', isTableAccess);
```

## Rule Development Guidelines

### 1. Start with Capabilities
Before writing a rule, identify what characteristics the rule needs:

```typescript
function ruleMyOptimization(node: PlanNode, context: OptContext): PlanNode | null {
  // 1. Check required capabilities
  if (!PlanNodeCharacteristics.isRelational(node)) return null;
  if (PlanNodeCharacteristics.hasSideEffects(node)) return null;
  
  // 2. Check specific interfaces if needed
  if (!isSpecializedCapability(node)) return null;
  
  // 3. Apply transformation based on characteristics
  return transformBasedOnCharacteristics(node, context);
}
```

### 2. Prefer Composition over Inheritance
Use interfaces to compose capabilities rather than relying on inheritance hierarchies:

```typescript
interface Sortable {
  getSortKeys(): readonly SortKey[];
  withSortKeys(keys: readonly SortKey[]): PlanNode;
}

interface Projectable {
  getProjections(): readonly Projection[];
  withProjections(projections: readonly Projection[]): PlanNode;
}

// Nodes implement multiple interfaces as appropriate
class SortedProjectNode implements RelationalPlanNode, Sortable, Projectable {
  // ... implementation
}
```

### 3. Document Required Characteristics
Make rule requirements explicit in documentation:

```typescript
/**
 * Rule: Predicate Pushdown
 * 
 * Required Characteristics:
 * - Node must implement PredicateCapable interface
 * - Node must be read-only (no side effects)
 * - Predicate must be deterministic
 * 
 * Applied When:
 * - Child node supports predicate pushdown
 * - Predicate references only child's output columns
 */
export function rulePushDownPredicate(node: PlanNode, context: OptContext): PlanNode | null {
  // Implementation follows documented requirements
}
```

## Benefits of This Approach

1. **Symbolic Rename Safety**: Member names can be changed without breaking optimizer
2. **Extensibility**: New node types work automatically with existing rules
3. **Maintainability**: Clear separation between node structure and optimization logic
4. **Testability**: Characteristics can be tested independently of specific nodes
5. **Documentation**: Rules self-document their requirements through capability checks

## Migration Strategy

1. **Phase 1**: Create characteristic utilities and interfaces
2. **Phase 2**: Update existing rules one by one
3. **Phase 3**: Establish testing patterns for characteristics
4. **Phase 4**: Update documentation and examples
5. **Phase 5**: Add linting rules to prevent regression

This approach ensures the optimizer remains robust and extensible as the system grows in complexity. 
