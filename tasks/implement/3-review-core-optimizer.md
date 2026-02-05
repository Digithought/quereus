---
description: Comprehensive review plan for optimizer subsystem (rules, framework, analysis)
dependencies: none
priority: 3
---

# Optimizer Subsystem Review Plan

This document provides a detailed adversarial review plan for the Quereus query optimizer, identifying specific code quality issues, test coverage gaps, documentation needs, and refactoring opportunities.

## Architecture Review Findings

### Rule Application Ordering and Termination

**Files to Review:**
- `packages/quereus/src/planner/framework/pass.ts` (lines 230-354)
- `packages/quereus/src/planner/framework/registry.ts` (lines 186-239)
- `packages/quereus/src/planner/optimizer.ts` (lines 265-302)

**Issues Identified:**

1. **Pass Manager Rule Application Logic** (`pass.ts:336-352`):
   - Rules are applied sequentially within a pass, but there's no guarantee that a rule won't create a node that another rule in the same pass should handle
   - The `applyPassRules` method only checks `rule.nodeType !== currentNode.nodeType`, but after transformation, the node type may change, causing missed optimization opportunities
   - **Recommendation**: Add iteration limit or fixed-point detection for rules that transform nodes to different types

2. **Visited Rules Tracking** (`registry.ts:198-201`):
   - Rules are marked as "visited" per node ID, but if a rule transforms a node to a different type, the new node gets a new ID, potentially allowing the same rule to fire again
   - **Risk**: Could lead to infinite loops if a rule repeatedly transforms between two node types
   - **Recommendation**: Track rule application by transformation pattern, not just node ID

3. **Depth Limiting** (`optimizer.ts:304-319`):
   - `optimizeChildren` recursively calls `optimizeNode`, but depth tracking in context may not accurately reflect actual recursion depth
   - **Recommendation**: Verify depth increments correctly in multi-pass scenarios

### Physical Properties Propagation

**Files to Review:**
- `packages/quereus/src/planner/nodes/plan-node.ts` (physical property computation)
- `packages/quereus/src/planner/framework/physical-utils.ts` (lines 1-211)

**Issues Identified:**

1. **Ordering Analysis Incomplete** (`rule-aggregate-streaming.ts:119-127`):
   - `isOrderedForGrouping` always returns `false` with TODO comment
   - This causes unnecessary sorts to be inserted even when source already provides required ordering
   - **Impact**: Performance degradation from redundant sorts
   - **Recommendation**: Implement proper ordering analysis using `PlanNodeCharacteristics.getOrdering()` and column index mapping

2. **Unique Key Propagation** (`physical-utils.ts:185-210`):
   - `projectUniqueKeys` exists but may not be called consistently across projection transformations
   - **Recommendation**: Audit all ProjectNode transformations to ensure unique key propagation

### Attribute ID Preservation

**Files to Review:**
- `packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts` (lines 53-110)
- `packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts` (lines 55-167)
- `packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts` (lines 73-162)

**Issues Identified:**

1. **Attribute ID Collection** (`rule-predicate-pushdown.ts:122-130`):
   - `collectReferencedAttributeIds` walks expression tree but may miss attributes in complex nested expressions
   - Uses `walkExpr` which only checks scalar children, potentially missing relational subqueries
   - **Recommendation**: Use `binding-collector.ts` utilities consistently instead of custom walkers

2. **Attribute Combination Logic** (`rule-aggregate-streaming.ts:133-162`):
   - `combineAttributes` deduplicates by name but doesn't verify attribute ID uniqueness
   - Could create duplicate attribute IDs if source and aggregate have overlapping names but different IDs
   - **Recommendation**: Add attribute ID uniqueness check

## Code Quality Review

### DRY Violations

**Files with Duplicate Logic:**

1. **Predicate Normalization** (`rule-predicate-pushdown.ts:42`, `rule-grow-retrieve.ts:139`):
   - Both rules call `normalizePredicate` independently
   - **Recommendation**: Normalize once at rule entry point and pass normalized predicate through

2. **Constraint Extraction** (`rule-predicate-pushdown.ts:57-64`, `rule-grow-retrieve.ts:138-140`):
   - Similar constraint extraction logic duplicated
   - **Recommendation**: Extract to shared utility function

3. **Binding Collection** (`rule-predicate-pushdown.ts:67-70`, `rule-grow-retrieve.ts:132`):
   - Multiple rules collect bindings with similar patterns
   - **Recommendation**: Standardize binding collection in rule framework

4. **Table Info Creation** (`rule-predicate-pushdown.ts:57`, `rule-grow-retrieve.ts:138`):
   - `createTableInfoFromNode` called in multiple places with similar patterns
   - **Recommendation**: Cache table info in context to avoid repeated computation

### Large Functions

**Files with Functions Exceeding 100 Lines:**

1. **`rule-grow-retrieve.ts:ruleGrowRetrieve`** (lines 55-167, ~112 lines):
   - Handles both query-based and index-style module support
   - **Recommendation**: Split into `tryQueryBasedGrowth` and `tryIndexStyleGrowth` helper functions

2. **`rule-grow-retrieve.ts:fallbackIndexSupports`** (lines 219-337, ~118 lines):
   - Complex logic for translating operations to index constraints
   - **Recommendation**: Extract per-operation translation logic (Filter, Sort, LimitOffset) into separate functions

3. **`rule-quickpick-enumeration.ts:extractJoinGraph`** (lines 23-101, ~78 lines):
   - Complex graph extraction logic
   - **Recommendation**: Split into `collectRelations`, `extractEquiPredicates`, and `buildJoinGraph` functions

4. **`constraint-extractor.ts:extractConstraints`** (lines 73-127, but function continues to ~765):
   - Very large function handling multiple extraction patterns
   - **Recommendation**: Split by constraint type (equality, range, IN, etc.) into separate extractors

## Test Coverage Assessment

### Missing Unit Tests

**Rules Without Dedicated Tests:**

1. **`rule-predicate-pushdown.ts`**: No unit tests found
2. **`rule-grow-retrieve.ts`**: No unit tests found
3. **`rule-join-greedy-commute.ts`**: No unit tests found
4. **`rule-join-key-inference.ts`**: No unit tests found
5. **`rule-quickpick-enumeration.ts`**: No unit tests found
6. **`rule-aggregate-streaming.ts`**: No unit tests found
7. **`rule-cte-optimization.ts`**: No unit tests found
8. **`rule-materialization-advisory.ts`**: No unit tests found
9. **`rule-mutating-subquery-cache.ts`**: No unit tests found
10. **`rule-select-access-path.ts`**: No unit tests found

### Framework Tests

**Missing Tests:**

1. **Pass Manager** (`framework/pass.ts`):
   - No tests for pass execution order
   - No tests for traversal order (top-down vs bottom-up)
   - No tests for custom pass execution logic

2. **Rule Registry** (`framework/registry.ts`):
   - No tests for rule priority ordering
   - No tests for visited rule tracking
   - No tests for duplicate rule detection

3. **Optimization Context** (`framework/context.ts`):
   - No tests for context copying
   - No tests for depth limiting
   - No tests for optimized node caching

### Analysis Module Tests

**Missing Tests:**

1. **Constraint Extractor** (`analysis/constraint-extractor.ts`): No unit tests found
2. **Predicate Normalizer** (`analysis/predicate-normalizer.ts`): No unit tests found
3. **Binding Collector** (`analysis/binding-collector.ts`): No unit tests found
4. **Constant Evaluator** (`analysis/const-evaluator.ts`): No unit tests found

### Regression Tests

**Known Issues Without Tests:**

1. **Attribute ID Corruption**: No tests verifying attribute IDs remain stable across transformations
2. **Physical Property Propagation**: No tests verifying physical properties computed correctly
3. **Infinite Loop Prevention**: No tests for rule application termination

## Documentation Gaps

### Implementation-Documentation Mismatches

1. **Optimizer Passes** (`docs/optimizer.md:68-94`):
   - Documentation describes Pass 0-4, but actual implementation uses `PassId` enum
   - Pass execution order documented but not verified against code
   - **Recommendation**: Add code references to documentation

2. **Rule Registration** (`docs/optimizer.md:465-469`):
   - Documentation shows `registerRule()` call, but actual code uses `passManager.addRuleToPass()`
   - **Recommendation**: Update documentation to reflect pass-based registration

3. **Characteristic-Based Patterns** (`docs/optimizer-conventions.md`):
   - Documentation emphasizes characteristics over instanceof, but many rules still use `instanceof`
   - **Recommendation**: Either update rules to match documentation or update documentation to reflect current practice

### Missing Documentation

1. **Rule Execution Order**: No documentation explaining rule priority system
2. **Pass Traversal Order**: Documentation mentions top-down vs bottom-up but doesn't explain when to use each
3. **Error Handling**: No documentation on how rule failures are handled
4. **Testing Strategy**: No documentation on how to write optimizer rule tests

## Refactoring Opportunities

### High Priority

1. **Extract Predicate Analysis Utilities** (`rule-predicate-pushdown.ts`, `rule-grow-retrieve.ts`):
   - **Location**: Create `packages/quereus/src/planner/rules/shared/predicate-utils.ts`
   - **Content**: Shared functions for predicate normalization, constraint extraction, binding collection
   - **Benefit**: Eliminates DRY violations, ensures consistent predicate handling

2. **Split Large Rule Functions** (`rule-grow-retrieve.ts`):
   - **Changes**: 
     - Extract `tryQueryBasedGrowth()` (lines 93-106)
     - Extract `tryIndexStyleFallback()` (lines 108-123)
   - **Benefit**: Improves readability, enables unit testing of individual strategies

3. **Implement Ordering Analysis** (`rule-aggregate-streaming.ts`):
   - **Location**: `rule-aggregate-streaming.ts:119-127`
   - **Changes**: Implement `isOrderedForGrouping()` using `PlanNodeCharacteristics.getOrdering()` and column mapping
   - **Benefit**: Prevents unnecessary sorts, improves performance

4. **Standardize Attribute ID Collection**:
   - **Location**: Create `packages/quereus/src/planner/rules/shared/attribute-utils.ts`
   - **Content**: Centralized attribute ID collection from expressions
   - **Benefit**: Consistent attribute handling, reduces bugs

### Medium Priority

5. **Refactor Constraint Extractor** (`constraint-extractor.ts`):
   - Split into `EqualityExtractor`, `RangeExtractor`, `InExtractor`, `NullExtractor` classes
   - **Benefit**: Easier to test, easier to extend

6. **Improve Type Safety in Capability Detectors** (`characteristics.ts`):
   - Replace `(node as any)` casts with proper type guards
   - **Benefit**: Better type safety, catches errors at compile time

## Specific Files and Line Ranges to Review

### Critical Review Areas

1. **`packages/quereus/src/planner/framework/pass.ts`**
   - Lines 336-352: Rule application logic
   - Lines 280-303: Top-down traversal
   - Lines 308-331: Bottom-up traversal

2. **`packages/quereus/src/planner/framework/registry.ts`**
   - Lines 186-239: Rule application with visited tracking
   - Lines 198-201: Visited rule check (potential loop issue)

3. **`packages/quereus/src/planner/optimizer.ts`**
   - Lines 265-302: Node optimization with caching
   - Lines 304-319: Child optimization

4. **`packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts`**
   - Lines 53-110: Pushdown logic (attribute ID handling)
   - Lines 112-120: Project eligibility check

5. **`packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts`**
   - Lines 55-167: Main growth logic (large function)
   - Lines 219-337: Index-style fallback (large function)

6. **`packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts`**
   - Lines 119-127: Incomplete ordering analysis
   - Lines 133-162: Attribute combination logic

7. **`packages/quereus/src/planner/analysis/constraint-extractor.ts`**
   - Lines 73-765: Very large extraction function
   - Lines 129-150: Covered key detection logic

8. **`packages/quereus/src/planner/framework/characteristics.ts`**
   - Lines 254-374: Capability detectors with type casts
   - Lines 468-489: Predicate analysis utilities

## TODO

### Phase 1: Critical Fixes and Tests
- [ ] Fix incomplete ordering analysis in `rule-aggregate-streaming.ts` (lines 119-127)
- [ ] Add unit tests for all optimization rules (10 rules × ~5 scenarios each = 50 tests)
- [ ] Add regression tests for attribute ID preservation
- [ ] Add tests for rule application termination (infinite loop prevention)
- [ ] Fix visited rule tracking to prevent transformation loops (`registry.ts:198-201`)
- [ ] Add attribute ID uniqueness check in `combineAttributes` (`rule-aggregate-streaming.ts:133-162`)

### Phase 2: DRY Violations and Refactoring
- [ ] Extract shared predicate utilities (`predicate-utils.ts`)
- [ ] Extract shared attribute utilities (`attribute-utils.ts`)
- [ ] Split `rule-grow-retrieve.ts` into smaller functions
- [ ] Split `constraint-extractor.ts` by constraint type
- [ ] Cache table info in optimization context
- [ ] Standardize binding collection across rules

### Phase 3: Framework Improvements
- [ ] Improve type safety in capability detectors (remove `as any` casts)
- [ ] Add rule metadata system for self-documentation
- [ ] Add option to fail fast on rule errors in debug mode
- [ ] Add trace hooks for `withChildren()` transformations
- [ ] Document rule priority system and execution order

### Phase 4: Documentation and Testing Infrastructure
- [ ] Update optimizer.md to match actual implementation (pass registration)
- [ ] Add testing guide for optimizer rules
- [ ] Add code references to documentation
- [ ] Document error handling strategy
- [ ] Add plan equivalence verification tests
- [ ] Add cost estimation accuracy tests

### Phase 5: Advanced Improvements
- [ ] Implement proper ordering analysis for streaming aggregates
- [ ] Add rule execution order documentation
- [ ] Add pass traversal order guidance
- [ ] Extract join graph utilities for reuse
- [ ] Add rule metadata with examples and test cases
