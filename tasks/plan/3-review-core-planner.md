---
description: Plan comprehensive review of planner subsystem (plan building, scopes, nodes)
dependencies: none
priority: 3
---

# Planner Subsystem Review Planning

Plan a thorough adversarial review of the planner subsystem, which converts AST to PlanNodes.

## Scope

Files in `packages/quereus/src/planner/`:
- `building/` - Plan construction from AST (select, insert, update, delete, DDL)
- `nodes/` - PlanNode class hierarchy (~50 node types)
- `scopes/` - Symbol resolution scopes (aliased, multi, registered, etc.)
- `planning-context.ts` - Planning state management
- `resolve.ts` - Schema/function resolution
- `type-utils.ts` - Type inference utilities

## Review Objectives

The planned review tasks should:

1. **Architecture Review**
   - PlanNode inheritance hierarchy consistency
   - Scope composition patterns (MultiScope, AliasedScope)
   - Builder function organization and reuse
   - Planning context lifecycle

2. **Code Quality Review**
   - Single responsibility in builders (e.g., select.ts is large)
   - DRY violations across similar node types
   - Attribute system consistency across all nodes
   - getAttributes()/getType() implementation patterns

3. **Test Coverage Assessment**
   - Complex query planning edge cases
   - Scope resolution corner cases
   - Error handling paths during planning
   - Schema dependency tracking accuracy

4. **Defect Analysis**
   - Attribute ID stability across all transformations
   - Memory leaks in planning context
   - Type inference accuracy
   - Scope resolution ordering correctness

## Output

This planning task produces detailed review tasks covering:
- Node-by-node implementation verification
- Builder function refactoring candidates
- Scope system robustness tests
- Documentation alignment with implementation
