---
description: Plan comprehensive review of optimizer subsystem (rules, framework, analysis)
dependencies: none
priority: 3
---

# Optimizer Subsystem Review Planning

Plan a thorough adversarial review of the query optimizer, which transforms logical plans to physical plans.

## Scope

Files in `packages/quereus/src/planner/`:
- `optimizer.ts` - Main optimizer driver
- `optimizer-tuning.ts` - Optimization parameters
- `framework/` - Rule application infrastructure
- `rules/` - Optimization rules (predicate pushdown, join reordering, etc.)
- `analysis/` - Plan analysis (const evaluation, binding collection, etc.)
- `cost/` - Cost estimation
- `stats/` - Statistics and cardinality estimation
- `cache/` - CTE and materialization decisions

Documentation:
- `docs/optimizer.md`
- `docs/optimizer-conventions.md`
- `docs/optimizer-const.md`

## Review Objectives

The planned review tasks should:

1. **Architecture Review**
   - Rule application ordering and termination guarantees
   - Physical properties propagation correctness
   - Attribute preservation through transformations
   - withChildren() pattern consistency

2. **Code Quality Review**
   - Rule modularity and single responsibility
   - DRY violations across similar rules
   - Framework extensibility design
   - Tracing/debugging infrastructure quality

3. **Test Coverage Assessment**
   - Rule-by-rule unit tests
   - Regression tests for known optimizer bugs
   - Plan equivalence verification
   - Cost estimation accuracy tests

4. **Defect Analysis**
   - Potential infinite rule application loops
   - Attribute ID corruption scenarios
   - Physical property miscalculation
   - Missing optimization opportunities

## Output

This planning task produces detailed review tasks covering:
- Each optimization rule's correctness and tests
- Framework infrastructure robustness
- Cost model accuracy validation
- Documentation-implementation alignment
