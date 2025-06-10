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
type OptimizationRule = (node: PlanNode, optimizer: Optimizer) => PlanNode | null;
```

**Key principles:**
- Return `null` if rule is not applicable
- Return a new `PlanNode` if transformation was applied
- **Never mutate** the incoming `PlanNode` - always create new instances
- Rules must be deterministic and side-effect free

## Rule Implementation Guidelines

### 1. Guard Clauses First
Start every rule with type and applicability checks:
```typescript
export function ruleAggregateStreaming(node: PlanNode, optimizer: Optimizer): PlanNode | null {
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
	optimizedSource,
	node.groupBy,
	node.aggregates,
	undefined, // estimatedCostOverride
	node.getAttributes() // Preserve original attribute IDs
);

// ❌ WRONG - creates new attribute IDs
return new StreamAggregateNode(
	node.scope,
	optimizedSource,
	node.groupBy,
	node.aggregates
); // Missing attribute preservation
```

### 3. Cost and Row Estimation
Use the cost helpers and row estimators:
```typescript
import { sortCost, aggregateCost } from '../../cost/index.js';
import { getRowEstimate } from '../../stats/basic-estimates.js';

// Estimate costs using helpers
const inputRows = getRowEstimate(node.source, optimizer.tuning);
const sortCostEstimate = sortCost(inputRows);
const aggCostEstimate = aggregateCost(inputRows, outputRows);
```

### 4. Physical Properties
Set physical properties on transformed nodes:
```typescript
const transformedNode = new SortNode(node.scope, optimizedSource, sortKeys);

// Use the helper to set default physical properties
PlanNode.setDefaultPhysical(transformedNode, {
	ordering: sortKeys.map((key, idx) => ({ column: idx, desc: key.direction === 'desc' })),
	estimatedRows: inputRows
});

return transformedNode;
```

### 5. Logging and Debugging
Use consistent logging patterns:
```typescript
import { createLogger } from '../../../common/logger.js';

const log = createLogger('optimizer:rule:aggregate-streaming');

export function ruleAggregateStreaming(node: PlanNode, optimizer: Optimizer): PlanNode | null {
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
		const result = ruleAggregateStreaming(aggregate, mockOptimizer);
		
		expect(result).to.be.instanceOf(StreamAggregateNode);
		expect(result?.getAttributes()).to.deep.equal(aggregate.getAttributes());
	});

	it('should return null for non-AggregateNode', () => {
		// Test guard clause
		const filter = new FilterNode(/* ... */);
		const result = ruleAggregateStreaming(filter, mockOptimizer);
		
		expect(result).to.be.null;
	});

	it('should return null for AggregateNode without GROUP BY', () => {
		// Test precondition
		const aggregate = new AggregateNode(/* groupBy: [] */);
		const result = ruleAggregateStreaming(aggregate, mockOptimizer);
		
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
	throw new Error('Rule not applicable');
}
```

### Internal Errors
Only throw for actual programming errors:
```typescript
// ✅ CORRECT - throw for programming errors
if (node.getAttributes().length === 0) {
	throw new Error(`Internal error: ${node.nodeType} has no attributes`);
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
function badRule(node: AggregateNode, optimizer: Optimizer): PlanNode | null {
	node.physical = { /* ... */ }; // Mutates input!
	return node;
}
```

### ❌ Creating New Attribute IDs
```typescript
// WRONG - loses attribute ID mapping
return new ProjectNode(scope, source, projections); // Uses new attribute IDs
```

### ❌ Side Effects
```typescript
// WRONG - has side effects
function badRule(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	optimizer.tuning.defaultRowEstimate = 5000; // Mutates optimizer state!
	return transformedNode;
}
```

### ❌ Non-Deterministic Rules
```typescript
// WRONG - non-deterministic
function badRule(node: PlanNode, optimizer: Optimizer): PlanNode | null {
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
import type { Optimizer } from '../../optimizer.js';
import { InputNodeType } from '../../nodes/input-node.js';
import { OutputNodeType } from '../../nodes/output-node.js';

const log = createLogger('optimizer:rule:<rule-name>');

export function rule<RuleName>(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	// Guard: node type check
	if (!(node instanceof InputNodeType)) {
		return null;
	}

	// Guard: precondition checks
	if (!meetsPreConditions(node)) {
		return null;
	}

	log('Applying <rule-name> rule to node %s', node.id);

	// Optimization logic here
	const optimizedSource = optimizer.optimizeNode(node.source);
	
	// Create transformed node
	const result = new OutputNodeType(
		node.scope,
		optimizedSource,
		// ... other parameters
		node.getAttributes() // Preserve attribute IDs
	);

	// Set physical properties
	PlanNode.setDefaultPhysical(result, {
		// ... properties specific to this transformation
	});

	log('Transformed %s to %s', node.nodeType, result.nodeType);
	return result;
}

function meetsPreConditions(node: InputNodeType): boolean {
	// Implementation-specific precondition checks
	return true;
}
```

This convention ensures consistent, maintainable, and testable optimizer rules that integrate seamlessly with the Titan optimizer architecture. 
