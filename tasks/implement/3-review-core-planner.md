---
description: Comprehensive review of planner subsystem (plan building, scopes, nodes)
dependencies: none
priority: 3
---

# Planner Subsystem Review

## Goal

Conduct an adversarial review of the planner subsystem to ensure semantic correctness, predictable name/symbol resolution, and attribute ID stability. Validate AST→PlanNode conversion and the contracts the optimizer/runtime rely on.

## Scope

- **Builders**: AST statement → PlanNode conversion (`src/planner/building/`)
- **Plan nodes**: ~50 node types implementing PlanNode hierarchy (`src/planner/nodes/`)
- **Scopes**: Symbol resolution system (`src/planner/scopes/`)
- **Context**: Planning session state (`src/planner/planning-context.ts`)
- **Resolution**: Schema/function/column resolution (`src/planner/resolve.ts`)
- **Types**: Type inference and compatibility (`src/planner/type-utils.ts`)

## Non-goals

- Optimizer transformations (see `3-review-core-optimizer.md`)
- Runtime execution (see `3-review-core-runtime.md`)
- Virtual table implementation (see `3-review-core-vtab.md`)

## Checklist

### Scope Resolution

- [ ] **Ambiguity rules**: Confirm resolution order across scopes (CTEs, FROM aliases, schema tables) and ensure ambiguity errors are actionable. Inspect `packages/quereus/src/planner/scopes/`.
- [ ] **CTE isolation**: Validate recursive and non-recursive CTE scoping rules, including shadowing behavior.
- [ ] **Parameter resolution**: Confirm semantics for named vs positional parameters and any mixing rules. Add tests for edge cases.
- [ ] **Qualification precedence**: Confirm schema-qualified vs unqualified resolution behavior and test it.

### Code Quality

- [ ] **DRY hotspots**: Identify duplicated scope/attribute patterns and decide whether to consolidate into shared utilities (only if it reduces bug risk).
- [ ] **Builder complexity**: Identify the largest builder functions (often SELECT planning) and propose a decomposition that improves testability without churning semantics.
- [ ] **Error handling consistency**: Ensure semantic/planning errors use consistent types/messages and include relevant context (SQL fragment, identifier, scope state).
- [ ] **Type safety**: Look for places where objects are “patched” or widened; prefer explicit interfaces/types to prevent latent bugs.

### Attribute ID Stability

- [ ] **Projection ID preservation**: Confirm column references preserve IDs through projections/aliases and across common rewrites.
- [ ] **Join mapping**: Confirm join output attributes maintain correct provenance (left/right) and IDs.
- [ ] **CTE reference consistency**: Confirm repeated CTE references reuse stable attribute IDs (or document why not).
- [ ] **Planner→optimizer contract**: Validate that optimizer entry points preserve planner-assigned IDs unless intentionally re-mapped.

### Memory Management

- [ ] **Cache lifecycle**: Identify planner caches (dependency trackers, CTE caches) and ensure they don’t retain references past a planning session.
- [ ] **Leak regression**: Add a stress/regression test that plans many queries in a loop and checks for unbounded growth (best-effort).

### Type Inference

- [ ] **Expression inference correctness**: Validate `packages/quereus/src/planner/type-utils.ts` covers all expression forms used by the parser (including aggregates/windows).
- [ ] **Aggregate/window return types**: Confirm return types match intended SQL semantics and document any intentional deviations.

### Complex Query Planning

- [ ] **Test nested subqueries**: Verify correlated references resolved correctly. Test: Subqueries with outer references plan correctly.
- [ ] **Test multiple CTEs**: Verify cross-referencing CTEs plan correctly. Test: CTE A references CTE B, both plan correctly.
- [ ] **Test window dependencies**: Verify ORDER BY dependencies in window functions. Test: Window ORDER BY references SELECT columns correctly.
- [ ] **Test mutating subqueries**: Verify mutating subqueries in FROM clause. Test: INSERT/UPDATE/DELETE in FROM handled correctly.

## Deliverables

1. **Findings captured**: Concrete list of semantic edge cases, missing tests, and contract ambiguities
2. **Focused fixes**: Small number of high-leverage fixes/refactors (only where they reduce correctness risk)
3. **Tests added**: Scope resolution, attribute ID stability, and at least one complex query planning regression
4. **Docs updated**: Update existing docs where planner behavior is surprising or under-specified

## Test Plan

### Unit Tests

- **Scope resolution**: Add tests under `packages/quereus/test/` covering ambiguous symbols, CTE shadowing, parameter resolution, schema qualification
- **Attribute stability**: Add tests under `packages/quereus/test/` covering ID preservation through transformations, join mapping, CTE consistency
- **Error handling**: Add tests under `packages/quereus/test/` for invalid references, ambiguous columns, type mismatches, constraint violations
- **Type inference**: Add tests under `packages/quereus/test/` covering expression/aggregate/window typing

### Integration Tests

- **Complex queries**: Extend `test/plan/` golden plan tests - Nested subqueries, multiple CTEs, window functions, mutating subqueries
- **Planner-optimizer**: Test attribute ID preservation across planner→optimizer boundary
- **Planner-runtime**: Test schema dependency invalidation triggers correctly

### Logic Tests

- Add/extend sqllogic coverage for planner-sensitive cases (scope resolution, CTE isolation, type inference edge cases, complex query planning).

## Acceptance Criteria

- All scope resolution edge cases tested and passing
- Attribute IDs stable across all transformations (verified with integration tests)
- No obvious memory leaks in planning context (best-effort stress/regression test)
- Type inference matches intended semantics for supported SQL features (with focused tests)
- All complex query forms plan correctly

## Notes/Links

- Related: `3-review-core-optimizer.md` (planner-optimizer integration)
- Related: `3-review-core-runtime.md` (planner-runtime integration)
- Planner docs: `docs/optimizer.md` (plan node implementation guide)