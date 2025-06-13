# Optimizer Coding Conventions

This document establishes coding conventions and best practices for developing optimizer rules in the Quereus Titan optimizer.

## File Organization

### Rule Structure
- Each rule lives in `src/planner/rules/<area>/rule-<name>.ts`
- Areas include: `rewrite`, `access`, `join`, `aggregate`, `cache`, `pushdown`
- Rule names should be descriptive: `rule-predicate-pushdown.ts`, `rule-aggregate-streaming.ts`

### Rule Function Signature
All rules must be pure functions with this exact signature:
```typescript
type RuleFn = (node: PlanNode, context: OptContext) => PlanNode | null;
```

**Key principles:**
- Return `null` if rule is not applicable
- Return a new `PlanNode` if transformation was applied
- **Never mutate** the incoming `PlanNode` - always create new instances
- Rules must be deterministic and side-effect free
- **NEW**: Access optimizer via `context.optimizer`, database via `context.db`, tuning via `context.tuning`

## Rule Implementation Guidelines

### 1. Guard Clauses First
Start every rule with type and applicability checks:
```typescript
export function ruleAggregateStreaming(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: only apply to AggregateNode
	if (!(node instanceof AggregateNode)) {
		return null;
	}

	// Guard: check preconditions
	if (node.groupBy.length === 0) {
		return null; // No grouping, different rule applies
	}

	// Actual transformation logic...
}
```

### 2. Preserve Attribute IDs
When creating new nodes, **always preserve original attribute IDs**:
```typescript
// ✅ CORRECT - preserve attributes from original node
return new StreamAggregateNode(
	node.scope,
	source, // Source already optimized by framework
	node.groupBy,
	node.aggregates,
	undefined, // estimatedCostOverride
	node.getAttributes() // Preserve original attribute IDs
);

// ❌ WRONG - creates new attribute IDs
return new StreamAggregateNode(
	node.scope,
	source,
	node.groupBy,
	node.aggregates
); // Missing attribute preservation
```

### 3. Framework Handles Children and Properties
**IMPORTANT**: The framework now handles child optimization and physical properties automatically:

```typescript
// ✅ CORRECT - let framework handle children and properties
export function ruleMyTransformation(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof MyNode)) return null;
	
	// Source is already optimized by framework - just use it
	const result = new TransformedNode(node.scope, node.source, node.params);
	
	// Framework will set physical properties via markPhysical()
	return result;
}

// ❌ WRONG - manually optimizing children (redundant)
export function badRule(node: PlanNode, context: OptContext): PlanNode | null {
	const optimizedSource = context.optimizer.optimizeNode(node.source, context); // Don't do this!
	return new TransformedNode(node.scope, optimizedSource, node.params);
}

// ❌ WRONG - manually setting physical properties (bypasses framework)
export function badRule(node: PlanNode, context: OptContext): PlanNode | null {
	const result = new TransformedNode(node.scope, node.source, node.params);
	PlanNode.setDefaultPhysical(result, { /* properties */ }); // Don't do this!
	return result;
}
```

### 4. Cost and Row Estimation (Optional)
Rules may use cost helpers for decision-making, but framework handles physical properties:
```typescript
import { sortCost, aggregateCost } from '../../cost/index.js';
import { getRowEstimate } from '../../stats/basic-estimates.js';

// Use for rule decisions, not for setting properties
const inputRows = getRowEstimate(node.source, context.tuning);
const sortCostEstimate = sortCost(inputRows);

if (sortCostEstimate > context.tuning.maxSortCost) {
	return null; // Don't apply this transformation
}
```

### 5. Physical Properties (Framework Managed)
**DO NOT manually set physical properties** - the framework handles this automatically:

```typescript
// ✅ CORRECT - let framework compute properties
const transformedNode = new SortNode(node.scope, node.source, sortKeys);
return transformedNode; // Framework will call markPhysical()

// ❌ WRONG - manually setting properties (bypasses framework logic)
const transformedNode = new SortNode(node.scope, node.source, sortKeys);
PlanNode.setDefaultPhysical(transformedNode, { /* properties */ }); // Don't do this!
return transformedNode;
```

**How Properties Are Computed:**
- Framework calls `optimizeChildren()` first
- Then applies rules to get transformed node
- Finally calls `markPhysical()` which:
  - Collects properties from all children
  - Calls node's `getPhysical(childrenProperties)` if implemented
  - Computes inheritance of `readonly`, `deterministic` flags
  - Sets final properties on the node

### 6. Logging and Debugging
Use consistent logging patterns:
```typescript
import { createLogger } from '../../../common/logger.js';

const log = createLogger('optimizer:rule:aggregate-streaming');

export function ruleAggregateStreaming(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof AggregateNode)) return null;

	log('Applying aggregate streaming rule to node %s', node.id);
	
	// ... transformation logic
	
	log('Transformed AggregateNode to StreamAggregateNode with sort');
	return result;
}
```

## Testing Requirements

### Unit Tests
Every rule **must** have unit tests in the test/optimizer directory as `<rule-name>.spec.ts`:

```typescript
// src/planner/rules/aggregate/rule-aggregate-streaming.spec.ts
import { describe, it, expect } from 'mocha';
import { ruleAggregateStreaming } from './rule-aggregate-streaming.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
// ... other imports

describe('ruleAggregateStreaming', () => {
	it('should transform AggregateNode with GROUP BY to StreamAggregateNode', () => {
		// Test positive case
		const aggregate = new AggregateNode(/* ... */);
		const result = ruleAggregateStreaming(aggregate, mockContext);
		
		expect(result).to.be.instanceOf(StreamAggregateNode);
		expect(result?.getAttributes()).to.deep.equal(aggregate.getAttributes());
	});

	it('should return null for non-AggregateNode', () => {
		// Test guard clause
		const filter = new FilterNode(/* ... */);
		const result = ruleAggregateStreaming(filter, mockContext);
		
		expect(result).to.be.null;
	});

	it('should return null for AggregateNode without GROUP BY', () => {
		// Test precondition
		const aggregate = new AggregateNode(/* groupBy: [] */);
		const result = ruleAggregateStreaming(aggregate, mockContext);
		
		expect(result).to.be.null;
	});
});
```

### Required Test Cases
Every rule must test:
1. **Positive case** - rule applies and transforms correctly
2. **Guard clause** - rule returns null for wrong node type
3. **Precondition** - rule returns null when preconditions not met
4. **Attribute preservation** - transformed node preserves original attribute IDs

## Rule Registration

### Registration Pattern
Rules are registered in the optimizer using a consistent pattern:
```typescript
// In src/planner/optimizer-rules.ts or rule-specific file
import { ruleAggregateStreaming } from './rules/aggregate/rule-aggregate-streaming.js';

registerRule({
	id: 'Aggregate→StreamAggregate',
	nodeType: PlanNodeType.Aggregate,
	phase: 'impl', // 'rewrite' for logical→logical, 'impl' for logical→physical
	fn: ruleAggregateStreaming
});
```

### Rule Phases
- **rewrite**: Logical-to-logical transformations (predicate pushdown, join reordering)
- **impl**: Logical-to-physical transformations (Aggregate → StreamAggregate)

## Error Handling

### Rule Failures
Rules should not throw exceptions under normal circumstances:
```typescript
// ✅ CORRECT - return null for non-applicable cases
if (!isValidPrecondition) {
	return null;
}

// ❌ WRONG - don't throw for normal non-applicable cases
if (!isValidPrecondition) {
	quereusError('Rule not applicable');
}
```

### Internal Errors
Only throw for actual programming errors:
```typescript
// ✅ CORRECT - throw for programming errors
if (node.getAttributes().length === 0) {
	quereusError(`Internal error: ${node.nodeType} has no attributes`);
}
```

## Performance Guidelines

### Rule Efficiency
- Keep rules lightweight - they're called frequently
- Use early returns to avoid expensive computations
- Cache expensive calculations in local variables

```typescript
export function expensiveRule(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	if (!(node instanceof ExpensiveNode)) return null;

	// Cache expensive computation
	const rowEstimate = getRowEstimate(node.source, optimizer.tuning);
	if (rowEstimate < THRESHOLD) return null;

	// Use cached value in multiple places
	const cost1 = calculateCost1(rowEstimate);
	const cost2 = calculateCost2(rowEstimate);
	// ...
}
```

### Memory Management
- Don't hold references to transformed nodes
- Let optimizer handle node lifecycle
- Avoid creating large intermediate data structures

## Common Anti-Patterns

### ❌ Mutating Input Nodes
```typescript
// WRONG - mutates input
function badRule(node: AggregateNode, context: OptContext): PlanNode | null {
	node.physical = { /* ... */ }; // Mutates input!
	return node;
}
```

### ❌ Creating New Attribute IDs
```typescript
// WRONG - loses attribute ID mapping
return new ProjectNode(scope, source, projections); // Uses new attribute IDs
```

### ❌ Manually Optimizing Children
```typescript
// WRONG - framework already handles this
function badRule(node: PlanNode, context: OptContext): PlanNode | null {
	const optimizedSource = context.optimizer.optimizeNode(node.source, context); // Redundant!
	return new TransformedNode(scope, optimizedSource, params);
}
```

### ❌ Manually Setting Physical Properties
```typescript
// WRONG - bypasses framework logic  
function badRule(node: PlanNode, context: OptContext): PlanNode | null {
	const result = new TransformedNode(scope, node.source, params);
	PlanNode.setDefaultPhysical(result, { /* properties */ }); // Framework handles this!
	return result;
}
```

### ❌ Side Effects
```typescript
// WRONG - has side effects
function badRule(node: PlanNode, context: OptContext): PlanNode | null {
	context.tuning.defaultRowEstimate = 5000; // Mutates context state!
	return transformedNode;
}
```

### ❌ Non-Deterministic Rules
```typescript
// WRONG - non-deterministic
function badRule(node: PlanNode, context: OptContext): PlanNode | null {
	if (Math.random() > 0.5) { // Non-deterministic!
		return transformedNode;
	}
	return null;
}
```

## File Template

Use this template for new rules:
```typescript
/**
 * Rule: <Brief Description>
 * 
 * Transforms: <InputNodeType> → <OutputNodeType>
 * Conditions: <When this rule applies>
 * Benefits: <Why this optimization helps>
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { InputNodeType } from '../../nodes/input-node.js';
import { OutputNodeType } from '../../nodes/output-node.js';

const log = createLogger('optimizer:rule:<rule-name>');

export function rule<RuleName>(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: node type check
	if (!(node instanceof InputNodeType)) {
		return null;
	}

	// Guard: precondition checks
	if (!meetsPreConditions(node)) {
		return null;
	}

	log('Applying <rule-name> rule to node %s', node.id);

	// Source is already optimized by framework - just use it
	// Create transformed node
	const result = new OutputNodeType(
		node.scope,
		node.source, // Already optimized by framework
		// ... other parameters
		node.getAttributes() // Preserve attribute IDs
	);

	// Framework will set physical properties automatically via markPhysical()
	
	log('Transformed %s to %s', node.nodeType, result.nodeType);
	return result;
}

function meetsPreConditions(node: InputNodeType): boolean {
	// Implementation-specific precondition checks
	return true;
}
```

This convention ensures consistent, maintainable, and testable optimizer rules that integrate seamlessly with the Titan optimizer architecture. 
