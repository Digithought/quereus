---
description: Comprehensive review of planner subsystem (plan building, scopes, nodes)
dependencies: none
priority: 3
---

# Planner Subsystem Review Plan

This document outlines a thorough adversarial review of the planner subsystem, which converts AST to PlanNodes. The planner is a critical component responsible for semantic correctness, symbol resolution, and initial plan construction before optimization.

## Architecture Overview

The planner subsystem (`packages/quereus/src/planner/`) consists of:

- **Building functions** (`building/`): Convert AST statements to PlanNode trees (~25 builder files)
- **Plan nodes** (`nodes/`): ~50 node types implementing PlanNode hierarchy
- **Scopes** (`scopes/`): Symbol resolution system (AliasedScope, MultiScope, RegisteredScope, etc.)
- **Planning context**: State management for planning session (dependencies, schema cache, CTE cache)
- **Resolution utilities**: Schema/function/column resolution (`resolve.ts`)
- **Type utilities**: Type inference and compatibility (`type-utils.ts`)

## Key Findings

### Code Quality Issues

#### 1. DRY Violations in Scope Creation Patterns

**Location**: Multiple builder files (`select.ts`, `insert.ts`, `update.ts`, `delete.ts`, `select-window.ts`)

**Issue**: Repeated pattern of creating `RegisteredScope`, iterating over attributes, and registering symbols

**Files to review**:
- `packages/quereus/src/planner/building/select.ts:192-198` (window output scope)
- `packages/quereus/src/planner/building/select.ts:288-294` (recursive CTE scope)
- `packages/quereus/src/planner/building/insert.ts:358-369` (mutation context scope)
- `packages/quereus/src/planner/building/insert.ts:532-558` (returning scope)
- `packages/quereus/src/planner/building/select.ts:514-527` (mutating subquery scope)

**Refactoring candidate**: Extract to `createColumnScope(node: RelationalPlanNode, parentScope: Scope): RegisteredScope` utility function.

#### 2. Large Builder Functions

**Location**: `packages/quereus/src/planner/building/select.ts`

**Issue**: `buildSelectStmt()` is ~230 lines with complex control flow handling aggregates, window functions, projections, and modifiers.

**Lines to review**: `packages/quereus/src/planner/building/select.ts:54-229`

**Refactoring opportunity**: Consider splitting into phase-specific builders:
- `buildSelectPhase0_CTEs()`
- `buildSelectPhase1_FromAndWhere()`
- `buildSelectPhase2_Projections()`
- `buildSelectPhase3_Aggregates()`
- `buildSelectPhase4_Windows()`
- `buildSelectPhase5_Modifiers()`

#### 3. Duplicate Attribute ID Assignment Logic

**Location**: Multiple node constructors

**Issue**: Pattern of preserving attribute IDs for column references vs. generating new IDs for expressions is repeated across nodes

**Files to review**:
- `packages/quereus/src/planner/nodes/project-node.ts:127-150`
- `packages/quereus/src/planner/nodes/returning-node.ts` (similar pattern expected)

**Refactoring candidate**: Extract to `createAttributeFromProjection(proj: Projection, index: number, outputType: RelationType): Attribute` helper.

#### 4. Inconsistent Error Handling

**Location**: `packages/quereus/src/planner/building/select.ts:89-94`

**Issue**: Multiple FROM sources error throws `UNSUPPORTED` but comment says "maybe never will be" - inconsistent with actual join support via `buildJoin()`.

**Review**: Verify if this error path is reachable given join support exists.

#### 5. Monkey Patching Anti-Pattern

**Location**: `packages/quereus/src/planner/building/select.ts:342`

**Issue**: TODO comment indicates monkey patching that should be replaced with proper interface

**Action**: Identify the patching location and design proper interface.

### Missing Test Coverage

#### 1. Scope Resolution Edge Cases

**Test scenarios needed**:
- Ambiguous symbol resolution across multiple scopes (MultiScope behavior)
- CTE shadowing of table names
- Parameter resolution with mixed named/positional parameters
- Schema-qualified vs. unqualified resolution ordering
- Recursive CTE scope isolation

**Test location**: `packages/quereus/test/planner/scope-resolution.spec.ts` (create new)

#### 2. Complex Query Planning

**Test scenarios needed**:
- Nested subqueries with correlated references
- Multiple CTEs with cross-references
- Window functions with ORDER BY dependencies
- Aggregates with HAVING referencing SELECT aggregates
- Compound SELECT (UNION/INTERSECT) with different column counts
- Mutating subqueries in FROM clause

**Test location**: Extend `packages/quereus/test/plan/` golden plan tests

#### 3. Attribute ID Stability

**Test scenarios needed**:
- Projection preserving attribute IDs through multiple transformations
- Join attribute ID mapping correctness
- CTE reference attribute ID consistency across multiple references
- Optimizer transformations preserving attribute IDs

**Test location**: `packages/quereus/test/planner/attribute-stability.spec.ts` (create new)

#### 4. Error Handling Paths

**Test scenarios needed**:
- Invalid schema-qualified table references
- Ambiguous column references
- Function resolution failures (wrong arity, missing function)
- Type mismatch errors in expressions
- Constraint violation during planning (e.g., duplicate CTE names)

**Test location**: `packages/quereus/test/planner/error-handling.spec.ts` (create new)

### Documentation Gaps

#### 1. Scope System Documentation

**Missing**: Comprehensive guide to scope composition and symbol resolution order.

**Location**: `docs/planner-scopes.md` (create new)

**Content needed**:
- Scope hierarchy and parent-child relationships
- Symbol resolution algorithm (order of scopes checked)
- When to use RegisteredScope vs. AliasedScope vs. MultiScope
- CTE scope isolation rules
- Parameter scope behavior

#### 2. Builder Function Patterns

**Missing**: Guide to writing new builder functions.

**Location**: `docs/planner-building.md` (create new)

**Content needed**:
- Planning context usage patterns
- Scope creation conventions
- Attribute ID assignment rules
- Schema dependency tracking
- Error handling conventions

#### 3. Plan Node Implementation Guide

**Missing**: Guide for implementing new PlanNode types.

**Location**: Update `docs/optimizer.md` or create `docs/plan-nodes.md`

**Content needed**:
- Required method implementations (`getType()`, `getAttributes()`, `withChildren()`)
- Physical property computation patterns
- Attribute ID preservation rules
- When to use `Cached` for expensive computations

### Refactoring Opportunities

#### 1. Extract Scope Creation Utilities

**Files**: `packages/quereus/src/planner/util/scope-utils.ts` (create new)

**Functions to extract**:
- `createColumnScope(node: RelationalPlanNode, parentScope: Scope): RegisteredScope`
- `createAliasedColumnScope(node: RelationalPlanNode, alias: string, parentScope: Scope): AliasedScope`
- `createCombinedScope(scopes: Scope[]): MultiScope`

**Impact**: Reduces ~100 lines of duplicated code across builders.

#### 2. Standardize Attribute Creation

**Files**: `packages/quereus/src/planner/util/attribute-utils.ts` (create new)

**Functions to extract**:
- `createAttributeFromProjection(proj: Projection, index: number, outputType: RelationType): Attribute`
- `preserveAttributeId(node: ScalarPlanNode, defaultId: number): number`
- `mapAttributesThroughProjection(sourceAttrs: Attribute[], projections: Projection[]): Attribute[]`

**Impact**: Ensures consistent attribute ID handling across all nodes.

#### 3. Decompose buildSelectStmt Further

**Current**: Main function handles 6+ phases inline.

**Proposed**: Extract phase functions with clear interfaces

**Impact**: Improves testability and readability.

### Specific Code Review Targets

#### High Priority Files

1. **`packages/quereus/src/planner/building/select.ts`** (601 lines)
   - Review: Lines 54-229 (`buildSelectStmt` main function)
   - Review: Lines 267-543 (`buildFrom` function)
   - Focus: Control flow complexity, scope management

2. **`packages/quereus/src/planner/building/insert.ts`** (589 lines)
   - Review: Lines 32-127 (`createRowExpansionProjection`)
   - Review: Lines 137-264 (`buildUpsertClausePlans`)
   - Review: Lines 321-589 (`buildInsertStmt`)
   - Focus: Scope creation patterns, attribute ID handling

3. **`packages/quereus/src/planner/nodes/project-node.ts`** (338 lines)
   - Review: Lines 106-188 (`getAttributes` implementation)
   - Review: Lines 46-104 (`getType` implementation)
   - Focus: Attribute ID preservation logic, caching patterns

4. **`packages/quereus/src/planner/scopes/multi.ts`** (40 lines)
   - Review: Lines 25-38 (`resolveSymbol` implementation)
   - Focus: Ambiguity handling, resolution order

5. **`packages/quereus/src/planner/planning-context.ts`** (198 lines)
   - Review: Lines 38-117 (`BuildTimeDependencyTracker`)
   - Focus: Memory management, weak reference usage

#### Medium Priority Files

6. **`packages/quereus/src/planner/building/update.ts`**
   - Review: Scope creation for OLD/NEW references
   - Review: Row descriptor construction

7. **`packages/quereus/src/planner/building/delete.ts`**
   - Review: RETURNING clause handling
   - Review: OLD row reference scope

8. **`packages/quereus/src/planner/nodes/join-node.ts`** (337 lines)
   - Review: Lines 47-237 (`computePhysical` - complex key inference)
   - Focus: Equi-join pair detection, key coverage logic

9. **`packages/quereus/src/planner/resolve.ts`** (102 lines)
   - Review: All resolution functions
   - Focus: Error message consistency, ambiguity handling

10. **`packages/quereus/src/planner/type-utils.ts`**
    - Review: Type compatibility checking
    - Focus: Edge cases, nullable type handling

### Defect Analysis Targets

#### 1. Attribute ID Stability

**Risk**: Attribute IDs must remain stable across optimizer transformations. Verify:

- ProjectNode preserves attribute IDs for column references
- JoinNode correctly maps left/right attribute IDs
- CTE reference nodes use cached attribute IDs
- Optimizer rules preserve attribute IDs in `withChildren()` calls

**Test approach**: Create test that builds plan, optimizes it, and verifies attribute ID consistency.

#### 2. Memory Leaks in Planning Context

**Risk**: `BuildTimeDependencyTracker` uses `WeakRef` but may retain references elsewhere.

**Review targets**:
- `packages/quereus/src/planner/planning-context.ts:41-52` (WeakRef usage)
- Verify `schemaCache` is cleared after planning
- Check CTE reference cache lifecycle

#### 3. Scope Resolution Ordering

**Risk**: Incorrect scope resolution order could cause wrong symbol resolution.

**Test scenarios**:
- CTE shadowing table name
- Inner scope shadowing outer scope
- MultiScope resolution order (first match vs. ambiguity)

#### 4. Type Inference Accuracy

**Risk**: Incorrect type inference could cause runtime errors.

**Review targets**:
- `packages/quereus/src/planner/type-utils.ts` (all functions)
- Expression type inference in `buildExpression`
- Aggregate function return types
- Window function return types

## TODO

### Phase 1: Code Quality Improvements
- [ ] Extract scope creation utilities (`createColumnScope`, `createAliasedColumnScope`)
- [ ] Extract attribute creation utilities (`createAttributeFromProjection`, `preserveAttributeId`)
- [ ] Refactor `buildSelectStmt` into phase-specific functions
- [ ] Remove monkey patching anti-pattern in `select.ts:342`
- [ ] Standardize error messages in `resolve.ts`
- [ ] Review and fix inconsistent error handling in `select.ts:89-94`

### Phase 2: Test Coverage
- [ ] Create `test/planner/scope-resolution.spec.ts` with edge cases
- [ ] Create `test/planner/attribute-stability.spec.ts` with transformation tests
- [ ] Create `test/planner/error-handling.spec.ts` with error path tests
- [ ] Add golden plan tests for complex queries (nested subqueries, multiple CTEs)
- [ ] Add tests for mutating subqueries in FROM clause
- [ ] Add tests for window function ORDER BY dependencies

### Phase 3: Documentation
- [ ] Create `docs/planner-scopes.md` documenting scope system
- [ ] Create `docs/planner-building.md` documenting builder patterns
- [ ] Update `docs/optimizer.md` with plan node implementation guide
- [ ] Document attribute ID preservation rules
- [ ] Document schema dependency tracking usage

### Phase 4: Defect Analysis
- [ ] Verify attribute ID stability across all optimizer transformations
- [ ] Audit memory management in `BuildTimeDependencyTracker`
- [ ] Test scope resolution ordering with comprehensive test suite
- [ ] Review type inference accuracy with edge case tests
- [ ] Verify CTE reference cache consistency

### Phase 5: Node-by-Node Review
- [ ] Review all 50+ node types for consistent `getAttributes()` patterns
- [ ] Review all nodes for correct `withChildren()` implementations
- [ ] Verify `computePhysical()` implementations follow conventions
- [ ] Check attribute ID preservation in all transformation methods
- [ ] Verify all nodes properly implement required interfaces

### Phase 6: Integration Review
- [ ] Test planner-optimizer integration (attribute ID preservation)
- [ ] Test planner-runtime integration (schema dependency invalidation)
- [ ] Verify planning context lifecycle (creation, usage, cleanup)
- [ ] Test error propagation from planner to optimizer
- [ ] Verify schema change invalidation triggers correctly
